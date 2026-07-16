"""오늘의 지지선 터치 스캐너 테스트 — 지지 패턴을 심은 합성 데이터로 검증."""
import asyncio

import numpy as np
import pandas as pd

from app.analysis import sma
from app.providers.base import SymbolInfo, validate_candles
from app.touch_scan import TouchScanner

from .test_analysis import planted_ma_series

CANDIDATES = [5, 10, 20, 60, 120]


def _make_df(closes: np.ndarray, touch_low_at: float | None = None) -> pd.DataFrame:
    lows = closes * 0.995
    highs = closes * 1.005
    if touch_low_at is not None:
        lows[-1] = touch_low_at
    return validate_candles(pd.DataFrame({
        "date": pd.bdate_range("2019-01-01", periods=len(closes)),
        "open": closes, "high": highs, "low": lows, "close": closes,
        "volume": np.full(len(closes), 1000.0),
    }))


def _touch_df(n: int = 1500) -> pd.DataFrame:
    """MA20 지지가 심어진 시계열 — 마지막 봉이 그 선에 닿게 조정."""
    closes = np.asarray(planted_ma_series(anchor_window=20, n=n), dtype=float)
    ma20_prev = closes[-21:-1].mean()
    closes[-1] = ma20_prev * 1.002       # 종가는 선 바로 위
    return _make_df(closes, touch_low_at=ma20_prev * 0.999)  # 저가가 선에 닿음


def _far_df(n: int = 1500) -> pd.DataFrame:
    """어느 이평선에서도 먼 시계열 — 급등 8봉 뒤 마지막 봉 (짧은 선도 한참 아래).

    주의: 마지막 봉만 띄우면 MA5 같은 짧은 선이 가격을 따라붙어 정당한 터치가
    되므로, 연속 급등으로 모든 선을 가격 아래로 벌려 놓는다.
    """
    closes = np.asarray(planted_ma_series(anchor_window=20, n=n), dtype=float)
    rally = closes[-1] * 1.03 ** np.arange(1, 9)  # 8봉 연속 +3%
    return _make_df(np.concatenate([closes, rally]))


class _DummyProvider:
    name = "fake"

    async def search(self, q):
        return []

    async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
        raise NotImplementedError


def test_analyze_sync_detects_todays_touch():
    scanner = TouchScanner(_DummyProvider(), lambda: None, candidates=CANDIDATES)
    item = scanner._analyze_sync(SymbolInfo("T1", "터치종목", "TEST"), _touch_df())
    assert item is not None, "심어진 MA20 지지 + 오늘 터치가 탐지돼야 함"
    assert item["period"] == 20
    assert abs(item["distPct"]) < 2.0
    assert item["supportBounces"] >= 3  # 터치 스크리너 품질 기준: 지지 성공 3회 이상
    assert len(item["candles"]) > 50 and len(item["maLine"]) > 50
    # 차트 데이터와 이평선 값의 시간 좌표가 일치
    assert item["candles"][-1]["time"] == item["maLine"][-1]["time"]


def test_short_ma_excluded_from_candidates():
    """5일선 등 단기선은 터치 스크리너 후보에서 빠진다 (신뢰도 기준)."""
    from app.touch_scan import TOUCH_MIN_MA_PERIOD
    sc = TouchScanner(_DummyProvider(), lambda: None,
                      candidates=[5, 10, 20, 50, 60, 120, 200, 240])
    assert 5 not in sc.candidates
    assert all(p >= TOUCH_MIN_MA_PERIOD for p in sc.candidates)
    assert sc.candidates == [10, 20, 50, 60, 120, 200, 240]


def test_quality_floor_rejects_weak_lines(monkeypatch):
    """오늘 그 선에 닿아 있어도, 품질 기준(자격·지지 3회·성공률 60%) 미달이면 제외.

    실제 게이트(_analyze_sync)를 구동한다 — 백테스트 결과만 통제해 판정을 검증.
    """
    import app.touch_scan as mod

    df = _touch_df()  # 오늘 MA20 에 닿아 있는 데이터 (터치 사전필터를 통과)

    class Stat:
        def __init__(self, qualified, support_bounces, weighted_success):
            self.period = 20
            self.qualified = qualified
            self.support_bounces = support_bounces
            self.touches = support_bounces
            self.weighted_success = weighted_success
            self.score = weighted_success

    class Report:
        def __init__(self, stat):
            self.recommended = [stat]

    sc = TouchScanner(_DummyProvider(), lambda: None, candidates=CANDIDATES)
    sym = SymbolInfo("T1", "터치종목", "TEST")

    # 각 기준을 하나씩 미달시키면 제외(None)
    for weak in (Stat(True, 9, 0.55),    # 성공률 55% < 60%
                 Stat(True, 2, 0.90),    # 지지 성공 2회 < 3회
                 Stat(False, 9, 0.90)):  # 자격 미달
        monkeypatch.setattr(mod, "analyze_timeframe", lambda *a, s=weak, **k: Report(s))
        assert sc._analyze_sync(sym, df) is None

    # 모두 충족하면 통과
    monkeypatch.setattr(mod, "analyze_timeframe",
                        lambda *a, **k: Report(Stat(True, 5, 0.65)))
    item = sc._analyze_sync(sym, df)
    assert item is not None and item["period"] == 20 and item["successRate"] >= 0.60


