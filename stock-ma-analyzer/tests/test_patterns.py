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


# ---------- 강화 회귀 테스트 (v4 하드닝) ----------

def test_stage2_nan_volume_no_crash():
    """거래량이 전부 NaN 이어도 죽지 않고 '매칭 없음'으로 처리한다."""
    from app.patterns import detect_stage2_early

    closes, _ = _stage2_series()
    volume = np.full(len(closes), np.nan)
    hit = detect_stage2_early(_prep(_df(closes, volume=volume)))
    assert not hit.matched


def test_stage2_sparse_nan_volume_still_detected():
    """베이스 구간에 NaN 거래량이 며칠 섞여도 정상 돌파는 살아남는다."""
    from app.patterns import detect_stage2_early

    closes, volume = _stage2_series()
    volume[160:170] = np.nan  # 베이스 중간 열흘 결측
    hit = detect_stage2_early(_prep(_df(closes, volume=volume)))
    assert hit.matched, hit.summary


def test_hs_symmetry_score_bounded():
    """요약의 어깨 대칭 점수는 0~100 이어야 한다 (음수 노출 회귀 방지)."""
    import re

    ctx = _prep(_df(_hs_series(), noise_seed=1))
    hit = detect_head_shoulders(ctx)
    assert hit.matched
    m = re.search(r"어깨 대칭 (-?\d+)점", hit.summary)
    assert m, hit.summary
    assert 0 <= int(m.group(1)) <= 100


def test_scanner_error_cooldown_and_recovery():
    """전 종목 조회 실패 -> error 상태, 쿨다운 동안 재시작 금지, 이후 재시도."""
    from app.pattern_scan import PatternScanner
    from app.providers.base import SymbolInfo

    class DeadProvider:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars):
            raise RuntimeError("upstream down")

        async def search(self, q):
            return []

    async def universe_fn():
        return [SymbolInfo("A", "a", "T"), SymbolInfo("B", "b", "T")]

    scanner = PatternScanner(DeadProvider(), universe_fn)

    async def go():
        s1 = await scanner.snapshot()
        assert s1["status"] == "running"
        await scanner._task  # 스캔 실패로 종료
        s2 = await scanner.snapshot()
        assert s2["status"] == "error", s2
        assert "다시 시도" in s2["detail"]
        task_after_fail = scanner._task
        s3 = await scanner.snapshot()  # 쿨다운 중
        assert s3["status"] == "error"
        assert scanner._task is task_after_fail, "쿨다운 중 스캔이 재시작됨"
        scanner._error_ts -= 120  # 쿨다운 경과 시뮬레이션
        s4 = await scanner.snapshot()
        assert s4["status"] == "running", "쿨다운이 지나면 재시도해야 함"
        await scanner._task

    asyncio.new_event_loop().run_until_complete(go())


def test_scanner_stale_while_revalidate():
    """TTL 만료 후에도 이전 결과를 먼저 내주고 뒤에서 재스캔한다."""
    from app.pattern_scan import PatternScanner
    from app.providers.base import SymbolInfo, validate_candles

    closes, volume = _stage2_series()

    class OkProvider:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars):
            return validate_candles(_df(closes, volume=volume))

        async def search(self, q):
            return []

    async def universe_fn():
        return [SymbolInfo("S2", "종목", "T")]

    scanner = PatternScanner(OkProvider(), universe_fn)

    async def go():
        await scanner.snapshot()
        await scanner._task
        first = await scanner.snapshot()
        assert first["status"] == "done" and not first.get("refreshing")

        scanner._generated -= scanner._ttl + 1  # 강제 만료
        stale = await scanner.snapshot()
        assert stale["status"] == "done", "만료됐다고 결과를 숨기면 안 됨"
        assert stale["refreshing"] is True
        assert stale["scanned"] == 1  # 이전 결과 그대로
        await scanner._task  # 백그라운드 재스캔 종료
        fresh = await scanner.snapshot()
        assert fresh["status"] == "done" and not fresh.get("refreshing")

    asyncio.new_event_loop().run_until_complete(go())


