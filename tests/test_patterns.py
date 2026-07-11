"""차트 패턴 탐지기 테스트 — 교과서 형태를 합성해 탐지/비탐지 검증."""
import asyncio

import numpy as np
import pandas as pd
import pytest

from app.patterns import (
    PatternHit,
    detect_cup_handle,
    detect_head_shoulders,
    detect_stage,
    detect_triangle,
    run_all,
    zigzag,
    _prep,
)


def _df(closes, noise_seed=None, volume=None):
    closes = np.asarray(closes, dtype=float)
    if noise_seed is not None:
        rng = np.random.default_rng(noise_seed)
        closes = closes * (1 + rng.normal(0, 0.002, len(closes)))
    n = len(closes)
    return pd.DataFrame({
        "date": pd.bdate_range("2022-01-03", periods=n),
        "open": closes,
        "high": closes * 1.006,
        "low": closes * 0.994,
        "close": closes,
        "volume": np.asarray(volume, float) if volume is not None else np.full(n, 1000.0),
    })


def _seg(a, b, n):
    return np.linspace(a, b, n, endpoint=False)


# ---------- zigzag ----------

def test_zigzag_alternates_on_sine():
    x = np.arange(300)
    closes = 100 + 10 * np.sin(x / 12)
    ctx = _prep(_df(closes))
    kinds = [k for _, _, k in ctx["pivots"]]
    assert len(kinds) >= 6
    assert all(kinds[i] != kinds[i + 1] for i in range(len(kinds) - 1)), "피벗 미교대"


# ---------- 헤드 앤 숄더 ----------

def _hs_series():
    parts = [
        _seg(100, 100, 30),      # 진입 전 횡보
        _seg(100, 115, 20), _seg(115, 100, 20),   # 왼어깨
        _seg(100, 130, 22), _seg(130, 100, 22),   # 머리
        _seg(100, 114, 20), _seg(114, 99, 20),    # 오른어깨 -> 넥라인 이탈
    ]
    return np.concatenate(parts)


def test_head_shoulders_detected():
    ctx = _prep(_df(_hs_series(), noise_seed=1))
    hit = detect_head_shoulders(ctx)
    assert hit.matched, hit
    assert abs(hit.detail["head"] - 130) < 5
    assert any(ov["name"] == "넥라인" for ov in hit.overlays)


def test_inverse_head_shoulders_detected():
    inv = 200 - _hs_series()   # 상하 반전 (바닥형)
    ctx = _prep(_df(inv, noise_seed=2))
    hit = detect_head_shoulders(ctx, inverse=True)
    assert hit.matched, hit


def test_head_shoulders_rejects_trend():
    ctx = _prep(_df(_seg(100, 200, 250)))
    assert not detect_head_shoulders(ctx).matched


# ---------- 삼각수렴 ----------

def _triangle_series(n=120, kind="sym"):
    x = np.arange(n, dtype=float)
    amp = 12 * (1 - x / n * 0.85)      # 진폭이 좁아짐
    wave = np.sin(x / 7 * np.pi) * amp
    if kind == "sym":
        base = np.full(n, 100.0)
    elif kind == "asc":                # 상승 삼각형: 고점 수평, 저점 상승
        base = 100 + (12 - amp) / 2
        wave = np.sin(x / 7 * np.pi).clip(-1, 1) * amp
    return np.concatenate([np.full(60, 100.0), base + wave])


def test_triangle_detected():
    ctx = _prep(_df(_triangle_series(), noise_seed=3))
    hit = detect_triangle(ctx)
    assert hit.matched, hit
    assert "수렴" in hit.summary or "삼각형" in hit.summary
    assert len(hit.overlays) == 2


def test_triangle_rejects_constant_channel():
    x = np.arange(180)
    closes = 100 + 8 * np.sin(x / 9)   # 진폭 일정한 박스권
    ctx = _prep(_df(closes))
    assert not detect_triangle(ctx).matched


# ---------- 컵 앤 핸들 ----------

def _cup_series():
    x = np.linspace(-1, 1, 120)
    cup = 100 - 25 * (1 - x ** 2)      # 둥근 바닥 (75까지)
    handle = np.concatenate([_seg(100, 94, 10), _seg(94, 98, 10)])
    return np.concatenate([_seg(80, 100, 40), cup, handle])


def test_cup_handle_detected():
    ctx = _prep(_df(_cup_series(), noise_seed=4))
    hit = detect_cup_handle(ctx)
    assert hit.matched, hit
    assert 0.12 <= hit.detail["depth"] <= 0.5
    assert hit.detail["r2"] >= 0.7


