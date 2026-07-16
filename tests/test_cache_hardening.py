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
        ts, v, cost = cache._data[f"old{i}"]   # (ts, value, cost)
        cache._data[f"old{i}"] = (ts - 200.0, v, cost)
    for i in range(5):   # 살아 있는 항목 5개 -> 상한 도달
        cache.set(f"live{i}", i)
    cache.set("new", 99)  # 상한 초과 -> 만료분만 정리돼야 함
    assert all(cache.get(f"live{i}") is not None for i in range(5)), \
        "만료 항목 대신 살아 있는 캐시가 축출됨"
    assert cache.get("new") == 99


def test_ttl_cache_bounds_total_cost():
    """개수뿐 아니라 총 비용(예: 봉 수)으로도 축출해 메모리를 실제로 묶는다."""
    cache = _TTLCache(ttl=100.0, max_entries=100, max_cost=1000, cost_fn=lambda v: v)
    cache.set("a", 600)
    cache.set("b", 600)          # 600+600 > 1000 → 오래된 a 축출
    assert cache.get("a") is None and cache.get("b") == 600
    assert cache._total_cost <= 1000
    cache.set("c", 300)          # 600+300 = 900 ≤ 1000 → 둘 다 유지
    assert cache.get("b") == 600 and cache.get("c") == 300
    assert cache._total_cost <= 1000


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
    # 국내 코드(FDR 우선 경로)를 써야 테스트가 야후 실호출 없이 밀폐된다
    df = p._fetch_daily_sync("900001", max_bars=1050)
    assert not df.attrs.get("truncated", False)
    assert not df.attrs.get("window_bound", False), \
        "신생 종목이 창-절단으로 오판돼 캐시 효율이 떨어짐"


def test_window_bound_fetch_marked_window_bound(monkeypatch):
    """창이 실제로 데이터를 자른 경우(첫 봉 ≈ 요청 시작일)는 window_bound 표시."""
    import app.providers.free_data as mod
    from app.providers.free_data import FreeDataProvider, _start_for

    start = _start_for(1050)

    def fake_fdr(symbol, start_arg="1990-01-01"):
        return _df_from(start_arg, 500)  # 요청 시작일부터, 요청량보다 적게

    monkeypatch.setattr(mod, "_fetch_fdr_sync", fake_fdr)
    p = FreeDataProvider()
    # 국내 코드(FDR 우선 경로)를 써야 테스트가 야후 실호출 없이 밀폐된다
    df = p._fetch_daily_sync("900002", max_bars=1050)
    assert df.attrs.get("window_bound", False) is True


def test_window_bound_cached_serves_same_size_request():
    """창이 자른(window_bound) 데이터: 같은/작은 요청은 캐시로 응답하고
    더 큰 요청만 재조회한다 — 스캐너 간 캐시 공유가 유지되게."""
    import asyncio

    from app.providers.base import validate_candles
    from app.providers.cache import CachingProvider

    calls = {"n": 0}
    base_df = validate_candles(pd.DataFrame({
        "date": pd.bdate_range("2024-01-01", periods=500),
        "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5,
        "volume": np.full(500, 10),
    }))

    class P:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars):
            calls["n"] += 1
            out = base_df.copy()
            out.attrs["window_bound"] = True
            return out

        async def search(self, q):
            return []

    async def go():
        cp = CachingProvider(P())
        a = await cp.candles("S", "day", 1050)
        b = await cp.candles("S", "day", 1050)  # 같은 크기 -> 캐시 히트
        c = await cp.candles("S", "day", 300)   # 더 작은 요청 -> 캐시 히트
        assert len(a) == 500 and len(b) == 500 and len(c) == 300
        await cp.candles("S", "day", 5000)      # 더 큰 요청만 재조회

    asyncio.new_event_loop().run_until_complete(go())
    assert calls["n"] == 2, f"upstream 호출 {calls['n']}회 (기대 2)"


def _mkdf(n=800):
    import pandas as pd
    from app.providers.base import validate_candles
    return validate_candles(pd.DataFrame({
        "date": pd.bdate_range("2021-01-04", periods=n),
        "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 10,
    }))


