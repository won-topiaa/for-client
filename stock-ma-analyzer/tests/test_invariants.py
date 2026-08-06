"""지지/저항 엔진 불변식 — 무작위 시장 데이터에서 항상 성립해야 하는 성질.

사용자 요청("지지 저항 다시 확인")에 대한 체계적 검증: 특정 시나리오가
아니라 무작위 랜덤워크 30개 시드 x 여러 MA 에서 판정의 정의 자체가
지켜지는지 확인한다.
"""
import numpy as np
import pytest

from app.analysis import EngineParams, analyze_ma, atr as atr_fn, sma
from tests.test_analysis import make_df


def _random_market(seed: int, n: int = 500):
    rng = np.random.default_rng(seed)
    r = rng.normal(0.0003, 0.02, n)
    closes = 100.0 * np.cumprod(1 + r)
    spread = np.abs(rng.normal(0, 0.008, n))
    highs = closes * (1 + spread)
    lows = closes * (1 - spread)
    return make_df(closes, highs=highs, lows=lows)


@pytest.mark.parametrize("seed", range(30))
def test_verdict_definitions_hold(seed):
    df = _random_market(seed)
    close = df["close"].to_numpy(float)
    high = df["high"].to_numpy(float)
    low = df["low"].to_numpy(float)
    p = EngineParams(min_touches=1)

    for period in (10, 20, 60):
        stat = analyze_ma(df, period, p, window_start=80, half_life=200.0)
        ma = sma(close, period)
        a = atr_fn(high, low, close, p.atr_period)
        band = np.maximum(p.touch_atr_mult * a, p.touch_pct_floor * close)

        prev_end = -1
        for e in stat.episodes:
            # 에피소드는 시간순·비중첩
            assert e.start > prev_end, "에피소드 겹침/역순"
            prev_end = e.end
            assert e.start <= e.end
            assert e.end >= 80  # 분석 창 준수

            if e.outcome == "bounce":
                j = e.decided_at
                d = (close[j] - ma[j]) if e.side == "support" else (ma[j] - close[j])
                thr = max(p.bounce_atr_mult * a[j], band[j])
                assert d > thr * 0.999, (
                    f"반등 확정봉이 문턱 미달: side={e.side} d={d:.3f} thr={thr:.3f}"
                )
                # 마커(anchor)는 판정 이전 구간의 터치봉
                assert e.start <= e.anchor <= min(e.end, j)
            elif e.outcome == "break":
                j = e.decided_at
                d = (ma[j] - close[j]) if e.side == "support" else (close[j] - ma[j])
                # 단일봉 돌파(ATR 문턱) 또는 3연속 밴드 밖 마감 — 최소 밴드 밖
                assert d > band[j] * 0.999, (
                    f"돌파 확정봉이 밴드 안: side={e.side} d={d:.3f} band={band[j]:.3f}"
                )
                assert e.anchor == j

        # 통계 일관성
        assert stat.touches == len(stat.episodes)
        assert stat.bounces + stat.breaks + stat.undecided == stat.touches
        assert 0.0 <= stat.weighted_success <= 1.0