def test_scanner_low_coverage_shortens_ttl():
    """절반도 못 훑은 스캔(부분 장애)은 결과 수명을 짧게 잡는다."""
    from app.pattern_scan import LOW_COVERAGE_TTL_SEC, PatternScanner
    from app.providers.base import SymbolInfo, validate_candles

    closes, volume = _stage2_series()

    class FlakyProvider:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars):
            if symbol != "OK":
                raise RuntimeError("down")
            return validate_candles(_df(closes, volume=volume))

        async def search(self, q):
            return []

    async def universe_fn():
        return [SymbolInfo("OK", "성공", "T"),
                SymbolInfo("X1", "실패1", "T"),
                SymbolInfo("X2", "실패2", "T")]

    scanner = PatternScanner(FlakyProvider(), universe_fn)

    async def go():
        await scanner.snapshot()
        await scanner._task
        snap = await scanner.snapshot()
        assert snap["status"] == "done" and snap["scanned"] == 1

    asyncio.new_event_loop().run_until_complete(go())
    assert scanner._ttl == LOW_COVERAGE_TTL_SEC


def test_universe_fn_kr_defends_dirty_listing():
    """중복 코드·NaN 시장명/이름·문자열 숫자 컬럼이 와도 죽지 않고 정리한다."""
    import json

    from app.pattern_scan import make_universe_fn
    from app.providers.base import SymbolInfo

    n = 60
    clean = pd.DataFrame({
        "symbol": [f"{i:06d}" for i in range(n)],
        "name": [f"종목{i}" for i in range(n)],
        "market": ["KOSPI"] * n,
        "marcap": np.arange(n, dtype=float) * 1e9 + 1e9,
        "amount": np.linspace(1e8, 9e9, n),
    })
    dirty = pd.DataFrame({
        # 중복 코드 / NaN 시장·이름 / 숫자로 못 바꾸는 컬럼
        "symbol": ["000001", "999999", "999998"],
        "name": ["중복종목", None, "문자컬럼"],
        "market": ["KOSPI", None, "KOSPI"],
        "marcap": [2e9, 5e8, "N/A"],
        "amount": [2e8, 7e8, "많음"],
    })
    listing = pd.concat([clean, dirty], ignore_index=True)

    class FakeFree:
        name = "free"

        async def listing_frame(self):
            return listing

    class Wrapper:
        name = "free"
        inner = FakeFree()

    fn = make_universe_fn(Wrapper(), "kr", [SymbolInfo("F", "폴백", "KOSPI")])
    out = asyncio.new_event_loop().run_until_complete(fn())
    symbols = [s.symbol for s in out]
    assert len(symbols) == len(set(symbols)), "중복 코드가 유니버스에 남음"
    assert "999998" not in symbols, "숫자화 불가능한 행이 걸러지지 않음"
    assert "999999" in symbols, "NaN 시장/이름 행은 정리해서 포함해야 함"
    for s in out:
        assert isinstance(s.name, str) and isinstance(s.market, str)
    # 전부 JSON 직렬화 가능해야 함 (NaN 이 남으면 API 500)
    json.dumps([[s.symbol, s.name, s.market] for s in out], allow_nan=False)


# ---------- 패턴 이탈(무효화) 자동 탈락 기준 ----------

def test_hs_dropped_after_deep_breakdown():
    """넥라인 붕괴 후 5% 넘게 진행된 H&S 는 신호 소진으로 탈락.

    근거: 5% 룰 + 되돌림은 넥라인 부근까지 (Bulkowski 2005),
    패턴 정보력은 완성 직후에 집중 (Lo·Mamaysky·Wang 2000).
    """
    fallen = np.concatenate([_hs_series(), _seg(99, 88, 30)])  # 넥라인 -10%+
    ctx = _prep(_df(fallen, noise_seed=21))
    assert not detect_head_shoulders(ctx).matched


def test_inv_hs_dropped_after_deep_breakout():
    """넥라인 위로 5% 넘게 오른 역H&S 는 진입 신호 소진으로 탈락."""
    inv = 200 - np.concatenate([_hs_series(), _seg(99, 88, 30)])
    ctx = _prep(_df(inv, noise_seed=22))
    assert not detect_head_shoulders(ctx, inverse=True).matched


def test_hs_still_valid_near_neckline():
    """넥라인 부근(±5~6%)에 있는 패턴은 계속 유효해야 한다 (탈락 기준 과잉 방지)."""
    ctx = _prep(_df(_hs_series(), noise_seed=1))  # 끝값 ~99, 넥라인 ~100
    assert detect_head_shoulders(ctx).matched


def test_hs_busted_when_price_above_head():
    """종가가 머리를 넘어 회복하면 패턴 무효 (busted — Bulkowski 2005)."""
    busted = np.concatenate([_hs_series(), _seg(99, 134, 40)])  # 머리(130) 위로
    ctx = _prep(_df(busted, noise_seed=26))
    assert not detect_head_shoulders(ctx).matched


