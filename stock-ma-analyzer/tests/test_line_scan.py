"""맞춤 이평선 스크리너(line_scan) 판정·스캔 테스트.

합성 시계열: 상승 추세 + 완만한 되돌림 사이클(끝이 눌림 저점) → 20일선 지지.
기하 반전(200×첫값/시리즈)하면 완전한 거울상이 되어 → 20일선 저항.
"""
import asyncio

import numpy as np
import pandas as pd

from app.line_scan import LineScanner
from app.providers.base import SymbolInfo, validate_candles

PERIOD = 20
N = 400


def _make_df(close: np.ndarray) -> pd.DataFrame:
    dates = pd.bdate_range("2022-01-03", periods=len(close))
    return validate_candles(pd.DataFrame({
        "date": dates,
        "open": close * 1.001,
        "high": close * 1.003,
        "low": close * 0.997,
        "close": close,
        "volume": np.full(len(close), 1e6),
    }))


def _support_series(n: int = N, amp: float = 0.01, cyc: int = 40,
                    drift: float = 0.0012, endshift: int = 2) -> np.ndarray:
    """저가가 주기적으로 20일선을 시험하고 반등하는 상승 추세.

    endshift: 시리즈 끝을 사이클 저점 직후에 맞춰 '최근 5봉 터치'가 성립."""
    i = np.arange(n)
    phase = -np.pi / 2 - 2 * np.pi * (n - 1 - endshift) / cyc
    trend = 100 * (1 + drift) ** i
    return trend * (1 + amp * (0.2 + np.sin(2 * np.pi * i / cyc + phase)) / 1.2)


def _resistance_series() -> np.ndarray:
    up = _support_series()
    return 200 * up[0] / up  # 기하 반전: 지지 구조 → 저항 구조


class _StaticProvider:
    """심볼별 고정 시계열을 주는 가짜 공급자."""
    name = "fake"

    def __init__(self, table):
        self.table = table

    async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
        return self.table[symbol]

    async def search(self, q):
        return []


def _scanner(table, universe):
    async def universe_fn():
        return universe
    return LineScanner(_StaticProvider(table), universe_fn, PERIOD)


def test_support_series_classified_as_support():
    sc = _scanner({}, [])
    item = sc._analyze_sync(SymbolInfo("SUP", "지지주", "T"),
                            _make_df(_support_series()))
    assert item is not None and item["side"] == "support"
    assert item["respectRate"] >= 0.5
    assert item["decided"] >= 2
    assert item["period"] == PERIOD
    assert item["candles"] and item["maLine"]        # 카드 차트 데이터 포함


def test_mirror_series_classified_as_resistance():
    sc = _scanner({}, [])
    item = sc._analyze_sync(SymbolInfo("RES", "저항주", "T"),
                            _make_df(_resistance_series()))
    assert item is not None and item["side"] == "resistance"
    assert item["respectRate"] >= 0.5
    assert item["decided"] >= 2


def test_confirmed_breakdown_excluded():
    """지지 구조였다가 마지막에 선 아래로 무너진 종목은 '지지 중'이 아니다."""
    base = _support_series()
    broken = np.concatenate([base, base[-1] * (1 - 0.008 * np.arange(1, 13))])
    sc = _scanner({}, [])
    assert sc._analyze_sync(SymbolInfo("BRK", "이탈주", "T"),
                            _make_df(broken)) is None


def test_flat_series_excluded():
    """추세 문맥이 없는 횡보(선을 수시로 넘나듦)는 어느 쪽에도 못 오른다."""
    i = np.arange(N)
    flat = 100 + 0.4 * np.sin(2 * np.pi * i / 7)     # 선 주변 잔진동
    sc = _scanner({}, [])
    assert sc._analyze_sync(SymbolInfo("FLT", "횡보주", "T"),
                            _make_df(flat)) is None


def test_short_data_excluded():
    sc = _scanner({}, [])
    assert sc._analyze_sync(SymbolInfo("SHT", "신규주", "T"),
                            _make_df(_support_series(200))) is None


def test_scan_end_to_end_splits_sides():
    """스캔 전체: 지지 2종목·저항 1종목이 각자 리스트로 나뉘어 발행된다."""
    sup = _make_df(_support_series())
    res = _make_df(_resistance_series())
    table = {"S1": sup, "S2": sup, "R1": res}
    universe = [SymbolInfo("S1", "지지1", "T"), SymbolInfo("R1", "저항1", "T"),
                SymbolInfo("S2", "지지2", "T")]
    scanner = _scanner(table, universe)

    async def go():
        first = await scanner.snapshot()
        assert first["status"] == "running"
        await scanner._task
        snap = await scanner.snapshot()
        assert snap["status"] == "done"
        assert snap["period"] == PERIOD
        assert {m["symbol"] for m in snap["support"]} == {"S1", "S2"}
        assert {m["symbol"] for m in snap["resistance"]} == {"R1"}
        assert snap["totalSupport"] == 2 and snap["totalResistance"] == 1

    asyncio.new_event_loop().run_until_complete(go())
