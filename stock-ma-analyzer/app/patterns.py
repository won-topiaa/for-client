"""고전 차트 패턴 탐지기 (규칙 기반).

'학습된 AI 모델'이 아니라 각 패턴의 교과서 정의를 기하학적 규칙으로 옮긴
탐지기다 — 결정적이고, 어떤 근거로 매칭됐는지 수치로 설명할 수 있다.
모든 탐지는 일봉 위에서 동작하며, ATR 적응형 지그재그 피벗(추세 전환점)을
공통 기반으로 쓴다.

지원 패턴:
- head_shoulders / inv_head_shoulders : 헤드 앤 숄더 (천장형/바닥형)
- triangle                            : 삼각수렴 (대칭/상승/하락)
- cup_handle                          : 컵 앤 핸들
- stage                               : 와인스타인 4단계 (1 바닥다지기 /
                                        2 상승 / 3 천장다지기 / 4 하락)

순위 점수 = '정석 부합도' (0~100)
--------------------------------
매칭된 패턴들의 표시 순서는 문헌 기반 정석 부합도 점수로 정한다. 탐지·탈락
게이트(패턴인가/무효인가)는 이진 판정으로 먼저 돌고, 부합도는 '살아남은'
패턴들만 순위 매긴다 — 부합도가 높다고 무효 패턴이 살아나거나, 낮다고
유효 패턴이 목록에서 빠지는 일은 없다 (게이트와 채점의 엄격한 분리).

채점 방법론 (다기준 퍼지 멤버십):
- 각 품질 차원(거래량 추세·대칭성·돌파 거래량 등)의 측정값을 사다리꼴
  멤버십 함수로 0~1 부분점수화 — 교과서 이상 밴드 안은 1.0, 문헌상 나쁜
  경계에서 0 (Lo·Mamaysky·Wang 2000 의 커널 템플릿 매칭과 같은 발상의
  단순화). 단조-좋음 지표(돌파 거래량 등)는 한쪽 램프만 쓴다.
- 가중치는 각 저자(Bulkowski 2005 성과 통계·O'Neil·Weinstein·Edwards &
  Magee)가 신뢰도와 가장 강하게 연결한 요인일수록 크게 준다.
- 합산은 가중 산술평균(A)과 가중 기하평균(G)의 혼합 sqrt(A*G) — 패턴은
  '전 요건 동시 충족' 게슈탈트라, 치명적 결함 하나가 산술평균에 묻히지
  않게 기하 성분으로 끌어내린다 (다기준 의사결정의 일반화 평균).
- 측정 불가 차원(거래량 데이터 없음 등)은 0 으로 벌점하지 않고 제외 후
  가중치 재정규화 — 데이터 결측이 결함으로 둔갑하지 않게 한다.
- 원측정값은 ATR·자기 패턴 크기·거래량 평균으로 정규화해 종목·변동성
  체제가 달라도 비교 가능(scale-free)하고, 점수는 스캔 배치와 무관하게
  결정적이다 (같은 차트는 언제나 같은 점수).
"""
from __future__ import annotations

import math
import warnings
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from .analysis import atr as atr_fn, sma

PATTERN_KEYS = ("head_shoulders", "inv_head_shoulders", "triangle", "cup_handle", "stage2")


@dataclass
class PatternHit:
    pattern: str
    matched: bool
    score: float = 0.0
    summary: str = ""
    detail: dict[str, Any] = field(default_factory=dict)
    # 차트에 그릴 보조선: [{"name", "points": [(bar_idx, price), ...]}]
    overlays: list[dict[str, Any]] = field(default_factory=list)


# ---------- 공통 도구 ----------

def zigzag(close: np.ndarray, thr: np.ndarray) -> list[tuple[int, float, int]]:
    """ATR 적응형 지그재그. 반환: (봉 인덱스, 가격, +1=고점 / -1=저점)."""
    n = len(close)
    if n < 3:
        return []
    pivots: list[tuple[int, float, int]] = []
    direction = 0  # +1 고점 탐색, -1 저점 탐색, 0 미정
    ext_i, ext_p = 0, close[0]
    for i in range(1, n):
        p = close[i]
        t = thr[i] if np.isfinite(thr[i]) else 0.0
        if direction >= 0:
            if p >= ext_p:
                ext_i, ext_p = i, p
            elif ext_p - p >= t and t > 0:
                pivots.append((ext_i, float(ext_p), +1))
                direction, ext_i, ext_p = -1, i, p
        else:
            if p <= ext_p:
                ext_i, ext_p = i, p
            elif p - ext_p >= t and t > 0:
                pivots.append((ext_i, float(ext_p), -1))
                direction, ext_i, ext_p = +1, i, p
    return pivots


def _fit_line(xs: np.ndarray, ys: np.ndarray) -> tuple[float, float, float]:
    """1차 적합. 반환: (기울기, 절편, 평균절대잔차)."""
    slope, intercept = np.polyfit(xs, ys, 1)
    resid = float(np.mean(np.abs(ys - (slope * xs + intercept))))
    return float(slope), float(intercept), resid


def _prep(df: pd.DataFrame) -> dict[str, Any]:
    close = df["close"].to_numpy(float)
    high = df["high"].to_numpy(float)
    low = df["low"].to_numpy(float)
    volume = df["volume"].to_numpy(float) if "volume" in df else np.zeros(len(df))
    a = atr_fn(high, low, close, 14)
    # 워밍업 NaN 은 앞쪽 유효값으로 채움 (지그재그 문턱용)
    a = pd.Series(a).bfill().ffill().to_numpy()
    thr = np.maximum(2.5 * a, 0.03 * close)
    return {
        "close": close, "high": high, "low": low, "volume": volume, "atr": a,
        "pivots": zigzag(close, thr), "n": len(close),
    }


# ---------- 정석 부합도(0~100) 채점 도구 ----------
# 모듈 docstring 의 방법론 구현: 사다리꼴/램프 멤버십 + 가중 산술·기하 혼합.
# 부분점수 None = '측정 불가'(데이터 결측) — 벌점 없이 제외하고 재정규화한다.

def _trap(x: float, poor_lo: float, ideal_lo: float,
          ideal_hi: float, poor_hi: float) -> float | None:
    """사다리꼴 멤버십: 이상 밴드 [ideal_lo, ideal_hi] 안 1.0, poor 경계 밖 0,
    사이는 선형. 값이 유한하지 않으면 None(측정 불가)."""
    if not np.isfinite(x):
        return None
    if x <= poor_lo or x >= poor_hi:
        return 0.0
    if ideal_lo <= x <= ideal_hi:
        return 1.0
    if x < ideal_lo:
        return float((x - poor_lo) / (ideal_lo - poor_lo))
    return float((poor_hi - x) / (poor_hi - ideal_hi))