def test_triangle_dropped_at_apex():
    """돌파 없이 꼭짓점까지 수렴해 버린 삼각형은 탈락.

    근거: 돌파는 평균적으로 꼭짓점까지 73~75% 지점에서 발생, 꼭짓점에
    닿도록 못 뚫으면 실패 경향 (Bulkowski 2005).
    """
    base = _triangle_series()
    tail = 100 + 0.5 * np.sin(np.arange(40) / 7 * np.pi)  # 사실상 꼭짓점 도달
    ctx = _prep(_df(np.concatenate([base, tail]), noise_seed=23))
    assert not detect_triangle(ctx).matched


def test_triangle_dropped_after_breakout():
    """추세선 밖으로 1 ATR 넘게 이탈(돌파 완료)한 종목은 수렴 후보에서 탈락."""
    brk = _seg(100, 118, 12)  # 상방 돌파 후 상승 진행
    ctx = _prep(_df(np.concatenate([_triangle_series(), brk]), noise_seed=24))
    assert not detect_triangle(ctx).matched


def test_cup_handle_dropped_after_handle_collapse():
    """핸들이 컵 깊이의 절반/15% 넘게 무너지면 무효 (O'Neil 핸들 규칙)."""
    collapsed = np.concatenate([_cup_series(), _seg(98, 84, 15)])  # 핸들 붕괴
    ctx = _prep(_df(collapsed, noise_seed=25))
    assert not detect_cup_handle(ctx).matched


def test_cup_handle_dropped_when_extended_above_rim():
    """테두리 +5% 를 넘어 이미 상승한 종목은 추격 구간이라 탈락 (O'Neil)."""
    extended = np.concatenate([_cup_series(), _seg(98, 112, 15)])  # 테두리 +12%
    ctx = _prep(_df(extended, noise_seed=27))
    assert not detect_cup_handle(ctx).matched


def test_stage2_dropped_after_failed_breakout():
    """돌파 후 돌파선 아래로 크게 되밀리면 실패 돌파로 탈락 (와인스타인)."""
    from app.patterns import detect_stage2_early

    closes, volume = _stage2_series()
    end = closes[-1]
    closes2 = np.concatenate([closes, _seg(end, end * 0.80, 30)])  # 30주선 아래로
    volume2 = np.concatenate([volume, np.full(30, 1000.0)])
    hit = detect_stage2_early(_prep(_df(closes2, volume=volume2)))
    assert not hit.matched


def test_inv_hs_band_measured_from_neckline():
    """5% 소진 밴드는 돌파가(넥라인) 기준으로 재야 한다 (Bulkowski 5% 룰).

    머리가 깊은 역H&S에서 머리 가격을 분모로 쓰면 밴드가 비정상적으로
    좁아져(예: 머리 60·넥라인 100이면 5%가 실제로는 3%), 넥라인 +4%의
    멀쩡한 진입 후보가 부당하게 탈락한다.
    """
    parts = [
        _seg(100, 80, 25), _seg(80, 100, 25),   # 왼어깨(80) -> 넥라인(100)
        _seg(100, 60, 30), _seg(60, 100, 30),   # 깊은 머리(60) -> 넥라인(100)
        _seg(100, 82, 25), _seg(82, 104, 25),   # 오른어깨(82) -> 넥라인 +4%
    ]
    ctx = _prep(_df(np.concatenate(parts), noise_seed=28))
    hit = detect_head_shoulders(ctx, inverse=True)
    assert hit.matched, "넥라인 +4%는 5% 밴드 안 — 머리 깊이 때문에 탈락하면 안 됨"


def test_hs_dropped_when_completed_long_ago():
    """넥라인 이탈(완성) 후 10봉 넘게 지난 패턴은 신호 소진으로 탈락.

    현재 거리만 보는 무기억 판정이면 완성 후 넥라인 근처에서 횡보만 해도
    계속 목록에 남는다 — 완성 '시점' 추적으로 걸러야 한다
    (Lo·Mamaysky·Wang 2000 completion · Bulkowski 되돌림 ~10일).
    """
    stale = np.concatenate([_hs_series(), np.full(30, 97.0)])  # 완성 후 30봉 횡보
    ctx = _prep(_df(stale, noise_seed=31))
    assert not detect_head_shoulders(ctx).matched


