"""적대적 리뷰에서 확정된 결함들의 회귀 테스트."""
import numpy as np
import pandas as pd
import pytest

from app.analysis import EngineParams, MAStat, analyze_ma, select_recommended
from app.providers.toss import TossApiError, _parse_date
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


# --- 4. 페이지네이션: 빈 마지막 페이지 / exclusive to 세만틱스 (toss.py) ---

def _make_provider(pages):
    """_get 을 가짜 페이로드 시퀀스로 대체한 TossProvider."""
    from app.config import TossConfig
    from app.providers.toss import TossProvider

    provider = TossProvider(TossConfig(client_id="x", client_secret="y",
                                       max_count_per_request=3))
    calls = {"n": 0}

    async def fake_get(path, params):
        to = params.get("to")
        # to 파라미터: exclusive — to 날짜 미만의 캔들만 반환
        rows = [r for r in pages
                if to is None or r["date"] < to]
        rows = sorted(rows, key=lambda r: r["date"], reverse=True)[: params["count"]]
        calls["n"] += 1
        return {"result": {"candles": rows}}

    provider._get = fake_get
    return provider, calls


def _rows(dates):
    return [{"date": d, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 1}
            for d in dates]


def test_pagination_no_missing_days_with_exclusive_to():
    """exclusive `to` API 에서 페이지 경계 거래일이 누락되면 안 된다."""
    import asyncio
    days = [f"2024-01-{d:02d}" for d in range(2, 12)]  # 10 거래일
    provider, _ = _make_provider(_rows(days))
    df = asyncio.get_event_loop().run_until_complete(
        provider.candles("TEST", "day", max_bars=10)
    )
    got = df["date"].dt.strftime("%Y-%m-%d").tolist()
    assert got == days, f"누락 발생: {sorted(set(days) - set(got))}"


def test_pagination_exhausted_history_returns_collected():
    """히스토리 소진(빈 페이지)이 이미 모은 캔들을 버리면 안 된다."""
    import asyncio
    days = [f"2024-01-{d:02d}" for d in range(2, 7)]  # 5 거래일뿐
    provider, _ = _make_provider(_rows(days))
    df = asyncio.get_event_loop().run_until_complete(
        provider.candles("TEST", "day", max_bars=50)  # 더 많이 요청
    )
    assert len(df) == 5


def test_pagination_first_page_empty_raises():
    import asyncio
    provider, _ = _make_provider([])
    with pytest.raises(TossApiError):
        asyncio.get_event_loop().run_until_complete(
            provider.candles("TEST", "day", max_bars=10)
        )
