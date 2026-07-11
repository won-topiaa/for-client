"""사용자 발견 결함 회귀 테스트: 반등 확정 후 같은 터치 군집에서 이어진
하락이 (1) 이전 성공에 흡수되지 않고 새로운 시험으로 분리되는지,
(2) 마커가 실제 반등 봉(최심 터치봉)에 붙는지."""
import numpy as np
import pandas as pd

from app.analysis import EngineParams, analyze_ma
from tests.test_analysis import make_df


def _build_bounce_then_slide(extra_below: int):
    """상승 추세 -> 꼬리로 MA10 터치 후 크게 반등(1봉) -> 이후 extra_below 개
    봉이 MA 아래로 미끄러지는 시계열. 사용자가 스크린샷으로 지적한 상황."""
    closes: list[float] = []
    lows: list[float] = []
    highs: list[float] = []
    for i in range(40):  # 꾸준한 상승 (MA10 이 가격 아래에 위치)
        c = 100.0 + 2.0 * i
        closes.append(c)
        lows.append(c - 1.0)
        highs.append(c + 1.0)

    # 40번 봉: 아래꼬리가 MA10 을 찍고 종가는 MA 위로 크게 복귀 -> 즉시 반등 확정
    s9 = sum(closes[-9:])
    c40 = (10 * 8.0 + s9) / 9.0        # (c - ma10) = +8 이 되도록 역산
    ma40 = (s9 + c40) / 10.0
    closes.append(c40)
    lows.append(ma40 - 1.0)            # 선을 살짝 뚫는 깊은 꼬리
    highs.append(c40 + 1.0)

    # 이후: 종가가 MA 아래로 미끄러지는 봉들 (터치 군집은 계속 이어짐)
    for _ in range(extra_below):
        s9 = sum(closes[-9:])
        c = (10 * (-3.0) + s9) / 9.0   # (c - ma10) = -3 (밴드 밖, ATR 돌파 문턱 안)
        ma = (s9 + c) / 10.0
        closes.append(c)
        lows.append(c - 1.0)
        highs.append(ma + 0.5)         # 고가가 선 근처 -> 터치 지속
    return make_df(np.array(closes), highs=np.array(highs), lows=np.array(lows))


def test_slide_after_bounce_becomes_new_episode():
    """반등 확정 뒤 2봉 하락(3봉 미만) -> 반등 1건 + 미확정 1건으로 분리."""
    df = _build_bounce_then_slide(extra_below=2)
    stat = analyze_ma(df, 10, EngineParams(min_touches=1), window_start=15,
                      half_life=100.0)
    outcomes = [(e.outcome, e.side) for e in stat.episodes]
    assert ("bounce", "support") in outcomes, outcomes
    # 반등 뒤의 하락 구간이 별도 에피소드(미확정)로 존재해야 한다
    bounce = next(e for e in stat.episodes if e.outcome == "bounce")
    later = [e for e in stat.episodes if e.start > bounce.end]
    assert later, "반등 이후 하락 구간이 이전 성공에 흡수됨 (분리 실패)"
    assert later[0].outcome == "undecided"


def test_slide_after_bounce_can_become_break():
    """반등 확정 뒤 3봉 연속 밴드 밖 아래 마감 -> 별도의 '이탈' 시험으로 집계."""
    df = _build_bounce_then_slide(extra_below=3)
    stat = analyze_ma(df, 10, EngineParams(min_touches=1), window_start=15,
                      half_life=100.0)
    outcomes = [e.outcome for e in stat.episodes]
    assert "bounce" in outcomes and "break" in outcomes, outcomes
    assert stat.support_bounces >= 1 and stat.breaks >= 1


def test_bounce_marker_anchored_to_deepest_touch_bar():
    """마커(anchor)는 군집 마지막 봉이 아니라 실제 반등 봉(최심 저가)에 붙는다."""
    df = _build_bounce_then_slide(extra_below=2)
    stat = analyze_ma(df, 10, EngineParams(min_touches=1), window_start=15,
                      half_life=100.0)
    bounce = next(e for e in stat.episodes if e.outcome == "bounce")
    lows = df["low"].to_numpy(float)
    seg = list(range(bounce.start, bounce.end + 1))
    deepest = min(seg, key=lambda i: lows[i])
    assert bounce.anchor == deepest
    # 반등 마커가 'MA 아래로 마감한 마지막 봉'에 붙어 있으면 안 된다
    close = df["close"].to_numpy(float)
    from app.analysis import sma
    ma = sma(close, 10)
    assert close[bounce.anchor] > ma[bounce.anchor], (
        "반등 마커가 종가<MA 인 봉에 붙음 — 사용자가 지적한 표시 결함"
    )


def test_break_marker_anchored_to_decision_bar():
    df = _build_bounce_then_slide(extra_below=3)
    stat = analyze_ma(df, 10, EngineParams(min_touches=1), window_start=15,
                      half_life=100.0)
    brk = next(e for e in stat.episodes if e.outcome == "break")
    assert brk.anchor == brk.decided_at
