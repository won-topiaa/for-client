"""배포 관련 기능 테스트: 캐시 래퍼, 접속 비밀번호."""
import asyncio
import base64

import pandas as pd
import pytest

from app.providers.base import SymbolInfo
from app.providers.cache import CachingProvider


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class CountingProvider:
    name = "toss"

    def __init__(self, total_bars=1000):
        self.candle_calls = 0
        self.search_calls = 0
        self.total_bars = total_bars

    async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
        self.candle_calls += 1
        n = min(max_bars, self.total_bars)
        dates = pd.bdate_range("2020-01-01", periods=n)
        return pd.DataFrame({
            "date": dates, "open": 1.0, "high": 2.0,
            "low": 0.5, "close": 1.5, "volume": 10,
        })

    async def search(self, query):
        self.search_calls += 1
        return [SymbolInfo("005930", "삼성전자", "KOSPI")]


def test_cache_repeated_candles_one_call():
    inner = CountingProvider()
    p = CachingProvider(inner)

    async def go():
        a = await p.candles("005930", "day", 500)
        b = await p.candles("005930", "day", 500)
        c = await p.candles("005930", "day", 300)  # 더 적게 요청 -> 캐시 절단
        return a, b, c

    a, b, c = _run(go())
    assert inner.candle_calls == 1
    assert len(a) == len(b) == 500 and len(c) == 300


def test_cache_larger_request_refetches():
    inner = CountingProvider(total_bars=5000)
    p = CachingProvider(inner)

    async def go():
        await p.candles("005930", "day", 300)
        await p.candles("005930", "day", 800)  # 캐시보다 크게 -> 재요청

    _run(go())
    assert inner.candle_calls == 2


def test_cache_exhausted_history_serves_bigger_requests():
    inner = CountingProvider(total_bars=400)  # 400봉이 전부인 종목
    p = CachingProvider(inner)

    async def go():
        await p.candles("005930", "day", 1000)  # 400개만 옴 (소진)
        await p.candles("005930", "day", 100000)  # 전체 기간 요청 -> 캐시로 응답

    _run(go())
    assert inner.candle_calls == 1


def test_cache_truncated_data_not_treated_as_exhausted():
    """시간 예산 초과로 잘린 데이터(truncated)는 '히스토리 소진'이 아니므로
    더 큰 요청이 오면 재요청해야 한다."""

    class TruncatingProvider(CountingProvider):
        async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
            df = await super().candles(symbol, timeframe, max_bars)
            if self.candle_calls == 1:
                df = df.head(400)          # 첫 호출: 잘린 부분 응답
                df.attrs["truncated"] = True
            return df

    inner = TruncatingProvider(total_bars=5000)
    p = CachingProvider(inner)

    async def go():
        a = await p.candles("005930", "day", 5000)   # 잘림 (400개)
        b = await p.candles("005930", "day", 5000)   # 재요청되어야 함
        return a, b

    a, b = _run(go())
    assert inner.candle_calls == 2, "잘린 데이터가 소진으로 캐시돼 재요청 안 됨"
    assert len(b) == 5000


def test_cache_concurrent_requests_single_flight():
    inner = CountingProvider()
    p = CachingProvider(inner)

    async def go():
        return await asyncio.gather(*[
            p.candles("005930", "day", 500) for _ in range(8)
        ])

    results = _run(go())
    assert inner.candle_calls == 1  # 동시에 8개 요청해도 실제 호출 1번
    assert all(len(df) == 500 for df in results)


def test_cache_search():
    inner = CountingProvider()
    p = CachingProvider(inner)

    async def go():
        await p.search("삼성")
        await p.search("삼성")
        await p.search("  삼성 ")  # 공백/대소문자 정규화 후 같은 키

    _run(go())
    assert inner.search_calls == 1


def test_site_password(monkeypatch):
    """SITE_PASSWORD 설정 시: 비번 없으면 401, 맞으면 200, /api/health 는 예외."""
    from fastapi.testclient import TestClient
    import app.server as server_mod

    monkeypatch.setattr(server_mod, "SITE_PASSWORD", "test1234")
    with TestClient(server_mod.app) as client:
        r = client.get("/")
        assert r.status_code == 401
        assert "WWW-Authenticate" in r.headers

        r = client.get("/api/health")  # 헬스체크는 통과해야 함
        assert r.status_code == 200

        token = base64.b64encode("user:test1234".encode()).decode()
        r = client.get("/", headers={"Authorization": f"Basic {token}"})
        assert r.status_code == 200

        bad = base64.b64encode("user:wrong".encode()).decode()
        r = client.get("/", headers={"Authorization": f"Basic {bad}"})
        assert r.status_code == 401


def test_no_password_means_open(monkeypatch):
    from fastapi.testclient import TestClient
    import app.server as server_mod

    monkeypatch.setattr(server_mod, "SITE_PASSWORD", "")
    with TestClient(server_mod.app) as client:
        assert client.get("/").status_code == 200