def test_hs_dropped_after_recovery_above_neckline():
    """완성 후 종가가 넥라인 위(몸통 쪽)로 2% 넘게 회복하면 실패 돌파로 탈락.

    스크린샷 사례(BDX·ECL·NRG): 넥라인이 무너졌다가 가격이 회복해 밴드에
    재진입 — 되돌림(throwback)은 넥라인 부근까지가 정상이므로 그 이상의
    회복은 무효로 본다 (Bulkowski 2005).
    """
    recovered = np.concatenate([_hs_series(), _seg(99, 104, 8)])  # 넥라인 +4%
    ctx = _prep(_df(recovered, noise_seed=32))
    assert not detect_head_shoulders(ctx).matched


def test_hs_fresh_breakdown_reports_state():
    """방금 완성된 패턴은 유효하고, 요약에 이탈 경과가 표시된다."""
    ctx = _prep(_df(_hs_series(), noise_seed=1))
    hit = detect_head_shoulders(ctx)
    assert hit.matched
    assert "넥라인 이탈" in hit.detail["state"] or hit.detail["state"] == "넥라인 접근 중"


def test_cup_handle_detects_slow_shallow_cup():
    """완만하게 내려가는 얕은 컵(깊이 13%·길이 200)도 문서화된 범위
    (깊이 12~50%, 길이 30~220) 안이므로 탐지돼야 한다.

    오른쪽 테두리를 '테두리 +20봉 뒤 첫 95% 교차'로 찾으면, 하락이 끝나기
    전의 가짜 회복점에 걸려 길이 미달로 영영 탐지되지 않는다 — 바닥(argmin)
    이후에서 찾아야 한다.
    """
    x = np.linspace(-1, 1, 200)
    cup = 100 - 13 * (1 - x ** 2)
    handle = np.concatenate([_seg(100, 96, 12), _seg(96, 98.5, 12)])
    closes = np.concatenate([_seg(85, 100, 40), cup, handle])
    ctx = _prep(_df(closes, noise_seed=33))
    assert detect_cup_handle(ctx).matched


def test_scanner_fail_fast_on_total_outage():
    """유니버스가 커도 초반 종목이 전부 실패하면 끝까지 훑지 않고 일찍 실패한다
    (미국 시세 소스가 통째로 막혔을 때 수백 종목을 헛되이 돌지 않게)."""
    from app.pattern_scan import FAIL_FAST_PROBE, PatternScanner
    from app.providers.base import SymbolInfo

    calls = {"n": 0}

    class DeadProvider:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars):
            calls["n"] += 1
            raise RuntimeError("upstream down")

        async def search(self, q):
            return []

    async def universe_fn():
        return [SymbolInfo(f"S{i}", f"s{i}", "T") for i in range(60)]

    scanner = PatternScanner(DeadProvider(), universe_fn)

    async def go():
        await scanner.snapshot()
        await scanner._task

    asyncio.new_event_loop().run_until_complete(go())
    assert scanner._error and "실패" in scanner._error
    assert calls["n"] < 60, "조기 중단 없이 유니버스 전체를 훑었음"
    assert calls["n"] >= FAIL_FAST_PROBE, "판정 표본도 훑기 전에 중단됨"


def test_scanner_fail_fast_discards_straggler_successes():
    """조기 중단이 결정된 뒤 동시 진행분 몇 개가 뒤늦게 성공해도, 유니버스의
    몇 %짜리 '완료' 결과를 공개하지 않고 오류로 처리한다 (레이스 회귀 방지)."""
    from app.pattern_scan import PatternScanner
    from app.providers.base import SymbolInfo, validate_candles

    closes, volume = _stage2_series()

    class PartialOutage:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars):
            if symbol.startswith("BAD"):
                raise RuntimeError("429")
            await asyncio.sleep(1.0)  # 실패 12개가 먼저 끝나도록 지연
            return validate_candles(_df(closes, volume=volume))

        async def search(self, q):
            return []

    async def universe_fn():
        # 실패 12개(즉시) + 성공 8개(느림): 실패가 모두 먼저 완료되어
        # abort 가 확정된 뒤 성공이 뒤늦게 도착하는 순서를 강제한다
        return ([SymbolInfo(f"BAD{i}", "b", "T") for i in range(12)]
                + [SymbolInfo(f"GOOD{i}", "g", "T") for i in range(8)])

    scanner = PatternScanner(PartialOutage(), universe_fn)

    async def go():
        await scanner.snapshot()
        await scanner._task

    asyncio.new_event_loop().run_until_complete(go())
    assert scanner._error and "실패" in scanner._error, scanner._error
    assert scanner._results is None, "중단된 스캔의 반쪽 결과가 공개됨"
