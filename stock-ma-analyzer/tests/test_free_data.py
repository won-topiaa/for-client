"""무료 시세 공급자(FinanceDataReader/Yahoo) 테스트 — 네트워크 없이 모킹."""
import asyncio

import numpy as np
import pandas as pd
import pytest

from app.providers.free_data import (
    FreeDataProvider,
    normalize_listing,
    normalize_ohlcv,
)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_normalize_ohlcv_fdr_style():
    """FDR DataReader 형식: Date 인덱스 + Open/High/Low/Close/Volume/Change."""
    idx = pd.date_range("2024-01-01", periods=3, freq="D", name="Date")
    raw = pd.DataFrame({
        "Open": [100, 102, 104], "High": [110, 112, 114],
        "Low": [95, 97, 99], "Close": [105, 108, 110],
        "Volume": [1000, 900, 1100], "Change": [0.01, 0.02, 0.01],
    }, index=idx)
    df = normalize_ohlcv(raw)
    assert list(df.columns) == ["date", "open", "high", "low", "close", "volume"]
    assert len(df) == 3
    assert df["close"].iloc[-1] == 110.0
    assert df["date"].is_monotonic_increasing


def test_normalize_ohlcv_yahoo_style_tz_and_adjclose():
    """Yahoo 형식: tz-aware 인덱스 + 'Adj Close' 포함."""
    idx = pd.DatetimeIndex(
        ["2024-01-02", "2024-01-03"], tz="America/New_York", name="Date"
    )
    raw = pd.DataFrame({
        "Open": [100.0, 101.0], "High": [110.0, 111.0], "Low": [95.0, 96.0],
        "Close": [105.0, 106.0], "Adj Close": [104.0, 105.0], "Volume": [10, 20],
    }, index=idx)
    df = normalize_ohlcv(raw)
    assert len(df) == 2
    assert df["date"].dt.tz is None  # tz 제거됨
    # 'close' 우선 (Adj Close 아님)
    assert df["close"].iloc[0] == 105.0


def test_normalize_ohlcv_empty_raises():
    with pytest.raises(ValueError):
        normalize_ohlcv(pd.DataFrame())


def test_normalize_listing_krx():
    raw = pd.DataFrame({
        "Code": ["005930", "35720", "068270"],
        "Name": ["삼성전자", "카카오", "셀트리온"],
        "Market": ["KOSPI", "KOSPI", "KOSPI"],
    })
    listing = normalize_listing(raw)
    assert set(listing.columns) == {"symbol", "name", "market"}
    # zfill 로 6자리 보정
    assert "035720" in set(listing["symbol"])
    assert len(listing) == 3


def test_normalize_listing_drops_non_numeric():
    raw = pd.DataFrame({
        "Code": ["005930", "ABC", ""],
        "Name": ["삼성전자", "이상한거", "빈거"],
    })
    listing = normalize_listing(raw)
    assert list(listing["symbol"]) == ["005930"]


def test_normalize_listing_keeps_new_style_krx_codes():
    """2024.1 개편 이후 영문 포함 코드(우선주/신규상장)가 탈락하면 안 된다."""
    raw = pd.DataFrame({
        "Code": ["005930", "00088K", "0126Z0", "02826K", "BAD!"],
        "Name": ["삼성전자", "한화3우B", "삼성에피스홀딩스", "삼성물산우B", "잘못된거"],
    })
    listing = normalize_listing(raw)
    got = set(listing["symbol"])
    assert {"005930", "00088K", "0126Z0", "02826K"} <= got
    assert "BAD!" not in got


def test_candles_rejects_non_day_timeframe():
    """일봉 전용 — week/month 를 조용히 일봉으로 돌려주면 안 된다."""
    p = FreeDataProvider()
    with pytest.raises(ValueError):
        _run(p.candles("005930", "week", 10))


