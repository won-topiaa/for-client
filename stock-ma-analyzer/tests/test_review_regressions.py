"""적대적 리뷰에서 확정된 결함들의 회귀 테스트."""
import numpy as np
import pandas as pd
import pytest

from app.analysis import EngineParams, MAStat, analyze_ma, select_recommended
from app.providers.toss import TossApiError, _parse_date, normalize_candles
from tests.test_analysis import make_df


# --- 1. 노이즈 3연속 종가가 break 로 오판되던 문제 (analysis.py) ---

def test_ma_hug_then_rally_is_not_break():
    """MA 를 밀착 추종(밴드 안 미세한 아래 마감 포함)하다 급등한 경우,
    성공한 지지가 break 로 집계되면 안 된다."""
    rng = np.random.default_rng(42)
    n = 260
    closes = np.empty(n)
    closes[:100] = np.linspace(80, 100, 100)          # 상승 (MA 위)
    # 100~180: MA20 근처 밀착 횡보 — 종가가 MA 를 사이에 두고 미세하게 진동
    level = 100.0
    for t in range(100, 180):
        closes[t] = level + rng.normal(0, 0.15)        # ±0.15 노이즈 (밴드 내부)
    closes[180:] = np.linspace(level, level * 1.18, n - 180)  # +18% 랠리
    df = make_df(closes)
    p = EngineParams(min_touches=1)
    stat = analyze_ma(df, 20, p, window_start=30, half_life=200.0)
    assert stat.touches >= 1
    assert stat.breaks == 0, (
        f"밀착 추종 노이즈가 break 로 오판됨: breaks={stat.breaks}"
    )
    assert stat.support_bounces >= 1


def test_decisive_break_still_detected():
    """수정 후에도 진짜 돌파(연속으로 밴드 바깥 마감)는 잡아야 한다."""
    n = 160
    closes = np.concatenate([
        np.linspace(90, 120, 80),      # 상승
        np.linspace(120, 113, 10),     # MA 접근
        np.linspace(112, 80, 70),      # 붕괴 (밴드 바깥 연속 마감)
    ])
    df = make_df(closes)
    p = EngineParams(min_touches=1)
    stat = analyze_ma(df, 20, p, window_start=25, half_life=100.0)
    assert stat.breaks >= 1


# --- 2. fallback 이 dedup 원칙을 깨던 문제 (analysis.py) ---

def _stat(period, score, touches=10, qualified=False):
    s = MAStat(period=period)
    s.score = score
    s.touches = touches
    s.support_bounces = touches // 2
    s.qualified = qualified
    return s


def test_fallback_respects_dedup():
    """자격자가 100 뿐이고 후보에 120(유사)과 20(상이)이 있으면
    fallback 은 20 을 골라야 한다."""
    stats = [
        _stat(100, 1.0, qualified=True),
        _stat(120, 0.9),           # 100 과 16.7% 차이 -> 유사
        _stat(20, 0.5),            # 상이
    ]
    picked = select_recommended(stats, EngineParams())
    assert [s.period for s in picked] == [100, 20]


def test_fallback_allows_similar_as_last_resort():
    """유사한 후보밖에 없으면 그래도 2개를 채운다."""
    stats = [_stat(100, 1.0, qualified=True), _stat(120, 0.9)]
    picked = select_recommended(stats, EngineParams())
    assert [s.period for s in picked] == [100, 120]


# --- 3. _parse_date 경계 (toss.py) ---

def test_parse_date_integer_yyyymmdd():
    assert _parse_date(20240103) == pd.Timestamp("2024-01-03")


def test_parse_date_epoch_ms_pre_2001():
    # 915148800000 ms = 1999-01-01 (예전엔 서기 30969년으로 왜곡됐음)
    assert _parse_date(915148800000) == pd.Timestamp("1999-01-01")


def test_parse_date_epoch_seconds_and_ms():
    assert _parse_date(1704240000) == pd.Timestamp("2024-01-03 00:00:00")
    assert _parse_date(1704240000000) == pd.Timestamp("2024-01-03 00:00:00")


def test_parse_date_garbage():
    assert _parse_date(123) is None
    assert _parse_date("not-a-date") is None
    assert _parse_date(3.14) is None


# --- 4. 페이지네이션: 공식 스펙(before/nextBefore, exclusive) 기준 (toss.py) ---