def _up(x: float, poor: float, ideal: float) -> float | None:
    """단조-상승 램프 (클수록 좋음: 돌파 거래량 배수 등). poor 이하 0, ideal 이상 1."""
    if not np.isfinite(x):
        return None
    return float(np.clip((x - poor) / (ideal - poor), 0.0, 1.0))


def _down(x: float, ideal: float, poor: float) -> float | None:
    """단조-하락 램프 (작을수록 좋음: 비대칭도·거래량 비율 등). ideal 이하 1, poor 이상 0."""
    if not np.isfinite(x):
        return None
    return float(np.clip((poor - x) / (poor - ideal), 0.0, 1.0))


def _vol_mean(volume: np.ndarray, lo: int, hi: int) -> float:
    """구간 평균 거래량 (NaN 무시). 구간이 비었거나 전부 NaN/0 이면 NaN —
    호출부의 비율 계산이 NaN 이 되어 해당 차원이 자연히 '측정 불가'로 빠진다."""
    seg = volume[max(0, lo):max(0, hi)]
    if seg.size == 0:
        return float("nan")
    with np.errstate(invalid="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        m = float(np.nanmean(seg))
    return m if np.isfinite(m) and m > 0 else float("nan")


def _conformity(dims: list[tuple[str, float, float | None]]) -> tuple[float, dict]:
    """[(차원, 가중치, 부분점수 0~1 | None)] → (정석 부합도 0~100, 세부 내역).

    None(측정 불가) 차원은 제외하고 가중치를 재정규화한다. 합산은 가중
    산술평균(A)·기하평균(G)의 혼합 sqrt(A*G) — 결함 하나가 평균에 묻히지
    않게 하되(기하 성분), 전반적 우수함도 반영한다(산술 성분)."""
    usable = [(name, w, s) for name, w, s in dims if s is not None and w > 0]
    if not usable:
        return 0.0, {}
    total_w = sum(w for _, w, _ in usable)
    arith = sum(w * s for _, w, s in usable) / total_w
    eps = 0.01  # ln(0) 방지 — 진짜 0 결함도 기하 성분을 완전히 죽이지는 않게
    geo = math.exp(sum(w * math.log(max(s, eps)) for _, w, s in usable) / total_w)
    base = math.sqrt(arith * geo)
    detail = {name: round(s, 3) for name, _, s in usable}
    # 측정 가능한 가중치 비중 — 낮으면(데이터 결측 다수) 점수 신뢰도가 낮다는 표시
    detail["_coverage"] = round(total_w / sum(w for _, w, _ in dims), 2) if dims else 0.0
    return round(100.0 * base, 1), detail


# ---------- 헤드 앤 숄더 ----------

def _hs_conformity(ctx: dict, sign: int, window: list, nk_slope: float,
                   break_bar: int | None, recovered: float | None,
                   neck_at, ref: float) -> tuple[float, dict]:
    """헤드 앤 숄더 정석 부합도 — 문헌 기반 품질 차원을 채점한다.

    천장형(sign=+1)과 바닥형(sign=-1)은 가중치가 다르다: 바닥형은 돌파
    거래량이 필수(Edwards & Magee 의 천장/바닥 비대칭 — 바닥은 거래량
    급증 없이 넥라인을 못 넘는다)라 그 비중이 가장 크고, 천장형은 세
    봉우리 거래량 감소·사전 상승 추세의 비중이 크다 (Bulkowski 2005 의
    성과 분해: 거래량 추세·돌파 거래량·넥라인 기울기·throwback)."""
    close, high, low = ctx["close"], ctx["high"], ctx["low"]
    volume, a, n = ctx["volume"], ctx["atr"], ctx["n"]
    (i1, p1, _), (t1i, t1p, _), (hi, hp, _), (t2i, t2p, _), (i3, p3, _) = window
    atr_h = max(float(a[hi]), 1e-9)

    # [사전 추세] 반전 패턴은 반전할 추세가 있어야 한다 (Edwards & Magee).
    # 천장형: 왼어깨까지 30% 이상 상승이 만점 / 바닥형: 20% 이상 하락이 만점.
    lookback = max(63, 3 * (i3 - i1))
    lb0 = max(0, i1 - lookback)
    prior = None
    if i1 - lb0 >= 30:
        if sign > 0:
            swing_low = float(np.min(low[lb0:i1]))
            prior = _up((p1 - swing_low) / swing_low, 0.05, 0.30) \
                if swing_low > 0 else None
        else:
            swing_high = float(np.max(high[lb0:i1]))
            prior = _up((swing_high - p1) / swing_high, 0.03, 0.20) \
                if swing_high > 0 else None

    # [봉우리 거래량 감소] 왼어깨 > 머리 > 오른어깨 — 고전에서 가장 강조되는
    # 거래량 신호 (Bulkowski: 오른어깨가 왼어깨보다 30% 이상 가벼우면 이상적,
    # 오른어깨로 거래량이 '늘면' 0점).
    k = int(np.clip(round(0.075 * (i3 - i1)), 2, 5))
    vol_l = _vol_mean(volume, i1 - k, i1 + k + 1)
    vol_r = _vol_mean(volume, i3 - k, i3 + k + 1)
    vol_trend = (_up((vol_l - vol_r) / vol_l, 0.0, 0.30)
                 if np.isfinite(vol_l) and np.isfinite(vol_r) else None)

    # [돌파 거래량] 완성(넥라인 이탈)된 패턴만 측정 가능. 천장형은 1.5배면
    # 만점(가벼워도 유효 — Bulkowski), 바닥형은 2배 만점에 바닥 특유의
    # 하한(0.1)을 둔다 (저거래 돌파도 자동 실패는 아님 — Bulkowski).
    bo_vol = None
    if break_bar is not None and break_bar >= 20:
        avg_v = _vol_mean(volume, break_bar - 50, break_bar)
        brk_v = _vol_mean(volume, break_bar, break_bar + 2)
        if np.isfinite(avg_v) and np.isfinite(brk_v):
            ratio = brk_v / avg_v
            if sign > 0:
                bo_vol = _up(ratio, 0.8, 1.5)
            else:
                s = _up(ratio, 0.7, 2.0)
                bo_vol = max(0.1, s) if s is not None else None

    # [머리 탈출 랠리 거래량 — 바닥형 전용] 머리로의 하락(음봉) 대비 머리
    # 탈출 랠리(양봉)의 거래량 증가 = 수요 등장의 신호 (Edwards & Magee).
    rally_vol = None
    if sign < 0 and hi - t1i >= 2 and t2i - hi >= 2:
        seg_dn = volume[t1i + 1:hi + 1][close[t1i + 1:hi + 1] < close[t1i:hi]]
        seg_up = volume[hi + 1:t2i + 1][close[hi + 1:t2i + 1] > close[hi:t2i]]
        if seg_dn.size and seg_up.size:
            dn_v = _vol_mean(seg_dn, 0, seg_dn.size)
            up_v = _vol_mean(seg_up, 0, seg_up.size)
            if np.isfinite(dn_v) and np.isfinite(up_v):
                rally_vol = _up(up_v / dn_v, 0.8, 1.5)

    # [어깨 가격 대칭] 탐지 게이트(5% 초과 탈락)의 생존 범위 안을 등급화 —
    # 1.5% 이내면 교과서적 대칭, 게이트 경계(5%)에서 0.
    sym = abs(p1 - p3) / ref
    shoulder_sym = _down(sym, 0.015, 0.05)

    # [머리 돌출] ATR 정규화 — 머리가 어깨보다 1.5 ATR 이상 높아야(낮아야)
    # 만점, 0.3 ATR 이하면 삼중천장과 구분이 안 되는 모호한 머리 (Bulkowski).
    extreme_shoulder = max(p1, p3) if sign > 0 else min(p1, p3)
    head_prom = _up(sign * (hp - extreme_shoulder) / atr_h, 0.3, 1.5)

    # [어깨 시간 대칭] 머리까지의 좌우 소요 봉수 비율 (Bulkowski 식별 지침;
    # Lo·Mamaysky·Wang 2000 도 어깨 시간 대칭을 정의에 포함).
    d_l, d_r = hi - i1, i3 - hi
    time_sym = (_up(min(d_l, d_r) / max(d_l, d_r), 0.33, 0.75)
                if min(d_l, d_r) > 0 else 0.0)

    # [넥라인 기울기] 천장형은 수평~완만한 하향이 유리 (Bulkowski: 하향
    # 넥라인이 더 큰 하락), 바닥형은 거울상(완만한 상향 유리). sign 을 곱해
    # 한 밴드로 판정한다.
    neck = _trap(sign * (nk_slope / atr_h), -0.25, -0.10, 0.02, 0.10)

    # [되돌림 없음] 완성 후 가격이 넥라인 쪽으로 얼마나 회복했나 — 넥라인
    # 0.5 ATR 밖에서 멈추면 만점, 넥라인에 닿으면 0 (Bulkowski: throwback
    # 없는 패턴이 더 멀리 간다). recovered 는 넥라인 대비 비율이라 ATR 로 환산.
    throwback = None
    if break_bar is not None and recovered is not None:
        neck_b = abs(float(neck_at(break_bar)))
        atr_b = max(float(a[break_bar]), 1e-9)
        throwback = _down(recovered * neck_b / atr_b, -0.5, 0.0)

    if sign > 0:
        dims = [
            ("prior_trend", 0.85, prior), ("vol_trend", 0.90, vol_trend),
            ("breakout_vol", 0.60, bo_vol), ("shoulder_sym", 0.70, shoulder_sym),
            ("head_prom", 0.65, head_prom), ("time_sym", 0.45, time_sym),
            ("neckline", 0.50, neck), ("no_throwback", 0.55, throwback),
        ]
    else:
        dims = [
            ("prior_trend", 0.75, prior), ("vol_trend", 0.60, vol_trend),
            ("breakout_vol", 1.00, bo_vol), ("rally_vol", 0.60, rally_vol),
            ("shoulder_sym", 0.55, shoulder_sym), ("head_prom", 0.70, head_prom),
            ("time_sym", 0.40, time_sym), ("neckline", 0.45, neck),
            ("no_throwback", 0.50, throwback),
        ]
    return _conformity(dims)


def detect_head_shoulders(ctx: dict, inverse: bool = False) -> PatternHit:
    key = "inv_head_shoulders" if inverse else "head_shoulders"
    close, n = ctx["close"], ctx["n"]
    sign = -1 if inverse else +1
    # 역헤드앤숄더는 저점 3개(-1), 정형은 고점 3개(+1) 가 골격
    want = [sign, -sign, sign, -sign, sign]
    pivots = ctx["pivots"]
    best: PatternHit | None = None
    for i in range(len(pivots) - 4):
        window = pivots[i:i + 5]
        if [k for _, _, k in window] != want:
            continue
        (i1, p1, _), (t1i, t1p, _), (hi, hp, _), (t2i, t2p, _), (i3, p3, _) = window
        if i3 < n - 90:  # 오른어깨가 최근 90봉 안이어야 '지금' 유효
            continue
        # 분모는 넥라인(되돌림 저/고점 평균 = 돌파 기준 가격대). 머리 가격을
        # 쓰면 머리가 깊은 역H&S 에서 밴드가 비정상적으로 좁아져, 정형과
        # 거울상인 역형이 같은 기하인데도 탈락한다 (dist_now 5% 룰과 동일 이유).
        ref = max(abs(t1p + t2p) / 2, 1e-9)
        # 머리가 양쪽 어깨보다 유의미하게 돌출 (3% 이상)
        prom1 = sign * (hp - p1) / ref
        prom3 = sign * (hp - p3) / ref
        if prom1 < 0.03 or prom3 < 0.03:
            continue
        # 어깨 높이 대칭 (넥라인 대비 5% 이내)
        sym = abs(p1 - p3) / ref
        if sym > 0.05:
            continue
        # 넥라인 (두 되돌림점 연결), 과한 기울기 배제
        nk_slope = (t2p - t1p) / max(t2i - t1i, 1)
        if abs(nk_slope) * (n - t1i) / ref > 0.10:
            continue
        neck_now = t1p + nk_slope * (n - 1 - t1i)
        # 탈락 기준 1 (busted 패턴, Bulkowski 2005): 가격이 머리를 넘어 회복하면
        # 패턴 무효 — 천장형은 머리 위 종가, 바닥형은 머리 아래 종가.
        if sign * (hp - close[-1]) <= 0:
            continue
        # 분모는 넥라인(=돌파 기준가) — 5% 룰이 돌파가 기준이기 때문. 머리를
        # 분모로 쓰면 머리가 깊은 역H&S에서 밴드가 비정상적으로 좁아진다.
        dist_now = sign * (close[-1] - neck_now) / max(abs(neck_now), 1e-9)

        # 완성(넥라인 종가 이탈) '시점'을 추적한다. 현재 거리만 보면 이미
        # 완성돼 소진된 패턴이 가격 회복으로 밴드에 재진입해 되살아나는
        # 무기억(memoryless) 함정이 생긴다. 오른어깨 이후 첫 넥라인 종가
        # 이탈 봉 = 완성 시점 (Lo·Mamaysky·Wang 2000 의 completion 정의).
        def _neck_at(j: int) -> float:
            return t1p + nk_slope * (j - t1i)

        break_bar = None
        for j in range(i3 + 1, n):
            if sign * (close[j] - _neck_at(j)) < 0:
                break_bar = j
                break

        recovered: float | None = None
        if break_bar is None:
            # [미완성 = 넥라인 접근 중] 몸통 한복판(넥라인 +6% 초과)이면 아직
            # 이르다 — 넥라인 부근까지 온 형태만 실전 의미가 있음.
            if dist_now > 0.06:
                continue
            state = "넥라인 접근 중"
        else:
            since = n - 1 - break_bar
            # 탈락 기준 2 (신호 소진): 완성 후 10봉 초과 경과 — 패턴 정보력은
            # 완성 직후에 집중되고(Lo·Mamaysky·Wang 2000), 되돌림(throwback)도
            # 평균 ~10일 안에 넥라인으로 돌아온다 (Bulkowski 2005).
            if since > 10:
                continue
            # 탈락 기준 3 (실패 돌파): 완성 후 종가가 넥라인 반대편(몸통 쪽)으로
            # 2% 넘게 회복 — 정상 되돌림은 넥라인 '부근까지'다 (Bulkowski 2005).
            recovered = max(
                sign * (close[j] - _neck_at(j)) / max(abs(_neck_at(j)), 1e-9)
                for j in range(break_bar, n)
            )
            if recovered > 0.02:
                continue
            # 탈락 기준 4 (5% 룰): 돌파 방향으로 5% 넘게 이미 진행 — 진입 늦음.
            if dist_now < -0.05:
                continue
            state = f"넥라인 이탈 {since}봉 전"

        # 정석 부합도 (0~100) — 게이트를 통과한 후보만 채점해 순위를 정한다
        score, conf = _hs_conformity(ctx, sign, window, nk_slope,
                                     break_bar, recovered, _neck_at, ref)
        head_txt = f"{hp:,.0f}"
        sym_score = max(0.0, 100 - sym / 0.05 * 100)  # 0(허용 한계)~100(완전 대칭)
        summary = (
            f"{'바닥' if inverse else '천장'} 머리 {head_txt} · "
            f"어깨 대칭 {sym_score:.0f}점 · 넥라인 {neck_now:,.0f} · {state}"
        )
        hit = PatternHit(
            pattern=key, matched=True, score=score,
            summary=summary,
            detail={"head": hp, "shoulders": [p1, p3], "neckline": neck_now,
                    "state": state, "conformity": conf},
            overlays=[
                {"name": "넥라인", "points": [(t1i, t1p), (n - 1, neck_now)]},
                {"name": "골격", "points": [(i1, p1), (t1i, t1p), (hi, hp),
                                            (t2i, t2p), (i3, p3)]},
            ],
        )
        if best is None or hit.score > best.score:
            best = hit
    return best or PatternHit(pattern=key, matched=False)


# ---------- 삼각수렴 ----------

def detect_triangle(ctx: dict) -> PatternHit:
    close, n = ctx["close"], ctx["n"]
    win_start = max(0, n - 130)
    pivots = [p for p in ctx["pivots"] if p[0] >= win_start]
    highs = [(i, p) for i, p, k in pivots if k > 0]
    lows = [(i, p) for i, p, k in pivots if k < 0]
    if len(highs) < 2 or len(lows) < 2 or len(highs) + len(lows) < 5:
        return PatternHit(pattern="triangle", matched=False)
    hx = np.array([i for i, _ in highs], float)
    hy = np.array([p for _, p in highs], float)
    lx = np.array([i for i, _ in lows], float)
    ly = np.array([p for _, p in lows], float)
    su, bu, ru = _fit_line(hx, hy)   # 상단 저항선
    sl, bl, rl = _fit_line(lx, ly)   # 하단 지지선
    price = float(np.mean(close[win_start:]))
    atr_mean = float(np.mean(ctx["atr"][win_start:]))
    # 피벗들이 추세선에 잘 붙어야 함
    if ru > 1.6 * atr_mean or rl > 1.6 * atr_mean:
        return PatternHit(pattern="triangle", matched=False)
    x0, x1 = float(min(hx.min(), lx.min())), float(n - 1)
    w0 = (su * x0 + bu) - (sl * x0 + bl)
    w1 = (su * x1 + bu) - (sl * x1 + bl)
    if w0 <= 0 or w1 <= 0:
        return PatternHit(pattern="triangle", matched=False)
    ratio = w1 / w0
    # 0.80 상한: 뚜렷하게 좁아지는 중이어야 함.
    # 0.15 하한 = 탈락 기준 (꼭짓점 소멸): 폭이 처음의 15% 미만(≈꼭짓점까지
    # 85% 이상 진행)인데 돌파가 없으면 예측력이 소멸 — 삼각형 돌파는 평균적으로
    # 꼭짓점까지 약 73~75% 지점에서 발생하고, 꼭짓점에 닿도록 못 뚫으면
    # 실패 경향 (Bulkowski, Encyclopedia of Chart Patterns 2005).
    if not (0.15 <= ratio <= 0.80):
        return PatternHit(pattern="triangle", matched=False)
    # 유형 분류 (기울기를 %/봉으로 정규화)
    nu = su / price * 100
    nl = sl / price * 100
    eps = 0.02
    if nu < -eps and nl > eps:
        kind = "대칭 삼각수렴"
    elif abs(nu) <= eps and nl > eps:
        kind = "상승 삼각형 (수평 저항 + 저점 상승)"
    elif nu < -eps and abs(nl) <= eps:
        kind = "하락 삼각형 (수평 지지 + 고점 하락)"
    else:
        return PatternHit(pattern="triangle", matched=False)
    # 탈락 기준 (이탈 = 돌파 완료): 종가가 추세선 밖으로 1 ATR 넘게 나가면
    # 이미 돌파가 일어난 것 — '수렴 중' 후보에서 제외한다. ±1 ATR 여유는
    # 돌파 직전의 노이즈성 삐져나옴(premature breakout, Bulkowski 2005)을 허용.
    up_now, lo_now = su * x1 + bu, sl * x1 + bl
    if not (lo_now - atr_mean <= close[-1] <= up_now + atr_mean):
        return PatternHit(pattern="triangle", matched=False)

    # ── 정석 부합도 채점 ──
    volume = ctx["volume"]
    x0i = int(x0)

    # [추세선 터치 수] 선당 3회 이상이 교과서 최소+이상 (Bulkowski/Edwards &
    # Magee: 각 선에 2회는 최소, 3회 이상이어야 진짜 수렴). 지그재그 피벗은
    # 정의상 고저 교대라 교대성은 자동 충족 — 개수만 등급화한다.
    touches = _up(float(min(len(highs), len(lows))), 1.0, 3.0)

    # [수렴 기간 거래량 감소] 대칭 삼각형의 ~86%에서 관찰되는 하향 거래량
    # (Bulkowski) — 마지막 1/3 평균이 처음 1/3 의 55% 이하면 만점, 늘었으면 0.
    # 회귀 기울기가 양수면(감소 추세가 아님) 30% 감점.
    vol_contract = None
    span = n - x0i
    if span >= 15:
        third = span // 3
        v_first = _vol_mean(volume, x0i, x0i + third)
        v_last = _vol_mean(volume, n - third, n)
        if np.isfinite(v_first) and np.isfinite(v_last):
            vol_contract = _down(v_last / v_first, 0.55, 1.05)
            if vol_contract is not None and vol_contract > 0:
                seg = volume[x0i:n]
                fin = np.isfinite(seg)
                if fin.sum() >= 6 and float(np.polyfit(
                        np.flatnonzero(fin), seg[fin], 1)[0]) >= 0:
                    vol_contract *= 0.7

    # [꼭짓점 진행도] 폭이 선형으로 좁아지므로 진행도 = 1 - 폭비율. 돌파는
    # 평균적으로 꼭짓점까지 60~78% 지점에 몰린다 (Bulkowski ~73%) — 그
    # 밴드가 만점, 게이트 경계(85% = 폭 15%)에서 0.
    progress = _trap(1.0 - ratio, 0.35, 0.60, 0.78, 0.85)

    # [추세선 밀착도] 피벗이 추세선에 얼마나 붙어 있나 (ATR 정규화 평균 잔차).
    # 0.5 ATR 이내면 만점, 게이트 경계(1.6 ATR)에서 0.
    fit = _down(((ru + rl) / 2) / max(atr_mean, 1e-9), 0.5, 1.6)

    # [유형 정합] 대칭: 두 선의 기울기 크기가 비슷(0.70 이상이 만점) /
    # 상승·하락: 수평선이 진짜 수평(가파른 선의 15% 이하면 만점).
    if kind.startswith("대칭"):
        shape = _up(min(abs(nu), abs(nl)) / max(abs(nu), abs(nl), 1e-9), 0.33, 0.70)
    elif kind.startswith("상승"):
        shape = _down(abs(nu) / max(abs(nl), 1e-9), 0.15, 1.0)
    else:
        shape = _down(abs(nl) / max(abs(nu), 1e-9), 0.15, 1.0)

    # [최근 거래량 마름] 꼭짓점 부근의 침묵 — 돌파 직전 거래량 고갈이 고품질
    # 돌파에 선행 (O'Neil·Edwards & Magee). 최근 5봉 / 패턴 전체 평균.
    v_whole = _vol_mean(volume, x0i, n)
    v_tail = _vol_mean(volume, n - 5, n)
    dryup = (_down(v_tail / v_whole, 0.50, 1.10)
             if np.isfinite(v_whole) and np.isfinite(v_tail) else None)

    # [유형 신뢰도 사전값] Bulkowski 성과 통계: 상승 삼각형이 최상(상방 돌파
    # ~63%·이탈 실패율 낮음), 대칭은 양방향, 하락이 최하.
    prior = (1.0 if kind.startswith("상승")
             else 0.85 if kind.startswith("대칭") else 0.78)

    score, conf = _conformity([
        ("touches", 0.90, touches), ("vol_contract", 0.90, vol_contract),
        ("apex_progress", 0.85, progress), ("line_fit", 0.70, fit),
        ("shape", 0.65, shape), ("vol_dryup", 0.55, dryup),
        ("type_prior", 0.30, prior),
    ])
    return PatternHit(
        pattern="triangle", matched=True, score=score,
        summary=f"{kind} · 폭 {ratio * 100:.0f}%까지 수렴 · 꼭짓점 접근 중",
        detail={"ratio": ratio, "kind": kind, "conformity": conf},
        overlays=[
            {"name": "저항선", "points": [(int(x0), su * x0 + bu), (n - 1, up_now)]},
            {"name": "지지선", "points": [(int(x0), sl * x0 + bl), (n - 1, lo_now)]},
        ],
    )


# ---------- 컵 앤 핸들 ----------

def detect_cup_handle(ctx: dict) -> PatternHit:
    close, n = ctx["close"], ctx["n"]
    best: PatternHit | None = None
    rims = [(i, p) for i, p, k in ctx["pivots"] if k > 0 and i < n - 40]
    for li, lp in rims:
        if lp <= 0:
            continue  # 방어: 테두리 가격 0 이면 depth 계산이 0으로 나눠진다
        # 컵의 오른쪽 테두리: '바닥 이후' 왼쪽 테두리의 95% 이상 회복한 첫 지점.
        # 테두리 직후 20봉 뒤 첫 교차만 보면, 완만하게 내려가는 얕은 컵은
        # 하락이 끝나기도 전의 가짜 회복점(아직 95% 위)에 걸려 길이 미달로
        # 영영 탐지되지 않는다 — 바닥(argmin)을 먼저 찾고 그 뒤를 검색한다.
        seg = close[li:]
        if seg.size < 21:
            continue
        bot_rel = int(np.argmin(seg))
        search_from = max(bot_rel, 20)
        rel = np.flatnonzero(seg[search_from:] >= lp * 0.95)
        if rel.size == 0:
            continue
        ri = li + search_from + int(rel[0])
        length = ri - li
        if not (30 <= length <= 220) or n - 1 - ri > 45:
            continue
        cup = close[li:ri + 1]
        bottom = float(cup.min())
        depth = (lp - bottom) / lp
        if not (0.12 <= depth <= 0.50):
            continue
        bpos = int(np.argmin(cup)) / length
        if not (0.25 <= bpos <= 0.75):  # 바닥이 가운데 있어야 U자
            continue
        # 둥근 바닥: 2차 곡선 적합도
        xs = np.linspace(-1, 1, len(cup))
        coef = np.polyfit(xs, cup, 2)
        fit = np.polyval(coef, xs)
        ss_res = float(np.sum((cup - fit) ** 2))
        ss_tot = float(np.sum((cup - cup.mean()) ** 2)) or 1.0
        r2 = 1 - ss_res / ss_tot
        # 위로 볼록(∪)이 아니면 컵이 아니고, 적합도가 노이즈 수준이면 배제.
        if coef[0] <= 0 or r2 < 0.70:
            continue
        # V자 배제: 대칭 V 는 2차 적합도가 0.94 수준까지 올라가 단순 r² 문턱을
        # 넘어버린다. 그래서 같은 바닥을 'V-모델'(꼭짓점 절댓값 선형)로도
        # 맞춰 보고, 포물선이 V 보다 확실히 더 잘 맞을 때만 둥근 컵으로 본다
        # (V 는 V-모델이 r²≈1 로 이기고, 진짜 ∪ 는 포물선이 이긴다).
        vx = xs[int(np.argmin(cup))]
        vfeat = np.abs(xs - vx)
        vA = np.vstack([vfeat, np.ones_like(vfeat)]).T
        (va, vb), *_ = np.linalg.lstsq(vA, cup, rcond=None)
        r2_v = 1 - float(np.sum((cup - (va * vfeat + vb)) ** 2)) / ss_tot
        if r2 <= r2_v:  # V(또는 직선)가 포물선만큼/더 잘 맞으면 둥근 바닥 아님
            continue
        # 핸들: 테두리 회복 후 얕은 되돌림, 현재가는 테두리 부근.
        # 탈락 기준 1 (핸들 붕괴, O'Neil 1988): 핸들 조정이 컵 깊이의 50% 를
        # 넘거나(컵 하반부 침범) 15% 를 넘으면 패턴 무효.
        handle = close[ri:]
        h_low = float(handle.min())
        h_depth = (close[ri] - h_low) / lp
        if h_depth > depth * 0.5 or h_depth > 0.15:
            continue
        # 탈락 기준 2: 테두리 -15% 아래로 무너지면 패턴 실패, 테두리 +5% 를
        # 넘게 이미 상승했으면 추격 구간 (O'Neil 의 매수점 규칙: 피벗 +5% 이내).
        if not (lp * 0.85 <= close[-1] <= lp * 1.05):
            continue
        # ── 정석 부합도 채점 (오닐의 컵앤핸들 규칙 기반) ──
        volume, low = ctx["volume"], ctx["low"]

        # [사전 상승 추세] 지속 패턴의 전제 — 컵 이전 30% 이상 상승이 만점
        # (오닐: 베이스 앞에 유의미한 상승이 있어야 한다), 10% 이하는 0.
        prior = None
        look = int(np.clip(length, 120, 250))
        lb0 = max(0, li - look)
        if li - lb0 >= 20:
            pre_low = float(np.min(low[lb0:li]))
            prior = _up((lp - pre_low) / pre_low, 0.10, 0.30) if pre_low > 0 else None

        # [컵 깊이] 오닐 이상 밴드 12~33% 만점, 게이트 경계(50%)에서 0 —
        # 너무 얕으면 흔들어 털기(shakeout)가 없고, 깊으면 실손상 (Bulkowski).
        dep = _trap(depth, 0.06, 0.12, 0.33, 0.50)

        # [둥근 바닥] 2차 적합도(게이트 0.70 위를 등급화, 0.88 이상 만점) 70% +
        # 바닥이 컵 중앙(40~60%)에 있는지 30% (오닐: U자, V자 아님).
        rd_r2 = _up(r2, 0.70, 0.88)
        rd_pos = _trap(bpos, 0.25, 0.40, 0.60, 0.75)
        roundness = (0.7 * rd_r2 + 0.3 * rd_pos
                     if rd_r2 is not None and rd_pos is not None else None)

        # [컵 기간] 오닐 7~35주(35~175봉)가 핵심 밴드 — 게이트(30~220) 안을 등급화.
        duration = _trap(float(length), 30.0, 35.0, 175.0, 220.0)

        # [핸들 위치·기울기] 오닐의 최우선 판별: 핸들은 컵 '상단 절반'에서
        # 완만히 '하향'해야 한다 (하단 절반 핸들·상향 쐐기 핸들 = 불량 베이스).
        h_frac = (h_low - bottom) / max(lp - bottom, 1e-9)
        place = _up(h_frac, 0.35, 0.65)
        drift = None
        if handle.size >= 5:
            slope_h = float(np.polyfit(np.arange(handle.size), handle, 1)[0])
            drift_pct = slope_h * (handle.size - 1) / max(float(close[ri]), 1e-9)
            drift = _trap(drift_pct, -0.20, -0.12, -0.005, 0.03)
        hp_dim = (0.6 * place + 0.4 * drift if place is not None and drift is not None
                  else place)

        # [핸들 깊이] 5~15%가 이상적(게이트가 15%에서 자름), 5% 미만은 털기
        # 부족으로 절반부터 시작하는 완만한 감점 (오닐: 핸들 되돌림 ~10-15%).
        hd_dim = 1.0 if h_depth >= 0.05 else 0.5 + (max(h_depth, 0.0) / 0.05) * 0.5

        # [핸들 거래량 마름] 핸들에서 거래량이 컵 평균의 60% 이하로 마르면
        # 만점 — 매도세 소진의 신호 (오닐), 오히려 늘면(1.2배) 0.
        h_vol = _vol_mean(volume, ri, n)
        c_vol = _vol_mean(volume, li, ri)
        hv_dim = (_down(h_vol / c_vol, 0.60, 1.20)
                  if np.isfinite(h_vol) and np.isfinite(c_vol) else None)

        # [돌파 거래량] 테두리(피벗) 상향 돌파가 이미 나왔으면 그 봉의 거래량
        # 급증을 채점 (오닐: 평균의 40% 이상 증가 필수) — 아직 돌파 전이면
        # 측정 불가로 제외 (돌파 전 접근 상태도 유효한 매수 준비 구간).
        bo_dim = None
        after = np.flatnonzero(close[ri:] > lp)
        if after.size:
            bj = ri + int(after[0])
            if bj >= 20:
                avg_v = _vol_mean(volume, bj - 50, bj)
                with np.errstate(invalid="ignore"), warnings.catch_warnings():
                    warnings.simplefilter("ignore", RuntimeWarning)
                    brk_v = float(np.nanmax(volume[bj:bj + 2]))
                if np.isfinite(avg_v) and np.isfinite(brk_v) and brk_v > 0:
                    bo_dim = _up(brk_v / avg_v, 1.0, 1.4)

        score, conf = _conformity([
            ("prior_trend", 0.85, prior), ("cup_depth", 0.80, dep),
            ("roundness", 0.60, roundness), ("duration", 0.40, duration),
            ("handle_place", 0.85, hp_dim), ("handle_depth", 0.70, hd_dim),
            ("handle_vol", 0.65, hv_dim), ("breakout_vol", 0.90, bo_dim),
        ])
        hit = PatternHit(
            pattern="cup_handle", matched=True, score=score,
            summary=(f"컵 깊이 {depth * 100:.0f}% · 둥근바닥 적합도 {r2 * 100:.0f}% · "
                     f"핸들 조정 {h_depth * 100:.1f}% · 테두리 {lp:,.0f}"),
            detail={"rim": lp, "depth": depth, "r2": r2, "handle_depth": h_depth,
                    "conformity": conf},
            overlays=[{"name": "컵 테두리", "points": [(li, lp), (n - 1, lp)]}],
        )
        if best is None or hit.score > best.score:
            best = hit
    return best or PatternHit(pattern="cup_handle", matched=False)


# ---------- 와인스타인 4단계 ----------

STAGE_NAMES = {1: "1단계 (바닥 다지기)", 2: "2단계 (상승 추세)",
               3: "3단계 (천장 다지기)", 4: "4단계 (하락 추세)"}


def detect_stage(ctx: dict) -> PatternHit:
    """30주선(≈150일선) 기울기와 가격 위치로 현재 단계를 분류."""
    close, n = ctx["close"], ctx["n"]
    if n < 220:
        return PatternHit(pattern="stage", matched=False,
                          summary="데이터 부족 (150일선 계산 불가)")
    ma150 = sma(close, 150)
    ma_now, ma_m1 = ma150[-1], ma150[-22]
    slope_m = (ma_now / ma_m1 - 1)          # 최근 1개월 기울기
    ma_q = ma150[-66] if n >= 216 else ma_m1
    prior = (ma_m1 / ma_q - 1)              # 그 이전 분기 흐름 (전 단계 문맥)
    pos = close[-1] / ma_now - 1
    # 최근 40봉 동안 가격이 150일선을 몇 번 넘나들었나 (횡보 판별)
    diffs = np.sign(close[-40:] - ma150[-40:])
    crosses = int(np.sum(diffs[1:] != diffs[:-1]))
    flat = abs(slope_m) < 0.005

    if flat and crosses >= 3:
        stage = 3 if prior > 0.01 else 1
        conf = min(1.0, crosses / 6) * (1 - abs(slope_m) / 0.005 * 0.3)
    elif slope_m >= 0.005 and pos > 0:
        stage, conf = 2, min(1.0, slope_m / 0.02) * 0.6 + min(0.4, pos)
    elif slope_m <= -0.005 and pos < 0:
        stage, conf = 4, min(1.0, -slope_m / 0.02) * 0.6 + min(0.4, -pos)
    elif pos > 0:
        # 하락 중인 30주선 '위'로 올라온 상태 = 바닥 전환 시도 (1단계).
        # 선이 이미 오르고 있을 때만 2단계로 본다 (와인스타인 정의).
        stage, conf = (1, 0.3) if slope_m < 0 else (2, 0.3)
    else:
        # 상승 중인 선 '아래'로 내려간 상태 = 천장 형성 신호 (3단계)
        stage, conf = (3, 0.3) if slope_m > 0 else (4, 0.3)
    # 52주 신고가 근접도 (2단계 초입 판별에 유용)
    yr = close[-min(250, n):]
    near_high = close[-1] / float(yr.max())
    if stage == 2:
        conf += max(0.0, near_high - 0.85)
    summary = (f"{STAGE_NAMES[stage]} · 150일선 월기울기 {slope_m * 100:+.1f}% · "
               f"이격 {pos * 100:+.1f}% · 52주고점 대비 {near_high * 100:.0f}%")
    idx0 = max(0, n - 260)
    return PatternHit(
        pattern="stage", matched=True, score=round(float(conf), 4),
        summary=summary,
        detail={"stage": stage, "slope_month": slope_m, "pos": pos,
                "near_52w_high": near_high},
        overlays=[{"name": "150일선(≈30주선)",
                   "points": [(i, float(ma150[i])) for i in range(idx0, n, 5)
                              if np.isfinite(ma150[i])]}],
    )


def detect_stage2_early(ctx: dict, index_close: np.ndarray | None = None) -> PatternHit:
    """와인스타인 '초기 2단계' — 이론상 손익비가 가장 좋은 매수 국면.

    와인스타인(1988)의 실전 기준을 그대로 옮김:
    1. 1단계 베이스(박스권)의 상단을 최근에 상향 돌파
    2. 돌파 거래량이 베이스 평균의 1.3배 이상 (2배 이상이면 교과서적)
    3. 30주선(≈150일선)이 하락/횡보에서 '막' 상승으로 전환
    4. 아직 확장되지 않음 — 돌파가 최근이고 이격이 크지 않음 (추격 아님)
    5. (보너스) 시장 지수 대비 상대강도(RS) 양전환
    """
    key = "stage2"
    close, volume, n = ctx["close"], ctx["volume"], ctx["n"]
    if n < 260:
        return PatternHit(pattern=key, matched=False, summary="데이터 부족")
    ma = sma(close, 150)
    # 탈락 기준 1 (와인스타인의 매도 규칙): 종가가 30주선 아래면 2단계가 아니다
    # — 그의 손절 기준이 '30주선 하향 이탈'이므로 그 즉시 후보에서 제외.
    if not np.isfinite(ma[-1]) or close[-1] <= ma[-1]:
        return PatternHit(pattern=key, matched=False)
    # 조건 3: 30주선 신선한 상승 전환 (지금은 오르고, 3~4개월 전엔 아니었음)
    # ma[-88] 은 n >= 238 이면 유한 — 그 아래에서만 신선도 검사를 생략한다
    slope_now = ma[-1] / ma[-22] - 1
    slope_prev = (ma[-66] / ma[-88] - 1) if n >= 238 else 0.0
    if slope_now < 0.004 or slope_prev > 0.004:
        return PatternHit(pattern=key, matched=False)

    # 조건 1: 최근 60봉 안의 '베이스 상단 돌파' 탐색
    best = None
    for b in range(max(160, n - 60), n):
        base = close[b - 130:b - 5]
        if base.size < 60:
            continue
        base_high, base_low = float(base.max()), float(base.min())
        if base_low <= 0 or (base_high - base_low) / base_low > 0.35:
            continue  # 박스가 아니라 추세 구간
        if close[b] <= base_high or close[b - 1] > base_high:
            continue  # b 가 '첫' 돌파 봉이어야 함
        # 조건 2: 돌파 거래량 확인 — NaN 거래량이 섞여도 필터가 뚫리거나
        # (NaN < 1.3 은 False) 정상 돌파가 죽지 않도록 nan-안전하게 계산하고
        # 긍정형(>=)으로 판정한다.
        with np.errstate(invalid="ignore"), warnings.catch_warnings():
            # 전 구간 NaN 이면 nanmean 이 'Mean of empty slice' 경고와 함께
            # NaN 을 돌려준다 — 아래에서 isfinite 로 걸러지므로 경고만 끈다
            warnings.simplefilter("ignore", RuntimeWarning)
            base_vol = float(np.nanmean(volume[b - 130:b - 5]))
            brk_vol = float(np.nanmean(volume[b:min(b + 5, n)]))
        vol_ratio = (
            brk_vol / base_vol
            if np.isfinite(brk_vol) and np.isfinite(base_vol) and base_vol > 0
            else 0.0
        )
        if not (vol_ratio >= 1.3):
            continue
        # 조건 4: 아직 초기 — 현재가가 돌파선의 +25% 이내.
        # 탈락 기준 2 (실패 돌파): 종가가 돌파선 3% 아래로 되밀리면 돌파가
        # 유지되지 못한 것 (와인스타인: 돌파는 지지로 바뀌어야 한다).
        # 탈락 기준 3 (확장): +25% 초과는 더 이상 '초기'가 아님 — 추격 배제.
        ext = close[-1] / base_high - 1
        if not (-0.03 <= ext <= 0.25):
            continue
        cand = (b, base_high, vol_ratio, ext)
        if best is None or b > best[0]:
            best = cand
    if best is None:
        return PatternHit(pattern=key, matched=False)
    b, base_high, vol_ratio, ext = best

    # 조건 5(보너스): 6개월 상대강도 vs 지수 — 맨스필드 RS 의 근사.
    # 와인스타인: RS 가 0선 위(양수)이며 '상승 중'이어야 확증. 지수 대비
    # 뒤처지는(RS<=0) 종목은 오닐·와인스타인 모두 거부 → 0점.
    rs_txt = ""
    rs_dim: float | None = None
    if index_close is not None and len(index_close) >= 126 and n >= 126:
        stock_r = close[-1] / close[-126] - 1
        idx_r = float(index_close[-1] / index_close[-126]) - 1
        rs = stock_r - idx_r
        rs_txt = f" · RS {'+' if rs > 0 else ''}{rs * 100:.0f}%p"
        if rs <= 0:
            rs_dim = 0.0
        else:
            pos_c = min(rs / 0.10, 1.0)   # 6개월 +10%p 초과성과면 만점
            if len(index_close) >= 147 and n >= 147:
                # 20일 전의 같은 6개월 RS 와 비교해 '상승 중' 여부를 등급화
                rs_prev = ((close[-21] / close[-147] - 1)
                           - (float(index_close[-21] / index_close[-147]) - 1))
                rise_c = float(np.clip((rs - rs_prev) / 0.05, 0.0, 1.0))
            else:
                rise_c = 0.5  # 판단 근거 부족 — 중립
            rs_dim = 0.5 * pos_c + 0.5 * rise_c

    days_ago = n - 1 - b

    # ── 정석 부합도 채점 (와인스타인·오닐 기준) ──
    volume_arr, atr_arr = volume, ctx["atr"]

    # [돌파 거래량] 와인스타인 '돌파에서 거래량은 극적으로 늘어야'(경험칙
    # ~2배), 오닐 최소 +40~50%. 2배 이상 만점 — 게이트(1.3배)의 생존자는
    # 최소 0.3 부터 시작한다.
    bo_dim = _up(vol_ratio, 1.0, 2.0)

    # [30주선 위치·기울기] 2단계의 정의 자체 — 종가가 30주선 0~8% 위(만점),
    # +25% 이상 이격은 과열(0점) × 선의 상승 기울기(월 +2% 이상 만점). 둘의
    # 곱: 어느 한쪽이 나쁘면 전체가 깎인다 (와인스타인의 결합 조건).
    pos = float(close[-1] / ma[-1] - 1)
    pos_c = _trap(pos, -1e-9, 0.0, 0.08, 0.25)
    slope_c = _up(slope_now, 0.0, 0.02)
    ma_dim = (pos_c * slope_c if pos_c is not None and slope_c is not None else None)

    # [전환 신선도] 30주선이 상승으로 돌아선 지 25봉(~5주) 이내면 초기
    # 2단계(만점), 75봉(~15주) 이상이면 중·후기 (와인스타인: 2단계 '초입'이
    # 손익비 최적).
    dm = np.diff(ma)
    fin = np.isfinite(dm)
    nonpos = np.flatnonzero(fin & (dm <= 0))
    t_turn = float(len(dm) - 1 - nonpos[-1]) if nonpos.size else float(fin.sum())
    fresh_dim = _down(t_turn, 25.0, 75.0)

    # [피벗 근접] 오닐의 5% 룰 — 돌파선 위 0~5%가 매수 구간(만점), +15%
    # 이상 추격은 0점 (게이트는 +25%까지 허용하나 순위는 뒤로 밀린다).
    prox_dim = _trap(ext, -0.03, 0.0, 0.05, 0.15)

    # [베이스 품질] (a) 타이트함: 베이스 구간 평균 ATR 이 가격의 4% 이하면
    # 만점, 8% 이상(느슨·급등락 박스)이면 0 (오닐: 타이트한 마감이 강함).
    # (b) 베이스 후반 거래량 마름 (오닐의 dry-up) — 마지막 구간이 전체
    # 평균의 85% 이하면 만점.
    b0, b1 = b - 130, b - 5
    base_close = close[b0:b1]
    base_atr = atr_arr[b0:b1]
    tight = None
    if base_close.size and np.isfinite(base_atr).any():
        with np.errstate(invalid="ignore"), warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            atr_pct = float(np.nanmean(base_atr)) / max(float(np.nanmean(base_close)), 1e-9)
        tight = _down(atr_pct, 0.04, 0.08)
    late_v = _vol_mean(volume_arr, b - 30, b1)
    base_v = _vol_mean(volume_arr, b0, b1)
    dry = (_down(late_v / base_v, 0.85, 1.00)
           if np.isfinite(late_v) and np.isfinite(base_v) else None)
    if tight is not None and dry is not None:
        base_dim: float | None = 0.6 * tight + 0.4 * dry
    else:
        base_dim = tight if tight is not None else dry

    score, conf = _conformity([
        ("breakout_vol", 0.95, bo_dim), ("rel_strength", 0.85, rs_dim),
        ("ma30", 0.85, ma_dim), ("freshness", 0.55, fresh_dim),
        ("pivot_prox", 0.70, prox_dim), ("base_quality", 0.60, base_dim),
    ])
    summary = (f"베이스 상단 {base_high:,.0f} 돌파 ({days_ago}일 전) · "
               f"돌파 거래량 {vol_ratio:.1f}배 · 30주선 상승 전환{rs_txt}")
    idx0 = max(0, n - 260)
    return PatternHit(
        pattern=key, matched=True, score=score, summary=summary,
        detail={"breakout": base_high, "vol_ratio": vol_ratio, "ext": ext,
                "days_ago": days_ago, "conformity": conf},
        overlays=[
            {"name": "베이스 상단", "points": [(b - 130, base_high), (n - 1, base_high)]},
            {"name": "150일선(≈30주선)",
             "points": [(i, float(ma[i])) for i in range(idx0, n, 5)
                        if np.isfinite(ma[i])]},
        ],
    )


def run_all(df: pd.DataFrame, index_close: np.ndarray | None = None) -> dict[str, PatternHit]:
    """한 종목의 일봉에 모든 탐지기를 실행."""
    tail = df.tail(300).reset_index(drop=True) if len(df) > 300 else df
    ctx = _prep(tail)
    # stage2 는 더 긴 문맥(베이스+30주선 이력)이 필요해 원본으로 계산
    ctx_full = _prep(df.tail(500).reset_index(drop=True)) if len(df) > len(tail) else ctx
    offset = len(df.tail(500)) - len(tail) if len(df) > 300 else 0
    hits = {
        "head_shoulders": detect_head_shoulders(ctx, inverse=False),
        "inv_head_shoulders": detect_head_shoulders(ctx, inverse=True),
        "triangle": detect_triangle(ctx),
        "cup_handle": detect_cup_handle(ctx),
        "stage2": detect_stage2_early(ctx_full, index_close),
    }
    # stage2 오버레이 인덱스를 tail(300) 좌표계로 보정
    st = hits["stage2"]
    if st.matched and offset:
        for ov in st.overlays:
            ov["points"] = [(i - offset, v) for i, v in ov["points"] if i - offset >= 0]
    # 오버레이 좌표계 길이를 기록 (차트 좌표 변환용)
    for hit in hits.values():
        hit.detail["_ctx_len"] = len(tail)
    return hits
