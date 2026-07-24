"""공급자 캐시 래퍼.

퍼블릭 배포 시 여러 사용자/반복 요청이 토스 요청 한도(429)를 소모하지 않도록
캔들과 검색 결과를 메모리에 잠시 보관한다. 같은 종목을 여러 번 분석하거나
여러 명이 같은 종목을 보면 실제 API 호출은 TTL 당 1회만 나간다.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

import pandas as pd

from .base import Provider, SymbolInfo


class NegativeCacheSkip(RuntimeError):
    """방금 실패한 종목이라 실제 조회 없이 건너뛴 경우 — 조기중단 판정에서
    '업스트림 조회 실패'와 구분하기 위한 별도 예외 (스캐너만 발생시킨다)."""

# 캔들 TTL 은 스캔 워치독(900초)보다 충분히 길어야 한다: 느린 스캔이 워치독에
# 끊겨 재시도할 때 이미 받아둔 종목을 다시 받지 않고 이어가게 (재페치 라이브락 방지).
# 일봉 분석이라 30분 신선도면 충분하다.
_CANDLE_TTL_SEC = 1800.0
_SEARCH_TTL_SEC = 3600.0  # 검색(이름->코드)은 자주 안 바뀜
_MAX_ENTRIES = 200        # 검색 캐시 상한
# 캔들 캐시 상한은 스캐너 유니버스(국내 300 + 미국 ~470)가 전부 들어가고도
# 남아야 한다 — 상한이 유니버스보다 작으면 순차 스캔이 자기 캐시를 계속
# 밀어내 히트율이 0% 가 된다.
_CANDLE_MAX_ENTRIES = 1000
# 개수만으로는 메모리가 안 묶인다: 스캔 페치는 종목당 1050봉(~50KB)이지만,
# /api/analyze 기본값은 전체 히스토리(수천~8500봉, ~400KB)를 캐시한다. 그래서
# '총 봉 수' 예산으로도 축출한다 — 300만 봉 ≈ 140MB 로 상한을 걸어, 512MB 무료
# 인스턴스가 전체-히스토리 항목으로 가득 차 OOM 되는 것을 막는다.
_CANDLE_MAX_BARS = 3_000_000

# 실패 네거티브 캐시 (스캐너 전용 — use_fail_cache=True 일 때만 동작).
# 방금 실패한 종목을 잠시 기억해, 수백 종목을 훑는 스캐너가 같은 hang(타임아웃
# 60초)을 반복 지불하지 않게 한다. 다음 스캔이 이들을 즉시 건너뛰므로 나머지
# 종목으로 완주하고(스캐너는 캐시 스킵을 조기중단 판정에서 제외한다), 록
# 대기자들도 같은 실패를 반복하지 않는다 (핫키 컨보이 해소).
# · 빠른 실패(429 등): 짧게만 기억 (일시 오류일 수 있음)
# · 느린 실패(타임아웃/행): 좀 더 길게 — 죽은 종목에 매번 60초를 낭비하지
#   않되, 업스트림 회복 후 너무 오래 목록에서 빠져 있지 않도록 10분으로 제한.
_FAIL_TTL_FAST_SEC = 120.0
_FAIL_TTL_SLOW_SEC = 600.0
# 이보다 오래 걸린 실패는 '행(hang)'으로 간주. candles 페치가 25초(_CANDLES_
# TIMEOUT_SEC)에 끊기므로, 그보다 낮게 잡아야 타임아웃/행이 '느린 실패'로 분류돼
# 더 긴 네거티브 캐시 TTL 을 받는다 (30초였을 때는 25초 타임아웃이 먼저 나
# 항상 '빠른 실패'로 잘못 분류됐다).
_SLOW_FAILURE_SEC = 20.0
_FAIL_MAX_ENTRIES = 2000


class _TTLCache:
    """TTL 캐시. 개수 상한(max_entries)에 더해, 선택적으로 '총 비용' 상한
    (max_cost, cost_fn)으로도 축출한다 — 항목 크기가 제각각(캔들 df)일 때
    메모리를 실제로 묶기 위함. cost_fn 이 없으면 항목당 비용 1(=개수 기반)."""

    def __init__(self, ttl: float, max_entries: int = _MAX_ENTRIES,
                 max_cost: float | None = None,
                 cost_fn: "Callable[[Any], float] | None" = None):
        self.ttl = ttl
        self.max_entries = max_entries
        self.max_cost = max_cost
        self._cost_fn = cost_fn
        self._data: dict[Any, tuple[float, Any, float]] = {}  # key -> (ts, value, cost)
        self._total_cost = 0.0

    def _remove(self, key: Any) -> None:
        item = self._data.pop(key, None)
        if item is not None:
            self._total_cost -= item[2]

    def get(self, key: Any) -> Any | None:
        item = self._data.get(key)
        if item is None:
            return None
        ts, value, _cost = item
        if time.monotonic() - ts > self.ttl:
            self._remove(key)
            return None
        return value

    def _over_limit(self, incoming_cost: float) -> bool:
        if len(self._data) >= self.max_entries:
            return True
        return (self.max_cost is not None
                and self._total_cost + incoming_cost > self.max_cost)

    def set(self, key: Any, value: Any) -> None:
        self._remove(key)  # 교체 시 이전 비용을 먼저 뺀다
        cost = float(self._cost_fn(value)) if self._cost_fn else 1.0
        now = time.monotonic()
        if self._over_limit(cost):
            # 1) 만료된 항목부터 정리 — 살아 있는 캐시를 쫓아내지 않는다
            for k in [k for k, (ts, _v, _c) in self._data.items() if now - ts > self.ttl]:
                self._remove(k)
        # 2) 그래도 넘치면 가장 오래된 것부터 (개수·비용 둘 다 예산 아래로)
        if self._over_limit(cost):
            for k, _ in sorted(self._data.items(), key=lambda kv: kv[1][0]):
                if not self._over_limit(cost):
                    break
                self._remove(k)
        self._data[key] = (now, value, cost)
        self._total_cost += cost


class CachingProvider:
    """Provider 를 감싸 캔들/검색을 TTL 캐시. 동시 중복 요청은 한 번만 나가게 잠금."""

    def __init__(self, inner: Provider):
        self.inner = inner
        self.name = inner.name
        # 캔들 항목 = (fetched, exhausted, df) → 비용은 df 의 봉 수. 총 봉 수로도 축출.
        self._candles = _TTLCache(_CANDLE_TTL_SEC, _CANDLE_MAX_ENTRIES,
                                  max_cost=_CANDLE_MAX_BARS,
                                  cost_fn=lambda v: len(v[2]))
        self._searches = _TTLCache(_SEARCH_TTL_SEC)
        self._locks: dict[Any, asyncio.Lock] = {}
        self._fails: dict[Any, tuple[float, str]] = {}  # key -> (만료시각, 사유)

    def _fail_hit(self, key: Any) -> str | None:
        item = self._fails.get(key)
        if item is None:
            return None
        expiry, msg = item
        if time.monotonic() >= expiry:
            self._fails.pop(key, None)
            return None
        return msg

    def _record_fail(self, key: Any, elapsed: float, exc: Exception) -> None:
        if len(self._fails) >= _FAIL_MAX_ENTRIES:
            now = time.monotonic()
            for k in [k for k, (exp, _) in self._fails.items() if exp <= now]:
                self._fails.pop(k, None)
            while len(self._fails) >= _FAIL_MAX_ENTRIES:
                self._fails.pop(next(iter(self._fails)))
        ttl = (_FAIL_TTL_SLOW_SEC if elapsed >= _SLOW_FAILURE_SEC
               else _FAIL_TTL_FAST_SEC)
        self._fails[key] = (time.monotonic() + ttl,
                            str(exc) or exc.__class__.__name__)

    def _lock_for(self, key: Any) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
            if len(self._locks) > _CANDLE_MAX_ENTRIES * 2:
                # 잠금 딕셔너리도 무한히 크지 않게. 대기자(waiter)가 있는 잠금은
                # 해제 직후의 짧은 순간 locked() 가 False 라 잘못 축출될 수 있어
                # 함께 건너뛴다 (같은 키에 새 잠금이 생기면 중복 요청 발생).
                for k in list(self._locks.keys())[:_CANDLE_MAX_ENTRIES]:
                    lk = self._locks[k]
                    if not lk.locked() and not getattr(lk, "_waiters", None):
                        self._locks.pop(k, None)
        return lock

    @staticmethod
    def _candle_hit(cached: tuple | None, max_bars: int) -> pd.DataFrame | None:
        """캐시 항목이 이번 요청을 감당할 수 있으면 잘라서 반환.

        cached = (요청했던 봉 수, 히스토리 소진 여부, df).
        요청량이 캐시된 요청량 이하이거나, 히스토리가 이미 끝까지 받아진
        상태라면 (더 요청해도 없음) 캐시로 응답한다.
        """
        if cached is None:
            return None
        fetched, exhausted, df = cached
        if fetched >= max_bars or exhausted:
            return df.tail(max_bars).reset_index(drop=True)  # pandas3 CoW: 별도 copy 불필요 (쓰기 시 자동 분리)
        return None

    async def candles(self, symbol: str, timeframe: str, max_bars: int,
                      use_fail_cache: bool = False) -> pd.DataFrame:
        """캔들 조회 (TTL 캐시).

        use_fail_cache: 스캐너 전용 실패 네거티브 캐시 사용 여부.
          True  — 방금 실패한 종목이면 NegativeCacheSkip 을 즉시 던지고, 실패
                  시 기록한다. 수백 종목을 훑는 스캐너가 같은 hang 을 반복
                  지불하지 않게 한다.
          False — 사용자 요청 경로(/api/analyze·/api/indices). 단발 요청은
                  업스트림을 때리지 않으므로 네거티브 캐시를 읽지도 쓰지도
                  않는다 — 사용자가 명시적으로 요청한 종목은 항상 실제 조회.
        """
        key = ("candles", symbol, timeframe)
        # 살아있는 캐시가 이번 요청을 감당하면 실패 기록보다 먼저 응답한다
        # (이미 받아둔 데이터가 있으면 굳이 건너뛰지 않는다)
        hit = self._candle_hit(self._candles.get(key), max_bars)
        if hit is not None:
            return hit
        if use_fail_cache:
            fail = self._fail_hit(key)
            if fail is not None:
                raise NegativeCacheSkip(f"{symbol}: 최근 실패로 잠시 건너뜀 ({fail})")
        async with self._lock_for(key):
            hit = self._candle_hit(self._candles.get(key), max_bars)
            if hit is not None:
                return hit
            if use_fail_cache:
                # 록 대기 중 다른 요청이 실패를 기록했을 수 있다 — 여기서 확인해야
                # 대기자들이 같은 실패(각 60초)를 줄줄이 반복하지 않는다
                fail = self._fail_hit(key)
                if fail is not None:
                    raise NegativeCacheSkip(f"{symbol}: 최근 실패로 잠시 건너뜀 ({fail})")
            started = time.monotonic()
            try:
                df = await self.inner.candles(symbol, timeframe, max_bars)
            except asyncio.CancelledError:
                raise  # 취소는 실패가 아니다 (워치독/종료)
            except Exception as exc:
                if use_fail_cache:
                    self._record_fail(key, time.monotonic() - started, exc)
                raise
            self._fails.pop(key, None)
            # 받은 수가 요청보다 적으면 히스토리가 끝난 것 -> 더 큰 요청도 캐시로 응답.
            # 단, 공급자가 '잘렸다'고 표시한 데이터는 소진이 아니다:
            #  · truncated    = 시간 예산 초과 등 — 받은 양만 신뢰, 같은 요청도 재시도
            #  · window_bound = 조회 창이 자름 — 같은/작은 요청은 같은 결과이므로
            #                   캐시로 응답하고, 더 큰 요청만 재조회
            truncated = bool(df.attrs.get("truncated", False))
            window_bound = bool(df.attrs.get("window_bound", False))
            exhausted = len(df) < max_bars and not truncated and not window_bound
            fetched = len(df) if truncated else max_bars
            self._candles.set(key, (fetched, exhausted, df))
            return df.tail(max_bars).reset_index(drop=True)  # pandas3 CoW: 별도 copy 불필요 (쓰기 시 자동 분리)

    async def search(self, query: str) -> list[SymbolInfo]:
        key = ("search", query.strip().lower())
        cached = self._searches.get(key)
        if cached is not None:
            return cached
        async with self._lock_for(key):
            cached = self._searches.get(key)
            if cached is not None:
                return cached
            results = await self.inner.search(query)
            # 빈 결과는 캐시하지 않는다 — 일시적 API 실패(429 등)로 빈 목록이
            # 반환된 경우 1시간 동안 그 검색어가 오염되는 것을 방지
            if results:
                self._searches.set(key, results)
            return results

    async def aclose(self) -> None:
        if hasattr(self.inner, "aclose"):
            await self.inner.aclose()
