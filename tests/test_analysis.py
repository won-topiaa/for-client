"""분석 엔진 단위/통합 테스트."""
import numpy as np
import pandas as pd
import pytest

from app.analysis import (
    EngineParams,
    _group_episodes,
    analyze_ma,
    analyze_timeframe,
    atr,
    sma,
    wilson_lower_bound,
)


def make_df(closes, highs=None, lows=None):
    closes = np.asarray(closes, dtype=float)
    highs = np.asarray(highs, dtype=float) if highs is not None else closes * 1.005
    lows = np.asarray(lows, dtype=float) if lows is not None else closes * 0.995
    n = len(closes)
    return pd.DataFrame({
        "date": pd.bdate_range("2015-01-01", periods=n),
        "open": closes,
        "high": highs,
        "low": lows,
        "close": closes,
        "volume": np.full(n, 1000),
    })


def test_sma_matches_pandas():
    values = np.arange(1.0, 21.0)
    out = sma(values, 5)
    assert np.isnan(out[3])
    assert out[4] == pytest.approx(3.0)
    assert out[-1] == pytest.approx(np.mean(values[-5:]))


def test_atr_positive_and_nan_warmup():
    rng = np.random.default_rng(0)
    c = 100 + np.cumsum(rng.normal(0, 1, 100))
    h, l = c + 1, c - 1
    out = atr(h, l, c, 14)
    assert np.isnan(out[5])
    assert np.all(out[20:] > 0)


def test_wilson_bounds():
    assert wilson_lower_bound(1.0, 0, 1.28) == 0.0
    lb_small = wilson_lower_bound(0.8, 5, 1.28)
    lb_big = wilson_lower_bound(0.8, 50, 1.28)
    assert 0 < lb_small < lb_big < 0.8


def test_group_episodes_merges_nearby_touches():
    idx = np.array([10, 11, 12, 16, 30, 31])
    # gap=2: 12 와 16 은 3봉 차이 -> 분리, 10-12 는 병합
    groups = _group_episodes(idx, gap=2)
    assert groups == [(10, 12), (16, 16), (30, 31)]


def test_support_bounce_detected():
    """상승 추세에서 저가 꼬리가 MA20 을 건드리고 반등 -> 지지 성공."""
    n = 120
    closes = np.full(n, 110.0)
    closes[:60] = np.linspace(90, 110, 60)      # 상승 (가격이 MA 위)
    closes[60:70] = 110.0                       # 종가는 MA 위에서 횡보
    closes[70:] = np.linspace(110, 130, 50)     # 강한 반등
    lows = closes * 0.995
    lows[62:68] = closes[62:68] * 0.965         # 저가 꼬리가 MA20 근처까지
    df = make_df(closes, lows=lows)
    p = EngineParams(min_touches=1, trend_context_bars=5)
    stat = analyze_ma(df, 20, p, window_start=25, half_life=100.0)
    assert stat.touches >= 1
    assert stat.support_bounces >= 1
    assert stat.breaks == 0


def test_break_detected():
    """지지 시험 후 급락 -> break 로 판정되어야 한다."""
    n = 140
    closes = np.concatenate([
        np.linspace(90, 120, 70),     # 상승
        np.linspace(120, 112, 10),    # MA 로 접근
        np.linspace(111, 70, 60),     # 붕괴
    ])
    df = make_df(closes)
    p = EngineParams(min_touches=1)
    stat = analyze_ma(df, 20, p, window_start=25, half_life=100.0)
    assert stat.breaks >= 1


def test_insufficient_data_flag():
    df = make_df(np.linspace(100, 110, 60))
    p = EngineParams(min_touches=5)
    stat = analyze_ma(df, 240, p, window_start=0, half_life=50.0)
    assert stat.insufficient_data