def test_cup_handle_rejects_v_bottom():
    v = np.concatenate([
        _seg(80, 100, 40), _seg(100, 70, 15), _seg(70, 100, 15),  # 뾰족한 V
        np.full(20, 98.0),
    ])
    ctx = _prep(_df(v))
    assert not detect_cup_handle(ctx).matched


# ---------- 와인스타인 단계 ----------

def test_stage2_uptrend():
    closes = np.concatenate([np.full(150, 100.0), _seg(100, 180, 200)])
    hit = detect_stage(_prep(_df(closes, noise_seed=5)))
    assert hit.matched and hit.detail["stage"] == 2, hit.summary


def test_stage4_downtrend():
    closes = np.concatenate([np.full(150, 100.0), _seg(100, 55, 200)])
    hit = detect_stage(_prep(_df(closes, noise_seed=6)))
    assert hit.matched and hit.detail["stage"] == 4, hit.summary


def test_stage3_topping_after_rise():
    x = np.arange(120)
    closes = np.concatenate([
        _seg(100, 200, 200),                       # 큰 상승
        200 + 6 * np.sin(x / 6),                   # 150일선 주변 횡보 난타
    ])
    hit = detect_stage(_prep(_df(closes, noise_seed=7)))
    assert hit.matched and hit.detail["stage"] in (2, 3), hit.summary


def test_stage_insufficient_data():
    hit = detect_stage(_prep(_df(np.full(100, 100.0))))
    assert not hit.matched


# ---------- 와인스타인 초기 2단계 ----------

def _stage2_series(rally_to=118.0, breakout_volume=3000.0, rally_len=40):
    """하락 -> 1단계 베이스 박스 -> 거래량 실린 돌파 -> 초기 상승."""
    decline = _seg(120, 100, 150)
    rng = np.random.default_rng(11)
    base = 102 + 2 * np.sin(np.arange(130) / 5) + rng.normal(0, 0.3, 130)
    rally = np.linspace(base.max() + 4, rally_to, rally_len)  # 베이스 상단 위로 점프
    closes = np.concatenate([decline, base, rally])
    volume = np.full(len(closes), 1000.0)
    volume[len(decline) + len(base):len(decline) + len(base) + 5] = breakout_volume
    return closes, volume


def test_stage2_early_detected():
    from app.patterns import detect_stage2_early

    closes, volume = _stage2_series()
    hit = detect_stage2_early(_prep(_df(closes, volume=volume)))
    assert hit.matched, hit.summary
    assert hit.detail["vol_ratio"] >= 1.3
    assert hit.detail["ext"] <= 0.25
    assert any("베이스" in ov["name"] for ov in hit.overlays)


def test_stage2_rejects_no_volume():
    """돌파 거래량이 베이스 평균 수준이면 와인스타인 기준 미달."""
    from app.patterns import detect_stage2_early

    closes, _ = _stage2_series(breakout_volume=1000.0)
    volume = np.full(len(closes), 1000.0)
    hit = detect_stage2_early(_prep(_df(closes, volume=volume)))
    assert not hit.matched


def test_stage2_rejects_extended():
    """돌파 후 +25% 를 넘어 이미 확장된 종목은 '초기'가 아님 (추격 배제)."""
    from app.patterns import detect_stage2_early

    closes, volume = _stage2_series(rally_to=150.0)
    hit = detect_stage2_early(_prep(_df(closes, volume=volume)))
    assert not hit.matched


def test_stage2_relative_strength_bonus():
    from app.patterns import detect_stage2_early

    closes, volume = _stage2_series()
    flat_index = np.full(300, 1000.0)
    hit = detect_stage2_early(_prep(_df(closes, volume=volume)), index_close=flat_index)
    assert hit.matched
    assert "RS" in hit.summary


# ---------- run_all / 스캐너 통합 ----------

def test_run_all_returns_all_patterns():
    df = _df(_cup_series(), noise_seed=8)
    hits = run_all(df)
    assert set(hits.keys()) == {
        "head_shoulders", "inv_head_shoulders", "triangle", "cup_handle", "stage2",
    }
    for hit in hits.values():
        assert isinstance(hit, PatternHit)
        assert "_ctx_len" in hit.detail