def test_listing_failure_backoff(monkeypatch):
    """상장목록 다운로드 실패 시 60초간 재시도하지 않는다 (실패 폭주 방지)."""
    import app.providers.free_data as mod

    calls = {"n": 0}

    def boom():
        calls["n"] += 1
        raise RuntimeError("network down")

    monkeypatch.setattr(mod, "_load_listing_sync", boom)
    p = FreeDataProvider()

    async def go():
        await p.search("삼성")   # 1차: 다운로드 시도 -> 실패
        await p.search("삼성")   # 2차: 백오프 -> 재시도 안 함
        return await p.search("AAPL")  # 직접 입력은 목록 없이도 동작

    results = _run(go())
    assert calls["n"] == 1, f"실패 후에도 {calls['n']}번 재시도함"
    assert results and results[0].symbol == "AAPL"


def test_empty_listing_not_cached_as_fresh(monkeypatch):
    """컬럼은 있으나 행이 0개인 상장목록 응답을 12시간 '정상'으로 캐시하지 않는다.

    스크레이프 드리프트 등으로 빈 목록이 와도 검색·유니버스가 12시간 비지
    않도록, 실패로 취급해 짧은 백오프 뒤 재시도하게 한다.
    """
    import app.providers.free_data as mod

    def empty_listing():
        return pd.DataFrame({"Code": [], "Name": [], "Market": []})

    monkeypatch.setattr(mod, "_load_listing_sync", empty_listing)
    p = FreeDataProvider()

    result = _run(p._get_listing())
    assert result is None or result.empty     # 빈 목록을 유효값으로 내주지 않음
    assert not p._listing_fresh()             # 12시간 캐시로 굳지 않음
    assert p._listing_fail_ts > 0             # 실패로 기록돼 백오프 활성화


def _provider_with_listing():
    import time
    p = FreeDataProvider()
    p._listing = normalize_listing(pd.DataFrame({
        "Code": ["005930", "000660", "035420"],
        "Name": ["삼성전자", "SK하이닉스", "NAVER"],
        "Market": ["KOSPI", "KOSPI", "KOSPI"],
    }))
    p._listing_ts = time.monotonic()  # 캐시 유효
    p._market_by_symbol = dict(zip(p._listing["symbol"], p._listing["market"]))
    return p


def test_search_by_name():
    p = _provider_with_listing()
    results = _run(p.search("하이닉스"))
    assert any(r.symbol == "000660" and "하이닉스" in r.name for r in results)


def test_search_by_code():
    p = _provider_with_listing()
    results = _run(p.search("005930"))
    assert results[0].symbol == "005930"


def test_search_keeps_typed_us_ticker_not_in_listing():
    p = _provider_with_listing()
    results = _run(p.search("AAPL"))
    assert results and results[0].symbol == "AAPL"


def test_candles_tails_and_uses_fetch(monkeypatch):
    from app.providers.base import validate_candles
    p = FreeDataProvider()
    n = 500
    dates = pd.bdate_range("2020-01-01", periods=n)
    synthetic = validate_candles(pd.DataFrame({
        "date": dates, "open": 1.0, "high": 2.0, "low": 0.5,
        "close": 1.5, "volume": 10,
    }))

    calls = {"n": 0}

    def fake_fetch(symbol, max_bars=None):
        calls["n"] += 1
        return synthetic

    monkeypatch.setattr(p, "_fetch_daily_sync", fake_fetch)
    df = _run(p.candles("005930", "day", 200))
    assert calls["n"] == 1
    assert len(df) == 200
    assert df["date"].iloc[-1] == synthetic["date"].iloc[-1]


def test_fetch_daily_falls_back_to_yahoo(monkeypatch):
    """FDR 실패 시 Yahoo 로 폴백."""
    import app.providers.free_data as mod
    from app.providers.base import validate_candles

    dates = pd.date_range("2024-01-01", periods=3, name="Date")
    yahoo_df = pd.DataFrame({
        "Open": [1, 2, 3], "High": [2, 3, 4], "Low": [0.5, 1, 1.5],
        "Close": [1.5, 2.5, 3.5], "Volume": [10, 20, 30],
    }, index=dates)

    def boom(symbol, start="1990-01-01"):
        raise RuntimeError("FDR down")

    def fake_yahoo(symbol, market="", period="max"):
        return yahoo_df

    monkeypatch.setattr(mod, "_fetch_fdr_sync", boom)
    monkeypatch.setattr(mod, "_fetch_yahoo_sync", fake_yahoo)
    p = FreeDataProvider()
    df = p._fetch_daily_sync("005930")
    assert len(df) == 3
    assert df["close"].iloc[-1] == 3.5


