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


def test_cup_handle_rejects_wide_v_bottom():
    """넓은 V(길이 80·깊이 25%)는 길이 게이트(30~220)를 통과한다 — 2차
    적합도만으로는 대칭 V 의 r²가 0.94까지 올라가 배제되지 않으므로,
    V-모델 대비 비교로 걸러내야 한다 (O'Neil: 컵은 U자, V자 아님)."""
    wide_v = np.concatenate([
        _seg(80, 100, 40),                       # 진입 전 상승
        _seg(100, 75, 40), _seg(75, 100, 40),    # 넓은 대칭 V (깊이 25%)
        _seg(100, 96, 12), _seg(96, 98, 12),     # 얕은 핸들
    ])
    ctx = _prep(_df(wide_v, noise_seed=44))
    assert not detect_cup_handle(ctx).matched, "넓은 V가 둥근 컵으로 오탐됨"


def test_inv_hs_deep_head_symmetric_shoulders_detected():
    """머리가 깊은 역H&S에서 어깨 대칭도 넥라인 기준으로 재야 한다.

    넥라인 100·머리 60·어깨 78/82(간격 4)는 넥라인 대비 4%로 대칭 조건
    (5% 이내)을 만족한다. 머리(60)를 분모로 쓰면 6.7%가 되어, 정형과
    거울상인 같은 기하가 부당하게 탈락한다."""
    parts = [
        _seg(100, 78, 22), _seg(78, 100, 22),   # 왼어깨(78) -> 넥라인
        _seg(100, 60, 26), _seg(60, 100, 26),   # 깊은 머리(60) -> 넥라인
        _seg(100, 82, 22), _seg(82, 96, 14),    # 오른어깨(82) -> 넥라인 이탈
    ]
    ctx = _prep(_df(np.concatenate(parts), noise_seed=45))
    hit = detect_head_shoulders(ctx, inverse=True)
    assert hit.matched, "넥라인 대비 4% 대칭인데 머리 깊이 때문에 탈락하면 안 됨"


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

        async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
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

        async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
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
        scanner._scan_ended -= 120  # 스캔 간 최소 휴지도 경과
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

        async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
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

        import time as _t
        scanner._generated_wall = _t.time() - 2 * 86400  # 아침 경계 넘김 (만료)
        scanner._scan_ended -= scanner._ttl + 1          # 스캔 간 최소 휴지도 경과
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

        async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
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


# ---------- 정석 부합도 (0~100) 채점 ----------

def test_conformity_membership_shapes():
    """사다리꼴/램프 멤버십: 이상 밴드 1.0, poor 경계 밖 0, 사이 선형, NaN→None."""
    from app.patterns import _down, _trap, _up

    # 사다리꼴: poor_lo=0, ideal=[2,4], poor_hi=6
    assert _trap(3.0, 0, 2, 4, 6) == 1.0          # 이상 밴드 안
    assert _trap(1.0, 0, 2, 4, 6) == 0.5          # 상승 램프 중간
    assert _trap(5.0, 0, 2, 4, 6) == 0.5          # 하강 램프 중간
    assert _trap(-1.0, 0, 2, 4, 6) == 0.0         # 경계 밖
    assert _trap(7.0, 0, 2, 4, 6) == 0.0
    assert _trap(float("nan"), 0, 2, 4, 6) is None  # 측정 불가
    # 단조 램프
    assert _up(2.0, 1.0, 2.0) == 1.0 and _up(1.5, 1.0, 2.0) == 0.5
    assert _up(0.5, 1.0, 2.0) == 0.0 and _up(float("nan"), 1, 2) is None
    assert _down(0.5, 0.5, 1.0) == 1.0 and _down(0.75, 0.5, 1.0) == 0.5
    assert _down(1.2, 0.5, 1.0) == 0.0


def test_conformity_aggregation_gates_single_flaw():
    """합산 규칙: 치명적 결함 하나(0점 차원)는 산술평균보다 점수를 크게
    끌어내려야 한다 (기하 성분 — 패턴은 전 요건 동시 충족 게슈탈트)."""
    from app.patterns import _conformity

    perfect, _ = _conformity([("a", 1.0, 1.0), ("b", 1.0, 1.0), ("c", 1.0, 1.0)])
    assert perfect == 100.0
    flawed, _ = _conformity([("a", 1.0, 1.0), ("b", 1.0, 1.0), ("c", 1.0, 0.0)])
    arith_only = 100 * (2 / 3)
    assert flawed < arith_only - 10, f"결함이 평균에 묻힘: {flawed} vs {arith_only}"
    # 경계: 0~100 를 벗어나지 않는다
    assert 0.0 <= flawed <= 100.0


