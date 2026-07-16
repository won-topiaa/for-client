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
"""
from __future__ import annotations

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


# ---------- 헤드 앤 숄더 ----------

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

        score = (prom1 + prom3) * 2 + (0.05 - sym) * 10 + max(0.0, 0.06 - abs(dist_now))
        head_txt = f"{hp:,.0f}"
        sym_score = max(0.0, 100 - sym / 0.05 * 100)  # 0(허용 한계)~100(완전 대칭)
        summary = (
            f"{'바닥' if inverse else '천장'} 머리 {head_txt} · "
            f"어깨 대칭 {sym_score:.0f}점 · 넥라인 {neck_now:,.0f} · {state}"
        )
        hit = PatternHit(
            pattern=key, matched=True, score=round(float(score), 4),
            summary=summary,
            detail={"head": hp, "shoulders": [p1, p3], "neckline": neck_now,
                    "state": state},
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
    score = (0.80 - ratio) * 3 + (len(highs) + len(lows)) * 0.1
    return PatternHit(
        pattern="triangle", matched=True, score=round(float(score), 4),
        summary=f"{kind} · 폭 {ratio * 100:.0f}%까지 수렴 · 꼭짓점 접근 중",
        detail={"ratio": ratio, "kind": kind},
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
        score = r2 * 2 + (0.5 - abs(bpos - 0.5)) + (0.15 - h_depth)
        hit = PatternHit(
            pattern="cup_handle", matched=True, score=round(float(score), 4),
            summary=(f"컵 깊이 {depth * 100:.0f}% · 둥근바닥 적합도 {r2 * 100:.0f}% · "
                     f"핸들 조정 {h_depth * 100:.1f}% · 테두리 {lp:,.0f}"),
            detail={"rim": lp, "depth": depth, "r2": r2, "handle_depth": h_depth},
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

    # 조건 5(보너스): 6개월 상대강도 vs 지수
    rs_txt, rs_bonus = "", 0.0
    if index_close is not None and len(index_close) >= 126 and n >= 126:
        stock_r = close[-1] / close[-126] - 1
        idx_r = float(index_close[-1] / index_close[-126]) - 1
        rs = stock_r - idx_r
        rs_txt = f" · RS {'+' if rs > 0 else ''}{rs * 100:.0f}%p"
        rs_bonus = min(0.5, max(0.0, rs * 2))

    days_ago = n - 1 - b
    score = (min(1.0, vol_ratio / 2.0) + (0.25 - ext) * 2
             + min(0.5, slope_now / 0.02) + rs_bonus)
    summary = (f"베이스 상단 {base_high:,.0f} 돌파 ({days_ago}일 전) · "
               f"돌파 거래량 {vol_ratio:.1f}배 · 30주선 상승 전환{rs_txt}")
    idx0 = max(0, n - 260)
    return PatternHit(
        pattern=key, matched=True, score=round(float(score), 4), summary=summary,
        detail={"breakout": base_high, "vol_ratio": vol_ratio, "ext": ext,
                "days_ago": days_ago},
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