def test_fetch_daily_both_fail_raises(monkeypatch):
    import app.providers.free_data as mod

    def boom(*a, **k):
        raise RuntimeError("down")

    monkeypatch.setattr(mod, "_fetch_fdr_sync", boom)
    monkeypatch.setattr(mod, "_fetch_yahoo_sync", boom)
    p = FreeDataProvider()
    with pytest.raises(RuntimeError):
        p._fetch_daily_sync("005930")


def test_us_symbol_prefers_stooq(monkeypatch):
    """미국 티커는 Stooq 를 먼저 쓴다 — 야후(yfinance/FDR)는 쿠키 없는 요청이
    데이터센터 IP(Render 등)에서 429·행에 걸려 미국 스캔 전체를 느리게 만든다.
    Stooq(무키·데이터센터 친화적)가 성공하면 야후·FDR 은 아예 부르지 않는다."""
    import app.providers.free_data as mod

    stooq_df = pd.DataFrame({
        "Date": ["2024-01-02", "2024-01-03", "2024-01-04"], "Open": [1., 2., 3.],
        "High": [2., 3., 4.], "Low": [.5, 1., 1.5], "Close": [1.5, 2.5, 3.5],
        "Volume": [10, 20, 30]})
    called = {"yahoo": 0, "fdr": 0}

    def spy_yahoo(*a, **k):
        called["yahoo"] += 1
        raise RuntimeError("down")

    def spy_fdr(*a, **k):
        called["fdr"] += 1
        raise RuntimeError("down")

    monkeypatch.setattr(mod, "_fetch_stooq_sync", lambda s, start: stooq_df)
    monkeypatch.setattr(mod, "_fetch_yahoo_sync", spy_yahoo)
    monkeypatch.setattr(mod, "_fetch_fdr_sync", spy_fdr)
    p = FreeDataProvider()
    df = p._fetch_daily_sync("UBER", 300)
    assert len(df) == 3 and df["close"].iloc[-1] == 3.5
    assert called["yahoo"] == 0 and called["fdr"] == 0, "Stooq 성공인데 야후/FDR 이 불림"


def test_us_falls_back_to_yahoo_when_stooq_fails(monkeypatch):
    """Stooq 가 실패하면 미국 티커는 yfinance 로 폴백한다."""
    import app.providers.free_data as mod

    dates = pd.date_range("2024-01-01", periods=3, name="Date")
    yahoo_df = pd.DataFrame({
        "Open": [1, 2, 3], "High": [2, 3, 4], "Low": [0.5, 1, 1.5],
        "Close": [1.5, 2.5, 3.5], "Volume": [10, 20, 30],
    }, index=dates)
    monkeypatch.setattr(mod, "_fetch_stooq_sync",
                        lambda s, start: (_ for _ in ()).throw(RuntimeError("stooq down")))
    monkeypatch.setattr(mod, "_fetch_yahoo_sync", lambda s, m="", p="max": yahoo_df)
    monkeypatch.setattr(mod, "_YAHOO_MIN_INTERVAL_SEC", 0.0)
    p = FreeDataProvider()
    df = p._fetch_daily_sync("UBER", 300)
    assert len(df) == 3 and df["close"].iloc[-1] == 3.5


def test_kr_symbol_still_prefers_fdr(monkeypatch):
    """국내 코드는 기존대로 FDR(네이버 소스) 우선 — 야후 제한과 무관한 경로."""
    import app.providers.free_data as mod

    dates = pd.date_range("2024-01-01", periods=3, name="Date")
    fdr_df = pd.DataFrame({
        "Open": [1, 2, 3], "High": [2, 3, 4], "Low": [0.5, 1, 1.5],
        "Close": [1.5, 2.5, 3.5], "Volume": [10, 20, 30],
    }, index=dates)
    called = {"yahoo": 0}

    def spy_yahoo(*a, **k):
        called["yahoo"] += 1
        raise RuntimeError("down")

    monkeypatch.setattr(mod, "_fetch_fdr_sync", lambda s, start="1990-01-01": fdr_df)
    monkeypatch.setattr(mod, "_fetch_yahoo_sync", spy_yahoo)
    p = FreeDataProvider()
    df = p._fetch_daily_sync("005930", 300)
    assert len(df) == 3
    assert called["yahoo"] == 0, "국내 코드에서 yfinance 가 FDR 보다 먼저 불림"