def _make_provider(pages):
    """_get 을 공식 스펙 형태의 가짜 응답으로 대체한 TossProvider.

    pages: [{"timestamp": ISO, ...}] 전체 캔들 풀. before(exclusive)보다
    이전 것만 최신순으로 count 개 반환, 커서는 nextBefore 로 제공.
    """
    from app.config import TossConfig
    from app.providers.toss import TossProvider

    provider = TossProvider(TossConfig(client_id="x", client_secret="y",
                                       max_count_per_request=3))
    calls = {"n": 0}

    async def fake_get(path, params):
        calls["n"] += 1
        before = params.get("before")
        rows = [r for r in pages if before is None or r["timestamp"] < before]
        rows = sorted(rows, key=lambda r: r["timestamp"], reverse=True)
        page = rows[: params["count"]]
        has_more = len(rows) > len(page)
        next_before = page[-1]["timestamp"] if page and has_more else None
        return {"result": {"candles": page, "nextBefore": next_before}}

    provider._get = fake_get
    return provider, calls


def _rows(dates):
    return [{
        "timestamp": f"{d}T09:00:00+09:00",
        "openPrice": "100", "highPrice": "110", "lowPrice": "95",
        "closePrice": "105", "volume": "1000", "currency": "KRW",
    } for d in dates]


def _run(coro):
    import asyncio
    return asyncio.new_event_loop().run_until_complete(coro)


def test_pagination_no_missing_days():
    """nextBefore 커서 페이지네이션에서 거래일이 누락되면 안 된다."""
    days = [f"2024-01-{d:02d}" for d in range(2, 12)]  # 10 거래일
    provider, _ = _make_provider(_rows(days))
    df = _run(provider.candles("TEST", "day", max_bars=10))
    got = df["date"].dt.strftime("%Y-%m-%d").tolist()
    assert got == days, f"누락 발생: {sorted(set(days) - set(got))}"


def test_pagination_stops_at_last_page():
    """nextBefore=null(마지막 페이지)에서 추가 요청 없이 종료해야 한다."""
    days = [f"2024-01-{d:02d}" for d in range(2, 7)]  # 5 거래일뿐
    provider, calls = _make_provider(_rows(days))
    df = _run(provider.candles("TEST", "day", max_bars=50))
    assert len(df) == 5
    assert calls["n"] == 2  # 3개 + 2개(nextBefore=null) — 세 번째 요청 없음


def test_pagination_first_page_empty_raises():
    provider, _ = _make_provider([])
    with pytest.raises(TossApiError):
        _run(provider.candles("TEST", "day", max_bars=10))


def test_week_interval_not_supported_raises():
    """공식 API 는 1d 까지만 -> week 요청은 즉시 TossApiError (리샘플링 폴백용)."""
    provider, calls = _make_provider(_rows(["2024-01-02"]))
    with pytest.raises(TossApiError):
        _run(provider.candles("TEST", "week", max_bars=10))
    assert calls["n"] == 0  # 네트워크 호출 없이 실패해야 함


# --- 6. 요청 한도(429) 재시도 + 일봉 1회 조회 (rate limit 회피) ---

def test_get_retries_on_429(monkeypatch):
    """429 응답이면 백오프 후 재시도, 성공하면 결과 반환."""
    import httpx
    from app.config import TossConfig
    from app.providers.toss import TossProvider

    provider = TossProvider(TossConfig(client_id="x", client_secret="y"))
    provider._token = "tok"
    provider._token_expiry = 1e18  # 토큰 재발급 안 하도록

    seq = [429, 429, 200]
    calls = {"n": 0}

    async def fake_request_get(path, params=None, headers=None):
        code = seq[calls["n"]]
        calls["n"] += 1
        return httpx.Response(
            code,
            json={"result": {"candles": [], "nextBefore": None}},
            headers={"Retry-After": "0"},
            request=httpx.Request("GET", "http://t" + path),
        )

    provider._client.get = fake_request_get
    # sleep 을 무력화해 테스트가 빠르게 끝나도록
    import app.providers.toss as toss_mod
    async def no_sleep(_): return None
    monkeypatch.setattr(toss_mod.asyncio, "sleep", no_sleep)

    out = _run(provider._get("/api/v1/candles", {}))
    assert calls["n"] == 3  # 429, 429, 200
    assert "result" in out


