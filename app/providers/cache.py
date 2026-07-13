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

# 캔들 TTL 은 스캔 워치독(900초)보다 충분히 길어야 한다: 느린 스캔이 워치독에
# 끊겨 재시도할 때 이미 받아둔 종목을 다시 받지 않고 이어가게 (재페치 라이브락 방지).
# 일봉 분석이라 30분 신선도면 충분하다.
_CANDLE_TTL_SEC = 1800.0
_SEARCH_TTL_SEC = 3600.0  # 검색(이름->코드)은 자주 안 바뀜
_MAX_ENTRIES = 200        # 검색 캐시 상한
# 캔들 캐시 상한은 스캐너 유니버스(국내 300 + 미국 ~470)가 전부 들어가고도
# 남아야 한다 — 상한이 유니버스보다 작으면 순차 스캔이 자기 캐시를 계속
# 밀어내 히트율이 0% 가 된다 (약 60~80MB, 무료 인스턴스에서 감당 가능).
_CANDLE_MAX_ENTRIES = 1000


class _TTLCache:
    def __init__(self, ttl: float, max_entries: int = _MAX_ENTRIES):
        self.ttl = ttl
        self.max_entries = max_entries
        self._data: dict[Any, tuple[float, Any]] = {}

    def get(self, key: Any) -> Any | None:
        item = self._data.get(key)
        if item is None:
            return None
        ts, value = item
        if time.monotonic() - ts > self.ttl:
            self._data.pop(key, None)
            return None
        return value

    def set(self, key: Any, value: Any) -> None:
        if len(self._data) >= self.max_entries:
            # 1) 만료된 항목부터 정리 — 살아 있는 캐시를 쫓아내지 않는다
            now = time.monotonic()
            expired = [k for k, (ts, _) in self._data.items() if now - ts > self.ttl]
            for k in expired:
                self._data.pop(k, None)
        if len(self._data) >= self.max_entries:
            # 2) 그래도 넘치면 가장 오래된 것부터
            oldest = sorted(self._data.items(), key=lambda kv: kv[1][0])
            for k, _ in oldest[: max(1, self.max_entries // 4)]:
                self._data.pop(k, None)
        self._data[key] = (time.monotonic(), value)


class CachingProvider:
    """Provider 를 감싸 캔들/검색을 TTL 캐시. 동시 중복 요청은 한 번만 나가게 잠금."""

    def __init__(self, inner: Provider):
        self.inner = inner
        self.name = inner.name
        self._candles = _TTLCache(_CANDLE_TTL_SEC, _CANDLE_MAX_ENTRIES)
        self._searches = _TTLCache(_SEARCH_TTL_SEC)
        self._locks: dict[Any, asyncio.Lock] = {}

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
            return df.tail(max_bars).reset_index(drop=True).copy()
        return None

    async def candles(self, symbol: str, timeframe: str, max_bars: int) -> pd.DataFrame:
        key = ("candles", symbol, timeframe)
        hit = self._candle_hit(self._candles.get(key), max_bars)
        if hit is not None:
            return hit
        async with self._lock_for(key):
            hit = self._candle_hit(self._candles.get(key), max_bars)
            if hit is not None:
                return hit
            df = await self.inner.candles(symbol, timeframe, max_bars)
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
            return df.tail(max_bars).reset_index(drop=True).copy()

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