def test_conformity_renormalizes_missing_dims():
    """측정 불가(None) 차원은 0 벌점이 아니라 제외 + 가중치 재정규화 —
    거래량 데이터가 없는 종목이 결함 취급을 받으면 안 된다."""
    from app.patterns import _conformity

    with_missing, detail = _conformity(
        [("geo", 1.0, 0.8), ("vol", 1.0, None), ("sym", 1.0, 0.8)])
    no_missing, _ = _conformity([("geo", 1.0, 0.8), ("sym", 1.0, 0.8)])
    assert with_missing == no_missing, "None 차원이 점수에 영향을 줌"
    assert "vol" not in detail and detail["_coverage"] < 1.0
    # 전부 측정 불가면 0점 (신뢰할 근거 없음)
    empty, d = _conformity([("a", 1.0, None)])
    assert empty == 0.0 and d == {}


def test_pattern_scores_bounded_0_100():
    """모든 탐지 결과의 score 는 정석 부합도 0~100 범위."""
    from app.patterns import detect_stage2_early

    hits = []
    hits.append(detect_head_shoulders(_prep(_df(_hs_series(), noise_seed=1))))
    hits.append(detect_head_shoulders(
        _prep(_df(200 - _hs_series(), noise_seed=2)), inverse=True))
    hits.append(detect_triangle(_prep(_df(_triangle_series(), noise_seed=3))))
    hits.append(detect_cup_handle(_prep(_df(_cup_series(), noise_seed=4))))
    closes, volume = _stage2_series()
    hits.append(detect_stage2_early(_prep(_df(closes, volume=volume))))
    for hit in hits:
        assert hit.matched, hit
        assert 0.0 <= hit.score <= 100.0, f"{hit.pattern}: {hit.score}"
        assert "conformity" in hit.detail, "채점 세부 내역이 없음"
        conf = hit.detail["conformity"]
        assert 0.0 < conf.get("_coverage", 0) <= 1.0
        for k, v in conf.items():
            if k != "_coverage":
                assert 0.0 <= v <= 1.0, f"{hit.pattern}.{k}={v}"


def test_hs_textbook_volume_ranks_higher():
    """거래량 정석(왼어깨>머리>오른어깨 감소)이 거꾸로(오른어깨로 증가)보다
    높은 부합도를 받아야 한다 — Bulkowski 의 핵심 품질 신호."""
    closes = _hs_series()
    n = len(closes)
    declining = np.linspace(3000, 600, n)   # 교과서: 오른쪽으로 갈수록 마름
    rising = np.linspace(600, 3000, n)      # 경고: 오른어깨로 거래량 증가
    hit_good = detect_head_shoulders(
        _prep(_df(closes, noise_seed=1, volume=declining)))
    hit_bad = detect_head_shoulders(
        _prep(_df(closes, noise_seed=1, volume=rising)))
    assert hit_good.matched and hit_bad.matched
    assert hit_good.score > hit_bad.score, (
        f"감소 거래량 {hit_good.score} <= 증가 거래량 {hit_bad.score}")
    assert hit_good.detail["conformity"]["vol_trend"] > \
        hit_bad.detail["conformity"]["vol_trend"]


def test_triangle_volume_contraction_ranks_higher():
    """수렴하며 거래량이 마르는 삼각형(교과서, ~86%)이 거래량이 늘어나는
    삼각형(경고 신호)보다 높은 부합도를 받아야 한다."""
    closes = _triangle_series()
    n = len(closes)
    drying = np.linspace(2500, 700, n)
    swelling = np.linspace(700, 2500, n)
    hit_good = detect_triangle(_prep(_df(closes, noise_seed=3, volume=drying)))
    hit_bad = detect_triangle(_prep(_df(closes, noise_seed=3, volume=swelling)))
    assert hit_good.matched and hit_bad.matched
    assert hit_good.score > hit_bad.score


def test_stage2_stronger_breakout_volume_scores_higher():
    """돌파 거래량 3배(와인스타인 교과서 초과)가 1.4배(최소 통과)보다
    높은 부합도 — 다른 조건이 같을 때 거래량 확증이 순위를 가른다."""
    from app.patterns import detect_stage2_early

    closes, strong_vol = _stage2_series(breakout_volume=3000.0)
    _, weak_vol = _stage2_series(breakout_volume=1400.0)
    hit_strong = detect_stage2_early(_prep(_df(closes, volume=strong_vol)))
    hit_weak = detect_stage2_early(_prep(_df(closes, volume=weak_vol)))
    assert hit_strong.matched and hit_weak.matched
    assert hit_strong.score > hit_weak.score
    assert hit_strong.detail["conformity"]["breakout_vol"] > \
        hit_weak.detail["conformity"]["breakout_vol"]


