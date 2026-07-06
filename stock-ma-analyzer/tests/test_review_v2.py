"""2차 전수 리뷰에서 확정된 결함들의 회귀 테스트."""
import asyncio

import numpy as np
import pandas as pd
import pytest

from app.analysis import EngineParams, analyze_ma
from app.providers.toss import EmptyCandles, TossApiError, normalize_candles
from tests.test_analysis import make_df


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# --- 1. 저변동성 종목: 밴드 안 종가가 즉시 판정되던 문제 (analysis.py) ---

def test_low_volatility_no_instant_verdict_inside_band():
    """ATR 이 가격의 0.15% 미만이어도 밴드 안 종가로 판정하면 안 된다."""
    n = 200
    closes = np.full(n, 100000.0)
    closes[:100] = np.linspace(99000, 100000, 100)
    # ATR 을 아주 작게: 고저폭 0.05%
    highs = closes * 1.00025
    lows = closes * 0.99975
    # 100~110: 종가가 MA 바로 아래 (밴드 안, ATR 몇 배지만 밴드 폭 이내)
    closes[100:110] = closes[99] * 0.9990
    closes[110:] = np.linspace(closes[109], closes[109] * 1.03, n - 110)
    df = make_df(closes, highs=highs, lows=lows)
    p = EngineParams(min_touches=1)
    stat = analyze_ma(df, 20, p, window_start=30, half_life=100.0)
    # 밴드 안 미세한 아래 마감이 '즉시 break' 로 판정되던 버그:
    # 판정이 나더라도 밴드 밖 조건을 통과해야 한다. 여기선 3% 반등이 있으므로
    # break 가 성급하게 확정되지 않아야 한다.
    for e in stat.episodes:
        if e.outcome == "break":
            # break 판정 시점의 종가는 밴드 밖이어야 함
            j = e.decided_at
            close = df["close"].to_numpy(float)
            from app.analysis import atr as atr_fn, sma
            ma = sma(close, 20)[j]
            band = max(0.5 * atr_fn(df["high"].to_numpy(float),
                                    df["low"].to_numpy(float), close, 14)[j],
                       0.0015 * close[j])
            assert abs(close[j] - ma) > band * 0.99, "밴드 안 종가로 break 판정됨"


# --- 2. 룩백 경계에서 에피소드 절단 (analysis.py) ---

def test_episode_straddling_window_not_reclassified():
    """터치 군집이 window_start 에 걸쳐 있어도 방향/판정이 안정적이어야 한다."""
    from tests.test_analysis import planted_ma_series
    closes = planted_ma_series(anchor_window=20, n=600, seed=5)
    df = make_df(closes)
    p = EngineParams(min_touches=1)
    full = analyze_ma(df, 20, p, window_start=0, half_life=200.0)
    # 에피소드 중간을 window_start 로 삼아 절단 시나리오 생성
    target = next((e for e in full.episodes if e.end - e.start >= 2), None)
    if target is None:
        pytest.skip("절단 테스트용 에피소드 없음")
    ws = target.start + 1  # 군집 중간
    cut = analyze_ma(df, 20, p, window_start=ws, half_life=200.0)
    by_end = {e.end: (e.side, e.outcome) for e in full.episodes}
    for e in cut.episodes:
        if e.end in by_end:
            assert (e.side, e.outcome) == by_end[e.end], (
                f"창 경계 절단으로 판정 뒤집힘: {by_end[e.end]} -> {(e.side, e.outcome)}"
            )


# --- 3. 토큰 발급 동시성 (toss.py) ---

def test_token_single_flight():
    """콜드 스타트에서 동시 요청이 몰려도 토큰 발급은 1회만."""
    import httpx
    from app.config import TossConfig
    from app.providers.toss import TossProvider

    posts = {"n": 0}

    async def handler(request):
        if request.url.path == "/oauth2/token":
            posts["n"] += 1
            await asyncio.sleep(0.02)  # 발급 지연 시뮬레이션
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(200, json={"result": {"candles": [], "nextBefore": None}})

    provider = TossProvider(TossConfig(client_id="a", client_secret="b"))
    provider._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://t"
    )

    async def go():
        return await asyncio.gather(*[provider._ensure_token() for _ in range(10)])

    tokens = _run(go())
    assert posts["n"] == 1, f"토큰이 {posts['n']}번 발급됨 (1번이어야 함)"
    assert all(t == "t" for t in tokens)