def test_scanner_end_to_end():
    """가짜 공급자로 스캐너 전체 흐름 (유니버스 함수 -> 스캔 -> 직렬화)."""
    from app.pattern_scan import PatternScanner
    from app.providers.base import SymbolInfo, validate_candles

    s2_closes, s2_volume = _stage2_series()

    class FakeProvider:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars):
            if symbol == "IDX":  # 지수
                return validate_candles(_df(np.full(300, 1000.0)))
            data = {"CUP": (_cup_series(), None), "HS": (_hs_series(), None),
                    "S2": (s2_closes, s2_volume)}[symbol]
            return validate_candles(_df(data[0], noise_seed=9, volume=data[1]))

        async def search(self, q):
            return []

    universe = [SymbolInfo("CUP", "컵회사", "TEST"),
                SymbolInfo("HS", "헤드숄더회사", "TEST"),
                SymbolInfo("S2", "초기2단계회사", "TEST")]

    async def universe_fn():
        return universe

    scanner = PatternScanner(FakeProvider(), universe_fn, index_symbol="IDX")

    async def go():
        snap = await scanner.snapshot()
        assert snap["status"] == "running"
        await scanner._task
        return await scanner.snapshot()

    snap = asyncio.new_event_loop().run_until_complete(go())
    assert snap["status"] == "done"
    pats = snap["patterns"]
    assert "CUP" in [m["symbol"] for m in pats["cup_handle"]]
    assert "HS" in [m["symbol"] for m in pats["head_shoulders"]]
    assert "S2" in [m["symbol"] for m in pats["stage2"]]
    # 직렬화된 매치는 차트 데이터와 오버레이 좌표(날짜 문자열)를 포함
    m = pats["cup_handle"][0]
    assert len(m["candles"]) > 50
    for ov in m["overlays"]:
        for pt in ov["points"]:
            assert isinstance(pt["time"], str) and "value" in pt


def test_universe_fn_kr_liquidity_minus_mega():
    """국내 유니버스: 거래대금 상위에서 시총 상위(초대형주) 제외."""
    from app.pattern_scan import KR_EXCLUDE_MEGA, make_universe_fn
    from app.providers.base import SymbolInfo

    n = 400
    listing = pd.DataFrame({
        "symbol": [f"{i:06d}" for i in range(n)],
        "name": [f"종목{i}" for i in range(n)],
        "market": ["KOSPI"] * (n - 5) + ["KONEX"] * 5,
        # marcap: i 가 클수록 큼 / amount: 모두 유의미
        "marcap": np.arange(n, dtype=float) * 1e9,
        "amount": np.random.default_rng(1).uniform(1e8, 1e10, n),
    })

    class FakeFree:
        name = "free"

        async def listing_frame(self):
            return listing

    class Wrapper:
        name = "free"
        inner = FakeFree()

    fallback = [SymbolInfo("000001", "폴백", "KOSPI")]
    fn = make_universe_fn(Wrapper(), "kr", fallback)
    out = asyncio.new_event_loop().run_until_complete(fn())
    symbols = {s.symbol for s in out}
    assert len(out) <= 300
    # 시총 최상위(초대형)는 제외돼야 함 — KONEX 5개 제외 후 marcap 상위 30
    kospi = listing[listing["market"] == "KOSPI"]
    mega = set(kospi.nlargest(KR_EXCLUDE_MEGA, "marcap")["symbol"])
    assert not (symbols & mega), "초대형주가 유니버스에 포함됨"
    # KONEX 제외
    assert not any(s.market == "KONEX" for s in out)


def test_universe_fn_us_excludes_megacaps():
    from app.pattern_scan import MEGA_US, make_universe_fn
    from app.providers.base import SymbolInfo

    class FakeFree:
        name = "free"

        async def us_listing(self):
            return [("AAPL", "Apple", "Tech"), ("NVDA", "NVIDIA", "Tech"),
                    ("UBER", "Uber", "Tech"), ("DAL", "Delta", "Air")]

        async def listing_frame(self):
            return None

    class Wrapper:
        name = "free"
        inner = FakeFree()

    fn = make_universe_fn(Wrapper(), "us", [SymbolInfo("X", "x", "US")])
    out = asyncio.new_event_loop().run_until_complete(fn())
    symbols = {s.symbol for s in out}
    assert "UBER" in symbols and "DAL" in symbols
    assert not (symbols & MEGA_US), "메가캡이 유니버스에 포함됨"


def test_universe_fn_sample_uses_fallback():
    from app.pattern_scan import make_universe_fn
    from app.providers.base import SymbolInfo

    class SampleLike:
        name = "sample"

    fallback = [SymbolInfo("005930", "삼성전자", "KOSPI")]
    fn = make_universe_fn(SampleLike(), "kr", fallback)
    out = asyncio.new_event_loop().run_until_complete(fn())
    assert out == fallback