def test_cup_handle_volume_dryup_ranks_higher():
    """핸들에서 거래량이 마르는 컵(오닐: 매도 소진)이 핸들에서 거래량이
    급증하는 컵(분산 경고)보다 높은 부합도를 받아야 한다."""
    closes = _cup_series()
    n = len(closes)
    dry = np.full(n, 1000.0); dry[-20:] = 400.0     # 핸들 거래량 마름
    churn = np.full(n, 1000.0); churn[-20:] = 1600.0  # 핸들 거래량 급증
    hit_dry = detect_cup_handle(_prep(_df(closes, noise_seed=4, volume=dry)))
    hit_churn = detect_cup_handle(_prep(_df(closes, noise_seed=4, volume=churn)))
    assert hit_dry.matched and hit_churn.matched
    assert hit_dry.score > hit_churn.score


def test_hs_no_throwback_scores_full_for_clean_runaway():
    """이탈 후 되돌림 없이 쭉 멀어진 정석 패턴은 no_throwback 만점(≈1.0) —
    이탈봉 자체의 종가 마진에 점수가 고정되던 왜곡의 회귀 테스트."""
    # 이탈(넥라인 ~100 아래) 뒤 5% 룰 안에서 계속 하락 (되돌림 없음) — 첫
    # 이탈-후 봉부터 넥라인에서 0.5 ATR 이상 떨어져 있어야 만점 밴드에 든다
    closes = np.concatenate([_hs_series(), _seg(98.6, 95.4, 6)])
    hit = detect_head_shoulders(_prep(_df(closes)))
    assert hit.matched and "이탈" in hit.detail["state"]
    conf = hit.detail["conformity"]
    assert conf.get("no_throwback", 0) >= 0.9, conf


def test_hs_no_throwback_unmeasurable_on_break_day():
    """이탈 당일(이탈 후 관찰 봉 없음)은 되돌림을 잴 수 없다 — 채점에서
    제외(None)돼야 하며 0점 벌점으로 잡히면 안 된다."""
    hit = detect_head_shoulders(_prep(_df(_hs_series())))  # 마지막 봉이 첫 이탈
    assert hit.matched and "이탈 0봉 전" in hit.detail["state"]
    assert "no_throwback" not in hit.detail["conformity"]


def test_cup_confirmed_breakout_not_penalized():
    """테두리 돌파가 '완료'된 교과서 컵(돌파 거래량 급증)이 돌파 전 후보보다
    낮게 랭크되면 안 된다 — 돌파 급등봉이 핸들 창에 섞여 핸들 마름/하향
    점수를 깎던 자기모순의 회귀 테스트."""
    pre = _cup_series()                       # 돌파 전 (테두리 ~100 근접)
    post = np.concatenate([pre, [100.8, 102.2, 103.5]])  # 테두리 돌파 (+5% 이내)
    vol_pre = np.full(len(pre), 1000.0)
    vol_post = np.full(len(post), 1000.0)
    vol_post[-3:] = 3500.0                    # 돌파 거래량 3.5배 (오닐 교과서)
    hit_pre = detect_cup_handle(_prep(_df(pre, volume=vol_pre)))
    hit_post = detect_cup_handle(_prep(_df(post, volume=vol_post)))
    assert hit_pre.matched and hit_post.matched
    conf_pre, conf_post = hit_pre.detail["conformity"], hit_post.detail["conformity"]
    # 핸들 품질(마름)은 돌파 '이전' 창으로만 재므로 두 변형이 같아야 한다
    assert conf_post.get("handle_vol") == conf_pre.get("handle_vol"), (conf_pre, conf_post)
    # 돌파 거래량 확증은 만점으로 반영
    assert conf_post.get("breakout_vol") == 1.0
    # 확증된 돌파가 미확증 후보보다 낮게 랭크되지 않는다
    assert hit_post.score >= hit_pre.score, (hit_pre.score, hit_post.score)