def test_analyze_fetches_daily_only_once():
    """일/주/월봉 분석이 일봉을 딱 한 번만 요청해야 한다 (rate limit 회피 핵심)."""
    import pandas as pd
    from app.config import Settings
    from app.service import analyze_symbol

    calls = {"day": 0, "other": 0}

    class OneShotProvider:
        name = "toss"

        async def candles(self, symbol, timeframe, max_bars):
            if timeframe == "day":
                calls["day"] += 1
            else:
                calls["other"] += 1
            n = 1600
            dates = pd.bdate_range("2016-01-01", periods=n)
            base = 60000 + pd.Series(range(n)) * 3
            return pd.DataFrame({
                "date": dates, "open": base, "high": base + 200,
                "low": base - 200, "close": base, "volume": 1000,
            })

        async def search(self, q):
            return []

    settings = Settings()
    result = _run(analyze_symbol(
        OneShotProvider(), settings, "005930",
        {"day": 3, "week": 7, "month": None},
    ))
    assert calls["day"] == 1, f"일봉을 {calls['day']}번 요청함 (1번이어야 함)"
    assert calls["other"] == 0, "주/월봉을 API 로 직접 요청하면 안 됨 (리샘플링해야 함)"
    # 세 타임프레임 모두 정상 분석됐는지
    for tf in ("day", "week", "month"):
        assert "error" not in result["timeframes"][tf], result["timeframes"][tf]


# --- 5. 공식 스펙 응답 형태 파싱 (toss.py) ---

def test_normalize_official_candle_payload():
    """실제 토스 응답 (result.candles, 문자열 숫자, +09:00 타임존)."""
    payload = {
        "result": {
            "candles": [
                {"timestamp": "2026-03-25T09:00:00+09:00", "openPrice": "71600",
                 "highPrice": "72300", "lowPrice": "71500", "closePrice": "72000",
                 "volume": "3521000", "currency": "KRW"},
                {"timestamp": "2026-03-24T09:00:00+09:00", "openPrice": "71000",
                 "highPrice": "71900", "lowPrice": "70800", "closePrice": "71600",
                 "volume": "2900000", "currency": "KRW"},
            ],
            "nextBefore": "2026-03-24T09:00:00+09:00",
        }
    }
    df = normalize_candles(payload)
    assert len(df) == 2
    assert df["date"].is_monotonic_increasing
    assert df["date"].dt.tz is None  # 타임존 제거됨 (naive)
    assert df["close"].iloc[-1] == 72000.0
    assert df["volume"].iloc[-1] == 3521000.0


def test_search_name_resolves_via_stocks_api():
    """이름 검색: 내장 사전으로 코드 찾기 -> /api/v1/stocks 로 확정."""
    from app.config import TossConfig
    from app.providers.toss import TossProvider

    provider = TossProvider(TossConfig(client_id="x", client_secret="y"))
    seen_params = {}

    async def fake_get(path, params):
        seen_params.update(params)
        assert path == "/api/v1/stocks"
        symbols = params["symbols"].split(",")
        return {"result": [
            {"symbol": s, "name": "삼성전자" if s == "005930" else s,
             "market": "KOSPI", "status": "ACTIVE"}
            for s in symbols
        ]}

    provider._get = fake_get
    results = _run(provider.search("삼성전자"))
    assert results and results[0].symbol == "005930"
    assert results[0].name == "삼성전자"

    results = _run(provider.search("aapl"))
    assert results[0].symbol == "AAPL"  # 티커는 대문자로 정규화


def test_config_migration_from_old_defaults():
    """예전 config.json (틀린 기본 경로)을 자동으로 새 스펙으로 이관."""
    import json, tempfile
    from pathlib import Path
    from app.config import load_settings

    old = {
        "provider": "auto",
        "toss": {
            "client_id": "id", "client_secret": "sec",
            "candles_path": "/api/v1/market/candles",
            "interval_values": {"day": "day", "week": "week", "month": "month"},
            "max_count_per_request": 300,
            "search_path": "/api/v1/market/symbols",
            "candles_to_param": "to",
            "to_date_format": "%Y-%m-%d",
        },
    }
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "config.json"
        p.write_text(json.dumps(old), encoding="utf-8")
        s = load_settings(p)
    assert s.toss.candles_path == "/api/v1/candles"
    assert s.toss.interval_values == {"day": "1d"}
    assert s.toss.max_count_per_request == 200
    assert s.toss.candles_before_param == "before"
    assert s.toss.client_id == "id"  # 사용자 값은 보존