# --- 4. 401 빠른 실패 / 429 마지막 sleep 제거 (toss.py) ---

def test_persistent_401_fails_fast():
    """계속 401 이면 토큰 재발급 1회 후 즉시 실패 (연타 금지)."""
    import httpx
    from app.config import TossConfig
    from app.providers.toss import TossProvider

    counts = {"get": 0, "post": 0}

    async def handler(request):
        if request.method == "POST":
            counts["post"] += 1
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        counts["get"] += 1
        return httpx.Response(401, json={"error": "unauthorized"})

    provider = TossProvider(TossConfig(client_id="a", client_secret="b"))
    provider._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://t"
    )
    with pytest.raises(TossApiError):
        _run(provider._get("/api/v1/candles", {}))
    assert counts["get"] == 2, f"GET {counts['get']}회 (2회여야: 최초 + 재발급 후 1회)"
    assert counts["post"] <= 2


def test_429_no_sleep_after_final_attempt(monkeypatch):
    """6번째 시도까지 429 면 마지막에 sleep 없이 즉시 에러."""
    import httpx
    import app.providers.toss as toss_mod
    from app.config import TossConfig
    from app.providers.toss import TossProvider

    sleeps = []

    async def fake_sleep(sec):
        sleeps.append(sec)

    monkeypatch.setattr(toss_mod.asyncio, "sleep", fake_sleep)

    async def handler(request):
        if request.method == "POST":
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(429, json={}, headers={"Retry-After": "5"})

    provider = TossProvider(TossConfig(client_id="a", client_secret="b"))
    provider._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://t"
    )
    with pytest.raises(TossApiError):
        _run(provider._get("/api/v1/candles", {}))
    # 마지막 시도(6번째) 후에는 sleep 하지 않음 -> 최대 5회 sleep
    assert len(sleeps) <= 5
    assert sum(sleeps) <= provider.MAX_RETRY_WAIT_SEC


# --- 5. 검색 폴백에서 직접 입력 코드 유지 (toss.py) ---

def test_search_fallback_keeps_typed_code():
    from app.config import TossConfig
    from app.providers.toss import TossProvider

    provider = TossProvider(TossConfig(client_id="a", client_secret="b"))

    async def failing_get(path, params):
        raise TossApiError("API 호출 실패 (429)")

    provider._get = failing_get
    results = _run(provider.search("AAPL"))
    assert results and results[0].symbol == "AAPL", "직접 입력한 티커가 사라짐"


# --- 6. 빈 캔들 응답 메시지 (toss.py) ---

def test_empty_candles_clear_message():
    with pytest.raises(EmptyCandles) as exc:
        normalize_candles({"result": {"candles": [], "nextBefore": None}})
    assert "종목코드" in str(exc.value)


# --- 7. 경로 탈출 차단 (sample.py / server.py) ---

def test_sample_provider_rejects_traversal(tmp_path):
    from app.providers.sample import SampleProvider

    p = SampleProvider(data_dir=tmp_path)
    with pytest.raises(ValueError):
        _run(p.candles("../../etc/passwd", "day", 100))
    with pytest.raises(ValueError):
        _run(p.candles("..%2F..%2Fsecret", "day", 100))


def test_analyze_endpoint_rejects_bad_symbol():
    from fastapi.testclient import TestClient
    import app.server as server_mod

    with TestClient(server_mod.app) as client:
        r = client.get("/api/analyze", params={"symbol": "../../etc/passwd"})
        assert r.status_code == 422  # FastAPI pattern 검증


# --- 8. 빈 검색 결과는 캐시하지 않음 (cache.py) ---

def test_cache_does_not_store_empty_search():
    from app.providers.cache import CachingProvider
    from app.providers.base import SymbolInfo

    class FlakyProvider:
        name = "toss"

        def __init__(self):
            self.calls = 0

        async def search(self, q):
            self.calls += 1
            return [] if self.calls == 1 else [SymbolInfo("AAPL", "Apple", "NASDAQ")]

        async def candles(self, *a):
            raise NotImplementedError

    inner = FlakyProvider()
    p = CachingProvider(inner)

    async def go():
        first = await p.search("AAPL")   # 실패 -> 빈 결과 (캐시 안 함)
        second = await p.search("AAPL")  # 재시도 -> 성공
        return first, second

    first, second = _run(go())
    assert first == [] and len(second) == 1
    assert inner.calls == 2