def test_partial_results_trigger_early_rescan():
    """부분(partial) 결과는 TTL 내내 얼어붙지 않는다 — 쿨다운이 지나면
    백그라운드 재스캔이 시작되고 기존 결과는 refreshing 으로 서빙된다."""
    import app.pattern_scan as ps
    from app.pattern_scan import PatternScanner
    from app.providers.base import SymbolInfo, validate_candles

    closes, volume = _stage2_series()

    class FastProvider:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
            return validate_candles(_df(closes, volume=volume))

        async def search(self, q):
            return []

    async def universe_fn():
        return [SymbolInfo("OK", "성공", "T")]

    scanner = PatternScanner(FastProvider(), universe_fn)

    async def go():
        await scanner.snapshot()
        await scanner._task                        # 완주 (partial=False → 신선)
        snap1 = await scanner.snapshot()
        assert snap1["status"] == "done" and not snap1.get("refreshing")
        # 부분 결과 + 쿨다운 경과 상태를 시뮬레이션
        scanner._results["partial"] = True
        scanner._daily_frozen = False  # 부분 결과는 하루 고정 대상이 아님
        scanner._generated -= ps.PARTIAL_RESCAN_COOLDOWN_SEC + 1
        scanner._scan_ended -= ps.PARTIAL_RESCAN_COOLDOWN_SEC + 1
        snap2 = await scanner.snapshot()
        # 기존 부분 결과를 그대로 내주되, 뒤에서 새 스캔이 이미 시작돼야 한다
        assert snap2["status"] == "done" and snap2.get("refreshing") is True
        assert scanner._task is not None and not scanner._task.done()
        await scanner._task                        # 뒷정리 (재스캔 완주)

    asyncio.new_event_loop().run_until_complete(go())


def test_rescan_never_shrinks_served_results():
    """부분 재스캔이 이전 커버리지에 못 미치는 동안(초기·업스트림 악화)에는
    기존 결과를 대체하지 않는다 — 보고 있던 목록이 1~2개로 '줄었다 다시
    차는' 깜빡임 방지 (stale-while-revalidate 의 핵심 보장)."""
    import app.pattern_scan as ps
    from app.pattern_scan import PatternScanner
    from app.providers.base import SymbolInfo, validate_candles

    closes, volume = _stage2_series()
    good_df = validate_candles(_df(closes, volume=volume))

    class Switchable:
        name = "fake"
        degraded = False

        async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
            if self.degraded and symbol != "S0":
                raise RuntimeError("upstream down")  # 재스캔 때 2/3 실패
            return good_df

        async def search(self, q):
            return []

    provider = Switchable()

    async def universe_fn():
        return [SymbolInfo(f"S{i}", f"n{i}", "T") for i in range(3)]

    scanner = PatternScanner(provider, universe_fn)

    async def go():
        await scanner.snapshot()
        await scanner._task                       # 1차 스캔 완주: scanned=3
        assert scanner._results["scanned"] == 3
        # 부분 결과 + 쿨다운 경과를 시뮬레이션한 뒤, 업스트림이 악화된 재스캔
        scanner._results["partial"] = True
        scanner._daily_frozen = False  # 부분 결과는 하루 고정 대상이 아님
        scanner._generated -= ps.PARTIAL_RESCAN_COOLDOWN_SEC + 1
        scanner._scan_ended -= ps.PARTIAL_RESCAN_COOLDOWN_SEC + 1
        provider.degraded = True
        await scanner.snapshot()                  # 재스캔 시작 (기존 결과 서빙)
        assert scanner._task is not None and not scanner._task.done(), \
            "재스캔이 실제로 시작돼야 가드가 시험된다"
        await scanner._task                       # 재스캔은 1종목만 성공
        snap = await scanner.snapshot()
        # 커버리지가 후퇴한 재스캔은 결과를 대체하지 못한다 — 3종목 유지
        assert snap["status"] == "done" and snap["scanned"] == 3, snap["scanned"]

    asyncio.new_event_loop().run_until_complete(go())