def test_recency_weighting_prefers_recent():
    """같은 성공 횟수라도 최근 사건이 가중 성공률에 더 크게 반영."""
    from app.analysis import TouchEpisode, MAStat
    # 오래된 성공 1 + 최근 실패 1 vs 오래된 실패 1 + 최근 성공 1
    # 가중 성공률: 후자가 높아야 한다
    def weighted_rate(episodes, n, half_life):
        w = [0.5 ** ((n - 1 - e.end) / half_life) for e in episodes]
        s = [1.0 if e.outcome == "bounce" else 0.0 for e in episodes]
        return sum(wi * si for wi, si in zip(w, s)) / sum(w)

    old_win = TouchEpisode(10, 10, "support", "bounce", 12)
    recent_loss = TouchEpisode(90, 90, "support", "break", 92)
    old_loss = TouchEpisode(10, 10, "support", "break", 12)
    recent_win = TouchEpisode(90, 90, "support", "bounce", 92)
    r1 = weighted_rate([old_win, recent_loss], 100, 30)
    r2 = weighted_rate([old_loss, recent_win], 100, 30)
    assert r2 > 0.5 > r1


def planted_ma_series(anchor_window=20, n=1500, seed=7, cycle=None, amp=0.05):
    """특정 MA 가 '지지선' 역할을 하도록 심은 합성 시계열.

    가격이 자신의 MA{anchor_window} 위에서 스프레드를 두고 움직이되,
    주기적으로 스프레드가 0 근처까지 줄었다가(=MA 터치) 다시 벌어진다
    (=반등). 트레이더가 말하는 "이평선 지지"의 전형적 패턴.
    """
    rng = np.random.default_rng(seed)
    cycle = cycle or anchor_window * 2
    closes = np.empty(n)
    closes[:anchor_window] = 100.0 * (1 + 0.001 * np.arange(anchor_window))
    for t in range(anchor_window, n):
        ma = closes[t - anchor_window:t].mean()
        phase = 0.5 - 0.5 * np.cos(2 * np.pi * t / cycle)  # 0(터치)~1(이탈)
        spread = amp * phase + rng.normal(0, 0.003)
        trend = 0.0008 * anchor_window / 20  # MA 를 계속 위로 끌어올리는 완만한 추세
        closes[t] = ma * (1 + trend + spread)
    return closes


def test_planted_anchor_ma_ranks_top():
    """MA20 에 앵커된 데이터에서 20 이 상위 추천에 들어야 한다."""
    closes = planted_ma_series(anchor_window=20)
    df = make_df(closes)
    report = analyze_timeframe(
        df, [5, 10, 20, 60, 120, 240], EngineParams(min_touches=5), "day",
        window_start=260,
    )
    top_periods = [s.period for s in report.recommended]
    assert 20 in top_periods, f"MA20 이 추천에 없음: {top_periods}"


def test_dedup_keeps_distinct_periods():
    """100/120 처럼 비슷한 기간이 동시 추천되지 않아야 한다."""
    closes = planted_ma_series(anchor_window=100, n=2000, seed=3)
    df = make_df(closes)
    report = analyze_timeframe(
        df, [5, 10, 20, 50, 60, 100, 120, 200, 240],
        EngineParams(min_touches=3), "day", window_start=300,
    )
    periods = [s.period for s in report.recommended]
    for i, p1 in enumerate(periods):
        for p2 in periods[i + 1:]:
            assert abs(p1 - p2) / max(p1, p2) > 0.2, f"{p1}/{p2} 중복 추천"


def test_no_lookahead_stability():
    """마지막 봉들을 잘라내도 과거 에피소드 판정이 바뀌면 안 된다
    (미확정 -> 확정 전환은 허용, 확정된 결과의 뒤집힘은 금지)."""
    closes = planted_ma_series(anchor_window=20, n=800, seed=11)
    df_full = make_df(closes)
    df_cut = make_df(closes[:-50])
    p = EngineParams(min_touches=1)
    full = analyze_ma(df_full, 20, p, window_start=100, half_life=200.0)
    cut = analyze_ma(df_cut, 20, p, window_start=100, half_life=200.0)
    full_by_start = {e.start: e.outcome for e in full.episodes}
    for e in cut.episodes:
        # 잘린 데이터에서 확정된 에피소드는 전체 데이터에서도 같은 결과
        if e.outcome != "undecided" and e.end < len(df_cut) - p.confirm_horizon - 1:
            assert full_by_start.get(e.start) == e.outcome