def test_us_uses_stooq_data(monkeypatch):
    """미국 티커는 Stooq CSV 를 정규화해 그대로 쓴다 (야후 없이도 동작)."""
    import app.providers.free_data as mod

    def boom(*a, **k):
        raise RuntimeError("down")

    stooq_df = pd.DataFrame({
        "Date": ["2024-01-02", "2024-01-03"], "Open": [1.0, 2.0],
        "High": [2.0, 3.0], "Low": [0.5, 1.0], "Close": [1.5, 2.5],
        "Volume": [10, 20],
    })
    monkeypatch.setattr(mod, "_fetch_fdr_sync", boom)
    monkeypatch.setattr(mod, "_fetch_yahoo_sync", boom)
    monkeypatch.setattr(mod, "_fetch_stooq_sync", lambda s, start: stooq_df)
    monkeypatch.setattr(mod, "_YAHOO_MIN_INTERVAL_SEC", 0.0)
    p = FreeDataProvider()
    df = p._fetch_daily_sync("UBER", 300)
    assert len(df) == 2
    assert df["close"].iloc[-1] == 2.5


def test_stooq_skipped_for_indices_and_kr(monkeypatch):
    """Stooq 폴백은 미국 일반 티커 전용 — 지수 표기·국내 코드에는 안 쓴다."""
    import app.providers.free_data as mod

    def boom(*a, **k):
        raise RuntimeError("down")

    counts = {"stooq": 0}

    def spy_stooq(s, start):
        counts["stooq"] += 1
        raise RuntimeError("x")

    monkeypatch.setattr(mod, "_fetch_fdr_sync", boom)
    monkeypatch.setattr(mod, "_fetch_yahoo_sync", boom)
    monkeypatch.setattr(mod, "_fetch_stooq_sync", spy_stooq)
    monkeypatch.setattr(mod, "_YAHOO_MIN_INTERVAL_SEC", 0.0)
    p = FreeDataProvider()
    for sym in ("US500", "IXIC", "DJI", "005930"):
        with pytest.raises(RuntimeError):
            p._fetch_daily_sync(sym, 300)
    assert counts["stooq"] == 0


def test_yahoo_pace_enforces_min_interval(monkeypatch):
    """야후행 요청은 전역 최소 간격을 지킨다 (429 IP 잠금 예방)."""
    import time as _t

    import app.providers.free_data as mod

    monkeypatch.setattr(mod, "_YAHOO_MIN_INTERVAL_SEC", 0.05)
    monkeypatch.setattr(mod, "_yahoo_next_ts", 0.0)
    t0 = _t.perf_counter()
    mod._yahoo_pace()
    mod._yahoo_pace()
    mod._yahoo_pace()
    assert _t.perf_counter() - t0 >= 0.08, "간격 강제가 동작하지 않음"


def test_validate_candles_drops_nonpositive_prices():
    """0/음수 가격 봉은 소스 이상값 — 거르지 않으면 수익률·ATR·분모에 NaN/
    발산이 섞여 패턴 점수로 샌다 (거래량 0 은 정상이라 유지)."""
    from app.providers.base import validate_candles

    raw = pd.DataFrame({
        "date": pd.bdate_range("2024-01-01", periods=5),
        "open": [10.0, 0.0, 11.0, -3.0, 12.0],
        "high": [11.0, 1.0, 12.0, 1.0, 13.0],
        "low": [9.0, 0.5, 10.0, 0.5, 11.0],
        "close": [10.5, 0.8, 11.5, 0.9, 12.5],
        "volume": [100, 0, 200, 300, 0],  # 0 거래량은 유지돼야 함
    })
    out = validate_candles(raw)
    assert len(out) == 3, "0/음수 가격 봉이 걸러지지 않음"
    assert (out[["open", "high", "low", "close"]] > 0).all().all()
    assert list(out["close"]) == [10.5, 11.5, 12.5]
    assert 0 in list(out["volume"]), "정상인 0 거래량까지 제거됨"