def test_below_coverage_final_backs_off_then_recovers():
    """'완주했지만 이전 커버리지 미달'인 재스캔은 아무것도 갱신하지 못하므로,
    휴지 백오프가 없으면 즉시 다음 재스캔이 시작돼 쉼 없이 반복(churn)된다.
    미달 완주가 재시도 휴지를 늘리고, 정상 발행이 되면 기본값으로 돌아와야 한다."""
    import app.pattern_scan as ps
    from app.pattern_scan import PatternScanner
    from app.providers.base import SymbolInfo, validate_candles

    closes, volume = _stage2_series()
    good_df = validate_candles(_df(closes, volume=volume))

    class Switchable:
        name = "fake"
        degraded = False

        async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
            if self.degraded and symbol != "S0":
                raise RuntimeError("upstream down")
            return good_df

        async def search(self, q):
            return []

    provider = Switchable()

    async def universe_fn():
        return [SymbolInfo(f"S{i}", f"n{i}", "T") for i in range(3)]

    scanner = PatternScanner(provider, universe_fn)

    async def go():
        await scanner.snapshot()
        await scanner._task                       # 1차 완주: scanned=3
        # 만료 + 휴지 경과 → 악화된 재스캔 (1종목만 성공, 미달 완주)
        scanner._results["partial"] = True
        scanner._daily_frozen = False  # 부분 결과는 하루 고정 대상이 아님
        scanner._generated -= ps.PARTIAL_RESCAN_COOLDOWN_SEC + 1
        scanner._scan_ended -= ps.PARTIAL_RESCAN_COOLDOWN_SEC + 1
        provider.degraded = True
        await scanner.snapshot()
        await scanner._task
        # 미달 완주 → 재시도 휴지가 늘어나야 한다 (churn 방지의 핵심)
        assert scanner._retry_wait > ps.PARTIAL_RESCAN_COOLDOWN_SEC
        # 그리고 휴지가 지나기 전에는 새 스캔이 시작되지 않아야 한다
        task_before = scanner._task
        snap = await scanner.snapshot()
        assert snap["status"] == "done" and snap["scanned"] == 3
        assert scanner._task is task_before, "휴지 중 재스캔이 시작됨 (churn)"
        # 업스트림 회복 + 휴지 경과 → 정상 재스캔이 백오프를 해제한다
        provider.degraded = False
        scanner._scan_ended -= scanner._retry_wait + 1
        await scanner.snapshot()
        await scanner._task
        assert scanner._results["scanned"] == 3
        assert scanner._retry_wait == ps.PARTIAL_RESCAN_COOLDOWN_SEC

    asyncio.new_event_loop().run_until_complete(go())


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

        async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
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
    from app.pattern_scan import FAIL_FAST_PROBE, PatternScanner
    from app.providers.base import SymbolInfo, validate_candles

    closes, volume = _stage2_series()

    class PartialOutage:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
            if symbol.startswith("BAD"):
                raise RuntimeError("429")
            await asyncio.sleep(1.0)  # 실패 12개가 먼저 끝나도록 지연
            return validate_candles(_df(closes, volume=volume))

        async def search(self, q):
            return []

    async def universe_fn():
        # 실패 FAIL_FAST_PROBE개(즉시) + 성공 8개(느림): 실패가 모두 먼저 완료돼
        # abort 가 확정된 뒤 성공이 뒤늦게 도착하는 순서를 강제한다
        return ([SymbolInfo(f"BAD{i}", "b", "T") for i in range(FAIL_FAST_PROBE)]
                + [SymbolInfo(f"GOOD{i}", "g", "T") for i in range(8)])

    scanner = PatternScanner(PartialOutage(), universe_fn)

    async def go():
        await scanner.snapshot()
        await scanner._task

    asyncio.new_event_loop().run_until_complete(go())
    assert scanner._error and "실패" in scanner._error, scanner._error
    assert scanner._results is None, "중단된 스캔의 반쪽 결과가 공개됨"


def test_scanner_completes_past_negative_cache_skips():
    """선두 종목이 네거티브 캐시로 스킵돼도 스캔이 신선한 종목까지 진행해
    완주한다 — 캐시 스킵을 조기중단(fail-fast) 판정에서 제외해야, 일시적
    장애가 회복된 뒤 스캐너가 900초 동안 묶이는 웨지(wedge)를 막는다."""
    from app.pattern_scan import FAIL_FAST_PROBE, PatternScanner
    from app.providers.base import SymbolInfo, validate_candles
    from app.providers.cache import NegativeCacheSkip

    closes, volume = _stage2_series()
    good = validate_candles(_df(closes, volume=volume))

    class LeadingSkips:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
            # 선두(FAIL_FAST_PROBE+2)개는 네거티브 캐시 스킵, 이후는 성공
            idx = int(symbol[1:])
            if idx < FAIL_FAST_PROBE + 2:
                raise NegativeCacheSkip(f"{symbol}: 스킵")
            return good.copy()

        async def search(self, q):
            return []

    async def universe_fn():
        return [SymbolInfo(f"S{i}", f"s{i}", "T") for i in range(40)]

    scanner = PatternScanner(LeadingSkips(), universe_fn)

    async def go():
        await scanner.snapshot()
        await scanner._task
        return await scanner.snapshot()

    snap = asyncio.new_event_loop().run_until_complete(go())
    assert snap["status"] == "done", f"스킵 때문에 완주하지 못함: {snap}"
    assert snap["scanned"] >= 20, f"신선한 종목까지 진행하지 못함 (scanned={snap['scanned']})"


