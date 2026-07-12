"""캐시 강화 회귀 테스트 — 용량·만료 정리·신생 종목 truncated 오판."""
import numpy as np
import pandas as pd

from app.providers.cache import _CANDLE_MAX_ENTRIES, _TTLCache


def test_candle_cache_holds_full_universe():
    """캐시 상한이 유니버스보다 작으면 순차 스캔의 히트율이 0%가 된다.

    국내 300 + 미국 ~470 종목이 전부 공존할 수 있어야 두 스캐너가
    페치 한 번을 공유한다 (교차 스캔 캐시 공유의 전제).
    """
    assert _CANDLE_MAX_ENTRIES >= 800
    cache = _TTLCache(ttl=600.0, max_entries=_CANDLE_MAX_ENTRIES)
    for i in range(770):  # kr 300 + us 470
        cache.set(("candles", f"S{i:04d}", "day"), i)
    hits = sum(cache.get(("candles", f"S{i:04d}", "day")) is not None
               for i in range(770))
    assert hits == 770, f"유니버스 캐시가 자기 자신을 밀어냄 (hit {hits}/770)"


def test_ttl_cache_evicts_expired_before_live():
    """상한 도달 시 만료 항목을 먼저 비워 살아 있는 캐시를 지킨다."""
    cache = _TTLCache(ttl=100.0, max_entries=10)
    import time
    now = time.monotonic()
    for i in range(5):   # 만료된 항목 5개 (타임스탬프 조작)
        cache.set(f"old{i}", i)
        ts, v = cache._data[f"old{i}"]
        cache._data[f"old{i}"] = (ts - 200.0, v)
    for i in range(5):   # 살아 있는 항목 5개 -> 상한 도달
        cache.set(f"live{i}", i)
    cache.set("new", 99)  # 상한 초과 -> 만료분만 정리돼야 함
    assert all(cache.get(f"live{i}") is not None for i in range(5)), \
        "만료 항목 대신 살아 있는 캐시가 축출됨"
    assert cache.get("new") == 99


def test_scan_ttl_covers_watchdog():
    """캔들 TTL 이 스캔 워치독보다 짧으면 느린 스캔이 재페치 라이브락에 빠진다."""
    from app.pattern_scan import SCAN_TIMEOUT_SEC
    from app.providers.cache import _CANDLE_TTL_SEC
    assert _CANDLE_TTL_SEC > SCAN_TIMEOUT_SEC


def _df_from(start: str, periods: int) -> pd.DataFrame:
    idx = pd.date_range(start, periods=periods, freq="B", name="Date")
    return pd.DataFrame({
        "Open": 1.0, "High": 2.0, "Low": 0.5, "Close": 1.5,
        "Volume": np.full(periods, 10),
    }, index=idx)


def test_young_symbol_not_marked_truncated(monkeypatch):
    """상장 2년차 종목: 창(5년) 조회가 짧게 돌아와도 '진짜 소진'이므로
    truncated 로 오판하면 안 된다 — 오판하면 영원히 캐시 불가."""
    import app.providers.free_data as mod
    from app.providers.free_data import FreeDataProvider

    young = _df_from(pd.Timestamp.today() - pd.Timedelta(days=400), 260)

    def fake_fdr(symbol, start="1990-01-01"):
        return young  # 첫 봉이 요청 시작일보다 한참 뒤

    monkeypatch.setattr(mod, "_fetch_fdr_sync", fake_fdr)
    p = FreeDataProvider()
    df = p._fetch_daily_sync("NEWBIE", max_bars=1050)
    assert not df.attrs.get("truncated", False), \
        "신생 종목이 truncated 로 오판돼 캐시 불가가 됨"


def test_window_bound_fetch_still_marked_truncated(monkeypatch):
    """창이 실제로 데이터를 자른 경우(첫 봉 ≈ 요청 시작일)는 여전히 표시."""
    import app.providers.free_data as mod
    from app.providers.free_data import FreeDataProvider, _start_for

    start = _start_for(1050)

    def fake_fdr(symbol, start_arg="1990-01-01"):
        return _df_from(start_arg, 500)  # 요청 시작일부터, 요청량보다 적게

    monkeypatch.setattr(mod, "_fetch_fdr_sync", fake_fdr)
    p = FreeDataProvider()
    df = p._fetch_daily_sync("OLDIE", max_bars=1050)
    assert df.attrs.get("truncated", False) is True
