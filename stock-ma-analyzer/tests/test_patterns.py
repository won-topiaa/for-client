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


def _df(closes, noise_seed=None):
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
        "volume": np.full(n, 1000),
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


# ---------- run_all / 스캐너 통합 ----------

def test_run_all_returns_all_patterns():
    df = _df(_cup_series(), noise_seed=8)
    hits = run_all(df)
    assert set(hits.keys()) == {
        "head_shoulders", "inv_head_shoulders", "triangle", "cup_handle", "stage",
    }
    for hit in hits.values():
        assert isinstance(hit, PatternHit)
        assert "_ctx_len" in hit.detail


def test_scanner_end_to_end():
    """가짜 공급자로 스캐너 전체 흐름 (스캔 -> 직렬화 -> 좌표 변환)."""
    from app.pattern_scan import PatternScanner
    from app.providers.base import SymbolInfo, validate_candles

    class FakeProvider:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars):
            base = {"CUP": _cup_series(), "HS": _hs_series(),
                    "UP": np.concatenate([np.full(200, 100.0), _seg(100, 180, 250)])}[symbol]
            return validate_candles(_df(base, noise_seed=9))

        async def search(self, q):
            return []

    universe = [SymbolInfo("CUP", "컵회사", "TEST"),
                SymbolInfo("HS", "헤드숄더회사", "TEST"),
                SymbolInfo("UP", "상승회사", "TEST")]
    scanner = PatternScanner(FakeProvider(), universe)

    async def go():
        snap = await scanner.snapshot()
        assert snap["status"] == "running"
        await scanner._task
        return await scanner.snapshot()

    snap = asyncio.new_event_loop().run_until_complete(go())
    assert snap["status"] == "done"
    pats = snap["patterns"]
    cups = [m["symbol"] for m in pats["cup_handle"]]
    assert "CUP" in cups
    hs = [m["symbol"] for m in pats["head_shoulders"]]
    assert "HS" in hs
    stage2 = [m["symbol"] for m in pats["stage"]["2"]]
    assert "UP" in stage2
    # 직렬화된 매치는 차트 데이터와 오버레이 좌표(날짜 문자열)를 포함
    m = pats["cup_handle"][0]
    assert len(m["candles"]) > 50
    for ov in m["overlays"]:
        for pt in ov["points"]:
            assert isinstance(pt["time"], str) and "value" in pt