def test_daily_boundary_math():
    """아침 갱신 경계 계산: 설정된 KST 시각 기준, '이후 처음 오는' 시각."""
    import app.pattern_scan as ps
    from app.pattern_scan import _next_daily_boundary, _parse_refresh_kst

    KST = ps._KST_OFFSET_SEC
    t = 1704067200.0  # 2024-01-01T00:00:00Z = 09:00 KST (경계 06:30 이후)
    b = _next_daily_boundary(t)
    kst_min = ((b + KST) % 86400) / 60
    assert abs(kst_min - ps.DAILY_REFRESH_MIN_KST) < 1e-6
    assert b > t and (b - t) <= 86400
    # 경계 직전이면 같은 날 경계가 나온다 (몇 분 뒤)
    just_before = b - 86400 - 60
    b2 = _next_daily_boundary(just_before)
    assert 0 < (b2 - just_before) <= 3600
    # "HH:MM" 파싱: 정상값·이상값(폴백 06:30)
    assert _parse_refresh_kst("06:30") == 6 * 60 + 30
    assert _parse_refresh_kst("23:05") == 23 * 60 + 5
    assert _parse_refresh_kst("banana") == 6 * 60 + 30
    assert _parse_refresh_kst("25:00") == 6 * 60 + 30


def test_prewarm_babysits_until_all_frozen():
    """예열은 '한 번 킥'이 아니라 전 시장이 완주(하루 고정)될 때까지 반복한다 —
    첫 스캔이 부분으로 끝난 시장(주로 미국)이 방치되던 문제의 회귀 테스트."""
    from app.server import _prewarm_until_frozen

    class FakeScanner:
        def __init__(self, rounds_needed):
            self.rounds_needed = rounds_needed
            self.calls = 0
            self._daily_frozen = False

        async def snapshot(self):
            self.calls += 1
            if self.calls >= self.rounds_needed:
                self._daily_frozen = True
            return {}

        def _fresh(self):
            return self._daily_frozen

    fast = FakeScanner(rounds_needed=1)   # 국내: 첫 라운드에 완주
    slow = FakeScanner(rounds_needed=3)   # 미국: 세 번 킥해야 완주

    async def go():
        done = await _prewarm_until_frozen(
            [fast, slow], deadline_sec=30, kick_gap_sec=0, round_gap_sec=0)
        assert done is True
        assert fast._daily_frozen and slow._daily_frozen
        assert slow.calls >= 3            # 부분으로 끝난 시장을 계속 킥했다

    asyncio.new_event_loop().run_until_complete(go())


def test_prewarm_gives_up_after_deadline():
    """영원히 완주 못 하는 스캐너가 있어도 예열 루프는 시한에 끝난다 (무한루프 방지)."""
    from app.server import _prewarm_until_frozen

    class NeverFrozen:
        _daily_frozen = False

        async def snapshot(self):
            return {}

        def _fresh(self):
            return False

    async def go():
        done = await _prewarm_until_frozen(
            [NeverFrozen()], deadline_sec=0.05, kick_gap_sec=0, round_gap_sec=0.01)
        assert done is False

    asyncio.new_event_loop().run_until_complete(go())


def test_full_result_frozen_until_morning(monkeypatch):
    """완주한 양호 결과는 30분이 지나도 재스캔하지 않고 다음 아침까지 고정된다."""
    import time

    import app.pattern_scan as ps
    from app.pattern_scan import PatternScanner
    from app.providers.base import SymbolInfo, validate_candles

    closes, volume = _stage2_series()

    class OkProvider:
        name = "fake"
        calls = 0

        async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
            OkProvider.calls += 1
            return validate_candles(_df(closes, volume=volume))

        async def search(self, q):
            return []

    async def universe_fn():
        return [SymbolInfo("S2", "종목", "T")]

    scanner = PatternScanner(OkProvider(), universe_fn)

    async def go():
        await scanner.snapshot()
        await scanner._task
        assert scanner._daily_frozen is True          # 완주 = 고정 대상
        calls_after_first = OkProvider.calls
        # 30분 경과를 시뮬레이션해도(모노토닉 age 큼) 고정이라 재스캔 안 함
        scanner._generated -= ps.RESULT_TTL_SEC + 100
        scanner._scan_ended -= ps.RESULT_TTL_SEC + 100
        snap = await scanner.snapshot()
        assert snap["status"] == "done" and not snap.get("refreshing")
        assert scanner._task.done()                   # 새 스캔이 시작되지 않았다
        assert OkProvider.calls == calls_after_first
        # 아침 경계를 넘긴 것으로 시뮬레이션 → stale → 재스캔 시작
        scanner._generated_wall = time.time() - 2 * 86400
        snap2 = await scanner.snapshot()
        assert snap2["status"] == "done" and snap2.get("refreshing") is True
        assert scanner._task is not None and not scanner._task.done()
        await scanner._task

    asyncio.new_event_loop().run_until_complete(go())


