"""이동평균선 지지/저항 백테스트 엔진.

핵심 아이디어
=============
차트에 그려진 SMA 선과 가격의 상호작용을 과거 전 구간에서 측정한다.

1. 터치(touch): 봉의 [저가, 고가] 범위가 MA 주변 허용 밴드와 겹치면 터치.
   허용 밴드 폭 = max(ATR × touch_atr_mult, 종가 × touch_pct_floor)
   — 변동성이 큰 종목은 넓게, 조용한 종목은 좁게 자동 조정된다.
2. 에피소드(episode): 인접한 터치 봉들을 하나의 사건으로 묶는다
   (episode_gap 봉 이내 재터치는 같은 에피소드).
3. 방향: 에피소드 직전 trend_context_bars 봉의 종가가 MA 위였으면
   "지지 시험", 아래였으면 "저항 시험".
4. 판정: 에피소드 시작부터 confirm_horizon 봉 안에서
   - 반등(bounce): 종가가 MA로부터 ATR × bounce_atr_mult 만큼
     원래 방향으로 되돌아감 (지지면 위로, 저항이면 아래로)
   - 돌파(break): 종가가 MA를 ATR × break_atr_mult 만큼 반대로 넘거나,
     break_consec_closes 개 연속 종가가 MA 반대편에서 마감
   - 둘 다 아니면 미확정(undecided) — 성공률 계산에서 제외.
5. 점수: 최근 사건에 더 큰 가중치(반감기 지수 가중)를 주고,
   가중 성공률의 Wilson 신뢰하한 × log(1+가중 반등 수) 로 계산.
   → "자주" 그리고 "믿을 만하게" 지지/저항이 된 이평선이 상위에 온다.

미래 참조(lookahead) 없음: 판정은 에피소드 이후 봉만 본다. MA 값 자체는
차트에 그려지는 그대로(해당 봉 종가 포함)를 쓴다 — 트레이더가 화면에서
보는 선과 가격의 상호작용을 측정하는 것이 목적이기 때문이다.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal

import numpy as np
import pandas as pd

Side = Literal["support", "resistance"]
Outcome = Literal["bounce", "break", "undecided"]


@dataclass
class EngineParams:
    atr_period: int = 14
    touch_atr_mult: float = 0.5
    touch_pct_floor: float = 0.0015
    confirm_horizon: int = 10
    bounce_atr_mult: float = 1.0
    break_atr_mult: float = 1.0
    break_consec_closes: int = 3
    episode_gap: int = 2
    trend_context_bars: int = 5
    min_touches: int = 5
    # 반감기(봉 수). None 이면 분석 구간의 1/3
    half_life_bars: int | None = None
    top_n: int = 3
    # 추천 목록에서 서로 너무 가까운 기간(비율 차 20% 이내)은 상위 것만 남김
    dedup_ratio: float = 0.2
    wilson_z: float = 1.2816  # 80% 단측 신뢰수준


@dataclass
class TouchEpisode:
    start: int          # 전체 df 기준 인덱스
    end: int
    side: Side
    outcome: Outcome
    decided_at: int | None
    weight: float = 1.0
    # 차트 마커를 붙일 봉: 반등이면 선을 가장 깊게 찍은 봉, 돌파면 확정된 봉
    anchor: int | None = None

    @property
    def success(self) -> bool:
        return self.outcome == "bounce"


@dataclass
class MAStat:
    period: int
    touches: int = 0
    support_bounces: int = 0
    resistance_bounces: int = 0
    breaks: int = 0
    undecided: int = 0
    weighted_success: float = 0.0   # 가중 성공률 (결정된 에피소드 기준)
    wilson_lb: float = 0.0
    score: float = 0.0
    last_touch_index: int | None = None
    qualified: bool = False
    insufficient_data: bool = False
    episodes: list[TouchEpisode] = field(default_factory=list)

    @property
    def bounces(self) -> int:
        return self.support_bounces + self.resistance_bounces

    @property
    def decided(self) -> int:
        return self.bounces + self.breaks


def sma(values: np.ndarray, window: int) -> np.ndarray:
    return pd.Series(values).rolling(window).mean().to_numpy()


def atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int) -> np.ndarray:
    prev_close = np.concatenate([[np.nan], close[:-1]])
    tr = np.nanmax(
        np.vstack([
            high - low,
            np.abs(high - prev_close),
            np.abs(low - prev_close),
        ]),
        axis=0,
    )
    return pd.Series(tr).rolling(period).mean().to_numpy()


def wilson_lower_bound(p_hat: float, n: float, z: float) -> float:
    """가중 표본에도 쓸 수 있게 n 은 실수(유효 표본 크기) 허용."""
    if n <= 0:
        return 0.0
    denom = 1.0 + z * z / n
    centre = p_hat + z * z / (2.0 * n)
    margin = z * math.sqrt(p_hat * (1.0 - p_hat) / n + z * z / (4.0 * n * n))
    return max(0.0, (centre - margin) / denom)


def _group_episodes(touch_idx: np.ndarray, gap: int) -> list[tuple[int, int]]:
    """터치 봉 인덱스 배열 -> (start, end) 에피소드 목록."""
    if touch_idx.size == 0:
        return []
    groups: list[tuple[int, int]] = []
    start = prev = int(touch_idx[0])
    for i in touch_idx[1:]:
        i = int(i)
        if i - prev <= gap + 1:
            prev = i
        else:
            groups.append((start, prev))
            start = prev = i
    groups.append((start, prev))
    return groups


def _episode_side(
    close: np.ndarray, ma: np.ndarray, start: int, context_bars: int
) -> Side | None:
    """에피소드 직전 봉들의 종가-MA 관계로 지지/저항 시험 방향을 정한다."""
    lo = max(0, start - context_bars)
    if lo >= start:
        return None
    diffs = close[lo:start] - ma[lo:start]
    diffs = diffs[~np.isnan(diffs)]
    if diffs.size == 0:
        return None
    mean = float(np.mean(diffs))
    if mean > 0:
        return "support"
    if mean < 0:
        return "resistance"
    return None


def _decide_outcome(
    close: np.ndarray,
    ma: np.ndarray,
    atr_arr: np.ndarray,
    band: np.ndarray,
    start: int,
    end: int,
    side: Side,
    p: EngineParams,
) -> tuple[Outcome, int | None]:
    """에피소드 시작~(끝+horizon) 안에서 반등/돌파를 판정.

    연속 반대편 마감은 터치 밴드 '바깥'에서 마감했을 때만 센다 — 밴드 안에서
    MA 를 사이에 두고 오르내리는 것은 터치의 정상적인 모습(노이즈)이지
    돌파의 증거가 아니다. 밴드 안 반대편 마감은 카운트하지도, 리셋하지도
    않는다 (가격이 원래 편으로 확실히 복귀해야 리셋).
    """
    n = len(close)
    limit = min(end + p.confirm_horizon, n - 1)
    consec_against = 0
    sign = 1.0 if side == "support" else -1.0
    for j in range(start, limit + 1):
        if np.isnan(ma[j]) or np.isnan(atr_arr[j]) or np.isnan(band[j]):
            continue
        # dist > 0 = 원래 편(지지면 위, 저항이면 아래), dist < 0 = 반대편
        dist = sign * (close[j] - ma[j])
        # 판정 문턱은 최소한 터치 밴드 밖이어야 한다 — 저변동성 종목에서
        # ATR 문턱이 밴드보다 작아지면 밴드 '안' 종가가 성급히 판정되므로.
        break_thr = max(p.break_atr_mult * atr_arr[j], band[j])
        bounce_thr = max(p.bounce_atr_mult * atr_arr[j], band[j])
        # 돌파: 반대편으로 확실히 마감
        if dist < -break_thr:
            return "break", j
        if dist < -band[j]:
            consec_against += 1
            if consec_against >= p.break_consec_closes:
                return "break", j
        elif dist >= 0:
            consec_against = 0
        # 반등: 원래 방향으로 확실히 복귀
        if dist > bounce_thr:
            return "bounce", j
    return "undecided", None


def analyze_ma(
    df: pd.DataFrame,
    period: int,
    p: EngineParams,
    window_start: int,
    half_life: float,
) -> MAStat:
    """단일 이동평균선에 대한 지지/저항 통계.

    df 는 워밍업 구간을 포함한 전체 데이터, window_start 이후의
    에피소드만 집계한다 (MA/ATR 는 전체에서 계산해 NaN 워밍업 최소화).
    """
    stat = MAStat(period=period)
    close = df["close"].to_numpy(dtype=float)
    high = df["high"].to_numpy(dtype=float)
    low = df["low"].to_numpy(dtype=float)
    n = len(close)

    # MA가 분석 구간 안에서 유효하려면 워밍업 포함 충분한 데이터 필요
    valid_bars_in_window = n - max(window_start, period, p.atr_period)
    if valid_bars_in_window < p.min_touches * 3:
        stat.insufficient_data = True
        return stat

    ma = sma(close, period)
    atr_arr = atr(high, low, close, p.atr_period)
    band = np.maximum(p.touch_atr_mult * atr_arr, p.touch_pct_floor * close)

    touch_mask = (low <= ma + band) & (high >= ma - band)
    touch_mask &= ~np.isnan(ma) & ~np.isnan(band)
    touch_idx = np.flatnonzero(touch_mask)

    # 에피소드는 전체 터치로 구성한 뒤 분석 창 안에서 끝나는 것만 집계한다.
    # (창 경계로 터치 군집을 먼저 자르면 에피소드 시작점이 군집 중간이 되어
    # 방향/판정이 뒤집힐 수 있다)
    episodes = [
        (s, e) for s, e in _group_episodes(touch_idx, p.episode_gap)
        if e >= window_start
    ]
    last_index = n - 1

    for g_start, g_end in episodes:
        # 군집에 속한 터치 봉들. 판정이 군집 중간에 확정되면 그 뒤의 터치는
        # '새로운 시험'으로 분리해 각각 독립적으로 판정한다 — 반등 확정 후
        # 다시 선까지 미끄러진 구간이 이전 성공에 흡수되는 것을 막기 위함.
        members = touch_idx[(touch_idx >= g_start) & (touch_idx <= g_end)]
        pos = 0
        while pos < len(members):
            seg_start = int(members[pos])
            side = _episode_side(close, ma, seg_start, p.trend_context_bars)
            if side is None:
                break
            outcome, decided_at = _decide_outcome(
                close, ma, atr_arr, band, seg_start, int(g_end), side, p
            )
            if outcome == "undecided" or decided_at is None:
                seg_members = [int(t) for t in members[pos:]]
                next_pos = len(members)
            else:
                seg_members = [int(t) for t in members[pos:] if t <= decided_at]
                if not seg_members:
                    seg_members = [seg_start]
                next_pos = pos + len(seg_members)
            seg_end = seg_members[-1]

            # 마커 위치: 반등 = 선을 가장 깊게 찍은 봉 / 돌파 = 확정된 봉
            if outcome == "bounce":
                anchor = (min(seg_members, key=lambda i: low[i]) if side == "support"
                          else max(seg_members, key=lambda i: high[i]))
            elif outcome == "break":
                anchor = int(decided_at)
            else:
                anchor = seg_end

            pos = next_pos
            if seg_end < window_start:
                continue  # 분석 창 밖에서 끝난 시험은 집계 제외

            weight = 0.5 ** ((last_index - seg_end) / half_life) if half_life > 0 else 1.0
            ep = TouchEpisode(start=seg_start, end=seg_end, side=side,
                              outcome=outcome, decided_at=decided_at,
                              weight=weight, anchor=anchor)
            stat.episodes.append(ep)
            stat.touches += 1
            stat.last_touch_index = seg_end
            if outcome == "bounce":
                if side == "support":
                    stat.support_bounces += 1
                else:
                    stat.resistance_bounces += 1
            elif outcome == "break":
                stat.breaks += 1
            else:
                stat.undecided += 1

    decided = [e for e in stat.episodes if e.outcome in ("bounce", "break")]
    if decided:
        w = np.array([e.weight for e in decided])
        s = np.array([1.0 if e.success else 0.0 for e in decided])
        w_sum = float(w.sum())
        p_hat = float((w * s).sum() / w_sum) if w_sum > 0 else 0.0
        n_eff = float(w_sum * w_sum / (w * w).sum()) if w_sum > 0 else 0.0
        stat.weighted_success = p_hat
        stat.wilson_lb = wilson_lower_bound(p_hat, n_eff, p.wilson_z)
        weighted_bounces = float((w * s).sum())
        stat.score = stat.wilson_lb * math.log1p(weighted_bounces)
    return stat


def _dedup_recommendations(stats: list[MAStat], ratio: float, top_n: int) -> list[MAStat]:
    """점수순으로 고르되 기간이 너무 비슷한 이평선(예: 100/120)은 상위 것만."""
    picked: list[MAStat] = []
    for s in stats:
        if any(
            abs(s.period - q.period) / max(s.period, q.period) <= ratio
            for q in picked
        ):
            continue
        picked.append(s)
        if len(picked) >= top_n:
            break
    return picked


def select_recommended(stats: list[MAStat], params: EngineParams) -> list[MAStat]:
    """자격을 갖춘 이평선을 점수순 + 기간 dedup 으로 top_n 개 선정.

    2개 미만이면 표본 부족이라도 점수순으로 채우되, 이때도 dedup 원칙을
    유지한다 — 이미 추천된 것과 기간이 비슷한 선은 건너뛰고, 비슷하지 않은
    후보가 정말 없을 때만 마지막 수단으로 허용.
    """
    ranked = sorted(
        [s for s in stats if s.qualified],
        key=lambda s: (s.score, s.touches),
        reverse=True,
    )
    recommended = _dedup_recommendations(ranked, params.dedup_ratio, params.top_n)

    if len(recommended) < 2:
        fallback = sorted(
            [s for s in stats
             if not s.insufficient_data and s.touches > 0 and s not in recommended],
            key=lambda s: (s.score, s.touches),
            reverse=True,
        )

        def similar_to_picked(s: MAStat) -> bool:
            return any(
                abs(s.period - q.period) / max(s.period, q.period) <= params.dedup_ratio
                for q in recommended
            )

        for allow_similar in (False, True):
            for s in fallback:
                if len(recommended) >= 2:
                    break
                if s in recommended:
                    continue
                if not allow_similar and similar_to_picked(s):
                    continue
                recommended.append(s)

    return recommended


@dataclass
class TimeframeReport:
    timeframe: str
    stats: list[MAStat]
    recommended: list[MAStat]
    window_start: int
    half_life: float
    params: EngineParams


def analyze_timeframe(
    df: pd.DataFrame,
    candidates: list[int],
    params: EngineParams,
    timeframe: str,
    window_start: int = 0,
) -> TimeframeReport:
    """한 타임프레임(일/주/월봉)의 전체 후보 이평선 분석.

    df: date, open, high, low, close, volume (오름차순). 워밍업 포함 전체.
    window_start: 이 인덱스 이후 구간만 백테스트 집계 대상.
    """
    n = len(df)
    window_len = max(1, n - window_start)
    half_life = float(params.half_life_bars) if params.half_life_bars else window_len / 3.0

    stats = [
        analyze_ma(df, period, params, window_start, half_life)
        for period in candidates
    ]
    for s in stats:
        s.qualified = (
            not s.insufficient_data
            and s.touches >= params.min_touches
            and s.decided >= max(2, math.ceil(params.min_touches * 0.6))
        )

    recommended = select_recommended(stats, params)

    return TimeframeReport(
        timeframe=timeframe,
        stats=stats,
        recommended=recommended,
        window_start=window_start,
        half_life=half_life,
        params=params,
    )
