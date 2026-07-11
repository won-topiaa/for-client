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

_CANDLE_TTL_SEC = 600.0   # 10분 — 봉 데이터는 장중에도 이 정도면 충분
_SEARCH_TTL_SEC = 3600.0  # 검색(이름->코드)은 자주 안 바뀜
_MAX_ENTRIES = 200        # 메모리 보호용 상한


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
            # 가장 오래된 것부터 정리
            oldest = sorted(self._data.items(), key=lambda kv: kv[1][0])
            for k, _ in oldest[: max(1, self.max_entries // 4)]:
                self._data.pop(k, None)
        self._data[key] = (time.monotonic(), value)


class CachingProvider:
    """Provider 를 감싸 캔들/검색을 TTL 캐시. 동시 중복 요청은 한 번만 나가게 잠금."""

    def __init__(self, inner: Provider):
        self.inner = inner
        self.name = inner.name
        self._candles = _TTLCache(_CANDLE_TTL_SEC)
        self._searches = _TTLCache(_SEARCH_TTL_SEC)
        self._locks: dict[Any, asyncio.Lock] = {}

    def _lock_for(self, key: Any) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
            if len(self._locks) > _MAX_ENTRIES * 2:
                # 잠금 딕셔너리도 무한히 크지 않게 (사용 중이 아닌 것만 정리)
                for k in list(self._locks.keys())[: _MAX_ENTRIES]:
                    if not self._locks[k].locked():
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
            # 단, 공급자가 '잘렸다'고 표시한 데이터(시간 예산 초과 등)는 소진이
            # 아니므로, 실제 받은 양만 기록해 그보다 큰 요청은 재시도되게 한다.
            truncated = bool(df.attrs.get("truncated", False))
            exhausted = len(df) < max_bars and not truncated
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