def test_partial_result_not_daily_frozen():
    """부분(partial) 결과는 하루 고정 대상이 아니라 짧은 TTL 로 계속 채운다."""
    from app.pattern_scan import PatternScanner
    from app.providers.base import SymbolInfo, validate_candles

    closes, volume = _stage2_series()

    class OkProvider:
        name = "fake"

        async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
            return validate_candles(_df(closes, volume=volume))

        async def search(self, q):
            return []

    async def universe_fn():
        return [SymbolInfo("S2", "종목", "T")]

    scanner = PatternScanner(OkProvider(), universe_fn)
    scanner._partial = True
    scanner._finish({"patterns": {}}, universe_n=10, scanned_n=3, started=0.0)
    assert scanner._daily_frozen is False    # 부분 결과는 고정 안 함


def test_strip_forming_bar_rules():
    """확정 봉만 사용: 마지막 봉이 '현지 오늘 + 장 마감 전'일 때만 떼어낸다 —
    예열 실패 후 장중 방문자가 킥한 스캔도 아침 예열과 같은 기준이 되게."""
    import pandas as pd

    from app.pattern_scan import _strip_forming_bar

    def df_ending(date_str, n=5):
        dates = pd.bdate_range(end=date_str, periods=n)
        return pd.DataFrame({"date": dates, "open": 1.0, "high": 1.0,
                             "low": 1.0, "close": 1.0, "volume": 1.0})

    # 국내: 2024-01-03(수) 12:00 KST = 03:00 UTC — 장중이므로 오늘 봉 제거
    noon_kst = pd.Timestamp("2024-01-03 03:00:00", tz="UTC").timestamp()
    df = df_ending("2024-01-03")
    out = _strip_forming_bar(df, "kr", now_epoch=noon_kst)
    assert len(out) == len(df) - 1
    # 국내: 같은 날 17:00 KST(가장 늦은 마감 16:30+여유 뒤) — 확정이므로 유지
    after_close = pd.Timestamp("2024-01-03 08:00:00", tz="UTC").timestamp()
    assert len(_strip_forming_bar(df, "kr", now_epoch=after_close)) == len(df)
    # 국내: 마지막 봉이 어제 날짜면 언제든 유지
    y = df_ending("2024-01-02")
    assert len(_strip_forming_bar(y, "kr", now_epoch=noon_kst)) == len(y)

    # 미국: 2024-01-03 10:00 ET(장중, 15:00 UTC) — 오늘(ET) 봉 제거
    us_session = pd.Timestamp("2024-01-03 15:00:00", tz="UTC").timestamp()
    udf = df_ending("2024-01-03")
    assert len(_strip_forming_bar(udf, "us", now_epoch=us_session)) == len(udf) - 1
    # 미국: 같은 날 20:00 ET(마감 후, 01:00 UTC 다음날) — 유지
    us_closed = pd.Timestamp("2024-01-04 01:00:00", tz="UTC").timestamp()
    assert len(_strip_forming_bar(udf, "us", now_epoch=us_closed)) == len(udf)
    # 06:30 KST(= 전날 16:30/17:30 ET): 방금 마감된 미국 봉은 유지돼야 한다
    kst_dawn = pd.Timestamp("2024-01-03 21:30:00", tz="UTC").timestamp()  # 01-04 06:30 KST
    assert len(_strip_forming_bar(udf, "us", now_epoch=kst_dawn)) == len(udf)
    # 빈 DF 안전
    empty = df_ending("2024-01-03").iloc[0:0]
    assert len(_strip_forming_bar(empty, "kr", now_epoch=noon_kst)) == 0