def test_analyze_sync_ignores_far_from_line():
    scanner = TouchScanner(_DummyProvider(), lambda: None, candidates=CANDIDATES)
    item = scanner._analyze_sync(SymbolInfo("F1", "먼종목", "TEST"), _far_df())
    assert item is None, "모든 선에서 먼 종목은 터치가 아님"


def test_touch_scanner_end_to_end():
    """스캐너 전체 흐름: 유니버스 -> 병렬 분석 -> 터치만 결과에 남는다."""
    dfs = {"TOUCH": _touch_df(), "FAR": _far_df()}

    class FakeProvider:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
            return dfs[symbol]

        async def search(self, q):
            return []

    async def universe_fn():
        return [SymbolInfo("TOUCH", "터치", "TEST"), SymbolInfo("FAR", "먼", "TEST")]

    scanner = TouchScanner(FakeProvider(), universe_fn, candidates=CANDIDATES)

    async def go():
        snap = await scanner.snapshot()
        assert snap["status"] == "running"
        await scanner._task
        return await scanner.snapshot()

    snap = asyncio.new_event_loop().run_until_complete(go())
    assert snap["status"] == "done"
    assert snap["scanned"] == 2
    symbols = [m["symbol"] for m in snap["matches"]]
    assert symbols == ["TOUCH"], f"터치 종목만 남아야 함: {symbols}"
    assert snap["totalMatches"] == 1


def test_scanner_watchdog_cancels_hung_scan():
    """행(hang)에 걸린 스캔은 워치독이 끊어 무한 '진행 중' 상태를 막는다."""
    import app.pattern_scan as ps
    from app.pattern_scan import BaseScanner

    class HungScanner(BaseScanner):
        async def _scan_inner(self):
            await asyncio.sleep(3600)  # 업스트림 행 시뮬레이션

    async def go():
        scanner = HungScanner(_DummyProvider(), lambda: None)
        s1 = await scanner.snapshot()
        assert s1["status"] == "running"
        scanner._scan_started -= ps.SCAN_TIMEOUT_SEC + 1  # 시간 초과 시뮬레이션
        s2 = await scanner.snapshot()
        assert s2["status"] == "error", s2
        assert "시간 초과" in s2["detail"]
        await asyncio.sleep(0)  # cancel 전파
        assert scanner._task.cancelled() or scanner._task.done()
        # 쿨다운이 지나면 새 스캔을 시작한다
        scanner._error_ts -= 120
        s3 = await scanner.snapshot()
        assert s3["status"] == "running"
        scanner._task.cancel()  # 테스트 뒷정리
        try:
            await scanner._task
        except asyncio.CancelledError:
            pass

    asyncio.new_event_loop().run_until_complete(go())


def test_touch_scanner_fail_fast_on_total_outage():
    """터치 스캐너도 초반 전멸 시 조기 실패한다 (패턴 스캐너와 동일 규칙)."""
    from app.pattern_scan import FAIL_FAST_PROBE

    calls = {"n": 0}

    class DeadProvider:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
            calls["n"] += 1
            raise RuntimeError("upstream down")

        async def search(self, q):
            return []

    async def universe_fn():
        return [SymbolInfo(f"S{i}", f"s{i}", "T") for i in range(60)]

    scanner = TouchScanner(DeadProvider(), universe_fn, candidates=[5, 10, 20])

    async def go():
        await scanner.snapshot()
        await scanner._task

    asyncio.new_event_loop().run_until_complete(go())
    assert scanner._error and "실패" in scanner._error
    assert calls["n"] < 60, "조기 중단 없이 유니버스 전체를 훑었음"
    assert calls["n"] >= FAIL_FAST_PROBE, "판정 표본도 훑기 전에 중단됨"


def test_touch_prefilter_skips_backtest_when_no_touch(monkeypatch):
    """오늘 어떤 이평선에도 안 닿은 종목은 비싼 백테스트(analyze_timeframe)를
    아예 건너뛴다 — 터치 스캔 속도의 핵심 최적화."""
    import app.touch_scan as mod

    calls = {"n": 0}
    real = mod.analyze_timeframe

    def spy(*a, **k):
        calls["n"] += 1
        return real(*a, **k)

    monkeypatch.setattr(mod, "analyze_timeframe", spy)
    sc = TouchScanner(None, None, candidates=[5, 10, 20, 60, 120])

    # 강한 상승 추세 마지막에 급등 — 오늘 종가/저가가 어떤 이평선보다도 훨씬 위 →
    # 사전 필터에서 '터치 없음'으로 걸러져 백테스트가 안 돌아야 한다
    n = 800
    closes = np.linspace(10, 100, n)
    closes[-1] = 200.0  # 오늘 급등: 모든 이평선 위로 멀리
    df = validate_candles(pd.DataFrame({
        "date": pd.bdate_range("2020-01-02", periods=n),
        "open": closes, "high": closes * 1.02, "low": closes * 0.99,
        "close": closes, "volume": 1e6}))
    assert sc._analyze_sync(SymbolInfo("X", "x", "T"), df) is None
    assert calls["n"] == 0, "터치가 없는데 백테스트가 돌았음"