def test_negative_cache_skips_recently_failed_symbol():
    """스캐너 경로(use_fail_cache=True)에서 한 번 실패한 종목은 잠시 즉시
    NegativeCacheSkip 으로 건너뛴다 — 같은 hang 을 반복 지불하지 않게."""
    import asyncio

    from app.providers.cache import CachingProvider, NegativeCacheSkip

    calls = {"n": 0}

    class Flaky:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars):
            calls["n"] += 1
            raise RuntimeError("429 막힘")

        async def search(self, q):
            return []

    cache = CachingProvider(Flaky())

    async def go():
        skips = 0
        for _ in range(5):
            try:
                await cache.candles("BAD", "day", 300, use_fail_cache=True)
            except NegativeCacheSkip:
                skips += 1
            except RuntimeError:
                pass
        return skips

    skips = asyncio.new_event_loop().run_until_complete(go())
    assert calls["n"] == 1, f"실패가 네거티브 캐시되지 않아 {calls['n']}번 재시도됨"
    assert skips == 4, f"이후 호출이 스킵으로 처리되지 않음 (skips={skips})"


def test_negative_cache_not_used_on_user_path():
    """사용자 요청 경로(use_fail_cache 기본 False)는 네거티브 캐시를 읽지도
    쓰지도 않는다 — 사용자가 명시적으로 요청한 종목은 매번 실제 조회한다
    (스캐너의 실패가 /api/analyze 를 막지 않게)."""
    import asyncio

    from app.providers.cache import CachingProvider

    calls = {"n": 0}

    class Flaky:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars):
            calls["n"] += 1
            raise RuntimeError("일시 실패")

        async def search(self, q):
            return []

    cache = CachingProvider(Flaky())

    async def go():
        for _ in range(3):
            try:
                await cache.candles("SYM", "day", 300)  # 사용자 경로
            except RuntimeError:
                pass

    asyncio.new_event_loop().run_until_complete(go())
    assert calls["n"] == 3, "사용자 경로가 네거티브 캐시에 막혀 재조회하지 못함"
    assert not cache._fails, "사용자 경로가 네거티브 캐시를 오염시킴"


def test_negative_cache_convoy_waiters_share_failure():
    """같은 키를 동시에 기다리던 스캐너 요청들도 한 번의 실패를 공유한다
    (핫키 컨보이 방지)."""
    import asyncio

    from app.providers.cache import CachingProvider

    calls = {"n": 0}

    class SlowFail:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars):
            calls["n"] += 1
            await asyncio.sleep(0.05)
            raise RuntimeError("느린 실패")

        async def search(self, q):
            return []

    cache = CachingProvider(SlowFail())

    async def go():
        results = await asyncio.gather(
            *(cache.candles("IDX", "day", 300, use_fail_cache=True) for _ in range(6)),
            return_exceptions=True,
        )
        assert all(isinstance(r, Exception) for r in results)

    asyncio.new_event_loop().run_until_complete(go())
    assert calls["n"] == 1, f"대기자들이 같은 실패를 {calls['n']}번 반복함"


def test_negative_cache_cleared_on_success():
    """실패 후 성공하면 네거티브 캐시가 풀려 정상 응답한다."""
    import asyncio

    from app.providers.cache import CachingProvider

    state = {"fail": True}

    class Recovering:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars):
            if state["fail"]:
                raise RuntimeError("일시 실패")
            return _mkdf()

        async def search(self, q):
            return []

    cache = CachingProvider(Recovering())

    async def go():
        try:
            await cache.candles("SYM", "day", 300, use_fail_cache=True)
        except RuntimeError:
            pass
        # 네거티브 캐시 만료를 앞당겨 재조회 허용
        cache._fails[("candles", "SYM", "day")] = (0.0, "x")
        state["fail"] = False
        df = await cache.candles("SYM", "day", 300, use_fail_cache=True)
        assert len(df) == 300
        assert ("candles", "SYM", "day") not in cache._fails

    asyncio.new_event_loop().run_until_complete(go())


def test_live_cache_served_before_negative_cache():
    """살아있는 캐시가 있으면 네거티브 캐시보다 먼저 응답한다 — 실패한 큰
    요청이 이미 받아둔 작은 데이터를 가리지 않게."""
    import asyncio

    from app.providers.cache import CachingProvider

    class BigFails:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars):
            if max_bars > 500:
                raise RuntimeError("큰 요청 실패")
            return _mkdf(500)

        async def search(self, q):
            return []

    cache = CachingProvider(BigFails())

    async def go():
        a = await cache.candles("S", "day", 300, use_fail_cache=True)  # 성공·캐시됨
        assert len(a) == 300
        try:
            await cache.candles("S", "day", 5000, use_fail_cache=True)  # 실패·네거티브 기록
        except RuntimeError:
            pass
        # 살아있는 캐시(500봉)로 감당 가능한 요청은 네거티브 캐시에도 불구하고 응답
        b = await cache.candles("S", "day", 300, use_fail_cache=True)
        assert len(b) == 300, "네거티브 캐시가 살아있는 캐시를 가림"

    asyncio.new_event_loop().run_until_complete(go())