def test_new_day_resets_coverage_highwater():
    """어제 고정된 커버리지(예: 300)를 오늘의 최대치(299)가 영원히 못 넘으면
    완주 스캔이 무한히 버려져 며칠 묵은 목록이 계속 서빙되던 구멍 — 경계가
    지난 결과는 고수위 기준에서 제외돼 새 완주가 그대로 채택돼야 한다."""
    import time as _t

    import app.pattern_scan as ps
    from app.pattern_scan import PatternScanner
    from app.providers.base import SymbolInfo, validate_candles

    closes, volume = _stage2_series()
    good_df = validate_candles(_df(closes, volume=volume))

    class Switchable:
        name = "fake"
        degraded = False

        async def candles(self, symbol, timeframe, max_bars, use_fail_cache=False):
            if self.degraded and symbol == "S2":
                raise RuntimeError("상장폐지")   # 오늘은 1종목이 사라짐
            return good_df

        async def search(self, q):
            return []

    provider = Switchable()

    async def universe_fn():
        return [SymbolInfo(f"S{i}", f"n{i}", "T") for i in range(3)]

    scanner = PatternScanner(provider, universe_fn)

    async def go():
        await scanner.snapshot()
        await scanner._task                      # 어제 스캔: scanned=3, 고정
        assert scanner._results["scanned"] == 3 and scanner._daily_frozen
        # 하루 경과 + 오늘은 1종목이 영구 실패
        scanner._generated_wall = _t.time() - 2 * 86400
        scanner._scan_ended -= ps.RESULT_TTL_SEC
        provider.degraded = True
        await scanner.snapshot()                 # 아침 재스캔 시작
        await scanner._task
        snap = await scanner.snapshot()
        # 새 날의 완주(2/3)는 어제 고수위(3)에 막히지 않고 채택된다
        assert snap["scanned"] == 2, snap.get("scanned")

    asyncio.new_event_loop().run_until_complete(go())


def test_sma_cumsum_matches_pandas_rolling():
    """cumsum 방식 sma 가 pandas rolling 과 수치·NaN 워밍업 모두 일치하는지
    (유한 입력 허용 오차 1e-6 — 출력 반올림 2자리 대비 무시 가능)."""
    import numpy as np
    import pandas as pd

    from app.analysis import sma

    rng = np.random.default_rng(3)
    x = 700000 * np.exp(np.cumsum(rng.normal(0, 0.02, 5000)))
    for w in (5, 20, 60, 240):
        ours = sma(x, w)
        ref = pd.Series(x).rolling(w).mean().to_numpy()
        assert np.isnan(ours[:w - 1]).all()               # 워밍업 NaN 동일
        assert np.nanmax(np.abs(ours - ref)) < 1e-6
    # 짧은 입력·비유한 입력(폴백 경로)도 안전
    assert np.isnan(sma(np.array([1.0, 2.0]), 5)).all()
    with_nan = np.array([1.0, np.nan, 3.0, 4.0, 5.0])
    ref = pd.Series(with_nan).rolling(2).mean().to_numpy()
    got = sma(with_nan, 2)
    assert np.allclose(got, ref, equal_nan=True)


def test_every_pattern_summary_has_english_twin():
    """요약문을 새로 추가할 때 영문판을 빠뜨리면 영어 모드 카드에 한국어가
    그대로 새어 나온다 — 숫자가 끼워진 문장이라 프런트에서 번역할 수 없다.
    PatternHit(summary=...) 가 있으면 summary_en 도 반드시 함께 있어야 한다."""
    import ast
    import re
    from pathlib import Path

    src = (Path(__file__).resolve().parent.parent / "app" / "patterns.py").read_text()
    tree = ast.parse(src)
    missing = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and getattr(node.func, "id", "") == "PatternHit"):
            continue
        kw = {k.arg for k in node.keywords}
        if "summary" in kw and "summary_en" not in kw:
            missing.append(node.lineno)
    assert not missing, f"summary_en 이 빠진 PatternHit (줄 번호): {missing}"

    # 영문 요약 리터럴에 한글이 섞여 있지 않은지도 확인
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and getattr(node.func, "id", "") == "PatternHit"):
            continue
        for k in node.keywords:
            if k.arg != "summary_en":
                continue
            text = ast.unparse(k.value)
            assert not re.search(r"[가-힣]", text), f"영문 요약에 한글: {text[:80]}"


def test_api_card_carries_english_summary():
    """직렬화된 매칭 카드에 summaryEn 이 실려야 프런트가 고를 수 있다."""
    from pathlib import Path

    src = (Path(__file__).resolve().parent.parent / "app" / "pattern_scan.py").read_text()
    assert '"summaryEn"' in src, "카드 직렬화에 summaryEn 이 없다"
