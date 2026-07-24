"""맞춤 이평선 스크리너 — "내가 고른 N일선"의 지지/저항 종목 스캐너.

사용자가 이평선 기간(예: 50일)을 입력하면 유니버스 전체에서
- 그 선의 **지지를 받고 있는** 종목 리스트
- 그 선의 **저항에 막혀 있는** 종목 리스트
를 나눠 보여준다.

── '지지를 받고 있다' 판정 기준 (전부 만족해야 함) ──────────────────────
1. 위치 문맥: 직전 20봉(당일 제외 — 당일은 시험 봉) 종가의 70% 이상이 선 위
   — 추세가 선 위에 '정박' (와인스타인: 선 위에서 진행 중인 추세만 지지를 논한다)
2. 최근 시험: 최근 5봉(당일 포함) 안에 저가가 허용 밴드까지 선에 닿음 —
   '받고 있다'는 현재진행형이므로, 지금 시험 중인 종목만
3. 확정 이탈 아님: 오늘 종가가 선 − 밴드 위이고, 최근 5봉 안에 엔진 기준의
   확정 이탈(밴드+ATR 관통 종가, 또는 밴드 밖 종가 3봉 연속)이 없음 —
   이미 무너진 선이 하루 반등으로 되살아 보이는 것을 막는다
4. 선 기울기: 10봉 기울기 ≥ −0.2% — 하락 중인 선의 지지는 신뢰가 낮다
   (Weinstein 1988: 하락 이평선 위 매수 금지 원칙의 완화 적용)
5. 과거 검증: 3년 백테스트에서 그 선의 지지쪽 결정(반등/이탈) 에피소드 ≥ 2회,
   가중 지지 성공률 ≥ 50% — 우연히 걸친 선이 아니라 실제로 작동해 온 선만

'저항에 막혀 있다'는 위 기준의 완전한 거울상(선 아래 정박 + 최근 고가 터치 +
확정 돌파 아님 + 기울기 ≤ +0.2% + 과거 저항 성공률 ≥ 50%).

허용 밴드·에피소드 판정·가중치(반감기)·Wilson 하한은 이평선 레이더 엔진
(analysis.py)과 완전히 동일한 값을 재사용한다 — 사이트 전체가 한 가지 기준으로
말하게 하기 위함. 정렬 점수 = Wilson 하한(90% 단측) × log1p(가중 성공 횟수),
같은 점수면 선까지 거리가 가까운 순.
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from typing import Any

import numpy as np
import pandas as pd

from .analysis import (
    EngineParams,
    analyze_timeframe,
    atr as atr_fn,
    sma,
    wilson_lower_bound,
)
from .pattern_scan import (
    FAIL_FAST_PROBE,
    FETCH_BARS,
    PARTIAL_RESCAN_COOLDOWN_SEC,
    PUBLISH_INTERVAL_SEC,
    RESULT_TTL_SEC,
    SCAN_SOFT_BUDGET_SEC,
    BaseScanner,
    UniverseFn,
    _shared_fetch_sem,
    _strip_forming_bar,
)
from .providers.base import Provider, SymbolInfo
from .providers.cache import NegativeCacheSkip

logger = logging.getLogger("ma-analyzer")

WINDOW_BARS = 744        # 백테스트 창: 일봉 3년 (터치 스캐너와 동일)
CHART_BARS = 130         # 결과 카드 차트 봉 수
TOP_N = 6                # 리스트당 표시 상위 개수 (지지 6 + 저항 6)
MIN_BARS = 320           # 최소 데이터 (워밍업 안 되는 종목 스킵)

LINE_MIN_PERIOD = 5      # 허용 이평선 기간 범위
LINE_MAX_PERIOD = 250

# ── 판정 기준 상수 (모듈 docstring 의 번호와 대응) ──
CTX_BARS = 20            # 1. 위치 문맥 봉 수
CTX_FRAC = 0.70          # 1. 선 위(아래) 종가 비율 하한
RECENT_TOUCH_BARS = 5    # 2. '최근 시험' 허용 봉 수
SLOPE_BARS = 10          # 4. 기울기 측정 봉 수
SLOPE_TOL = 0.002        # 4. 기울기 허용 오차 (±0.2%)
MIN_SIDE_DECIDED = 2     # 5. 해당 방향 결정 에피소드 최소 개수
MIN_SIDE_RESPECT = 0.50  # 5. 해당 방향 가중 성공률 하한


def _side_stats(stat, side: str) -> tuple[float, float, float] | None:
    """해당 방향(support/resistance) 에피소드만의 (가중 성공률, 유효표본, 가중성공).

    엔진의 weighted_success 는 양방향 합산값이라 방향별 판정에 쓰면 반대쪽
    성적이 섞인다 — 에피소드에서 방향을 갈라 다시 계산한다. 결정 에피소드가
    MIN_SIDE_DECIDED 미만이면 None (표본 부족)."""
    decided = [e for e in stat.episodes
               if e.side == side and e.outcome in ("bounce", "break")]
    if len(decided) < MIN_SIDE_DECIDED:
        return None
    w = np.array([e.weight for e in decided])
    s = np.array([1.0 if e.outcome == "bounce" else 0.0 for e in decided])
    w_sum = float(w.sum())
    if w_sum <= 0:
        return None
    respect = float((w * s).sum() / w_sum)
    n_eff = float(w_sum * w_sum / (w * w).sum())   # Kish 유효표본 크기
    return respect, n_eff, float((w * s).sum())


class LineScanner(BaseScanner):
    """(시장, 이평선 기간) 하나에 대한 지지/저항 유니버스 스캐너.

    시세 캐시(FETCH_BARS=1050, 30분 TTL)는 패턴/터치 스캐너와 공유하므로,
    다른 스캐너가 이미 돈 뒤라면 네트워크 없이 CPU 계산만으로 완주한다."""

    def __init__(self, provider: Provider, universe_fn: UniverseFn, period: int,
                 market: str = "kr"):
        super().__init__(provider, universe_fn, market)
        self.period = int(period)
        # min_touches=3: 특정 선 하나를 지목하는 화면이라 터치 5회를 요구하면
        # 장기선(200일 등)이 과도하게 걸러진다 — 방향별 결정 2회 기준(아래)이
        # 실질 품질 바 역할을 한다. confirm_horizon 은 터치 스캐너와 동일.
        self.params = EngineParams(min_touches=3, confirm_horizon=10)

    async def _scan_inner(self) -> None:
        started = time.monotonic()
        universe = await self.universe_fn()
        self._total = len(universe)

        sem = _shared_fetch_sem()
        matches: list[dict[str, Any]] = []
        scanned = 0
        abort = asyncio.Event()       # 전면 장애 조기중단 (→ 오류)
        budget_hit = asyncio.Event()  # 소프트 시간예산 초과 (→ 부분결과 발행)
        attempted = 0
        last_publish = 0.0

        def publish(partial: bool, final: bool = False) -> None:
            """지지/저항 리스트로 나눠 결과 공개 (터치 스캐너와 동일 규칙)."""
            prev = self._results.get("scanned", 0) if self._results is not None else 0
            if scanned < prev:
                if final:
                    # 미달 완주 — 기존 결과 유지 + 재시도 휴지 지수 증가
                    self._retry_wait = min(self._retry_wait * 2, RESULT_TTL_SEC)
                return
            self._partial = partial
            if final:
                self._retry_wait = PARTIAL_RESCAN_COOLDOWN_SEC
            # 심볼을 마지막 동점 기준으로 — 반올림 점수가 같은 종목이 TOP_N
            # 경계에 걸릴 때 표시가 스캔 완료 순서에 따라 널뛰지 않게(결정성)
            key = lambda m: (-m["maScore"], abs(m["distPct"]), m["symbol"])  # noqa: E731
            support = sorted((m for m in matches if m["side"] == "support"), key=key)
            resistance = sorted((m for m in matches if m["side"] == "resistance"), key=key)
            self._finish({
                "period": self.period,
                "support": support[:TOP_N],
                "resistance": resistance[:TOP_N],
                "totalSupport": len(support),
                "totalResistance": len(resistance),
            }, len(universe), scanned, started)

        async def one(info: SymbolInfo):
            nonlocal scanned, attempted, last_publish
            if abort.is_set() or budget_hit.is_set():
                return
            async with sem:
                if abort.is_set() or budget_hit.is_set():
                    return
                if time.monotonic() - started > SCAN_SOFT_BUDGET_SEC:
                    budget_hit.set()
                    return
                skipped = False
                try:
                    await asyncio.sleep(0.02 + random.random() * 0.08)
                    df = await self.provider.candles(info.symbol, "day", FETCH_BARS,
                                                     use_fail_cache=True)
                    df = _strip_forming_bar(df, self.market)  # 확정 봉만
                    if len(df) < MIN_BARS:
                        raise ValueError("데이터 부족")
                    item = await asyncio.to_thread(self._analyze_sync, info, df)
                    scanned += 1
                    if item:
                        matches.append(item)
                except NegativeCacheSkip:
                    skipped = True
                    self._errors += 1
                except Exception as exc:  # noqa: BLE001
                    self._errors += 1
                    logger.info("맞춤선 스캔 스킵 %s (%s)", info.symbol, exc)
                finally:
                    self._done += 1
                    if not skipped:
                        attempted += 1
            if attempted >= FAIL_FAST_PROBE and scanned == 0:
                abort.set()
            if (scanned and not abort.is_set()
                    and time.monotonic() - last_publish > PUBLISH_INTERVAL_SEC):
                last_publish = time.monotonic()
                publish(partial=True)

        await asyncio.gather(*(one(s) for s in universe))
        if abort.is_set():
            raise RuntimeError(
                "스캔 초반 종목 시세 조회가 모두 실패했습니다 "
                "(데이터 소스 장애 또는 요청 제한)")
        if universe and scanned == 0:
            raise RuntimeError(
                "종목 시세를 하나도 가져오지 못했습니다 (데이터 소스 장애 또는 요청 제한)")
        publish(partial=budget_hit.is_set(), final=True)
        logger.info("맞춤선(%d일) 스캔 완료: %d종목 중 지지 %d·저항 %d / %.1fs",
                    self.period, scanned,
                    self._results.get("totalSupport", 0) if self._results else 0,
                    self._results.get("totalResistance", 0) if self._results else 0,
                    self._results["elapsedSec"] if self._results else 0.0)

    # ---- 종목 하나 판정 (워커 스레드에서 실행) ----

    @staticmethod
    def _consec(mask: np.ndarray, k: int) -> bool:
        """mask 안에 True 가 k개 이상 연속으로 있는가."""
        run = 0
        for v in mask:
            run = run + 1 if v else 0
            if run >= k:
                return True
        return False

    def _classify_now(self, close: np.ndarray, high: np.ndarray, low: np.ndarray,
                      ma: np.ndarray, band: np.ndarray,
                      atr_arr: np.ndarray) -> str | None:
        """현재 상태 판정: 'support' / 'resistance' / None (기준 1~4).

        '확정 이탈(돌파) 아님'은 엔진의 break 정의와 같은 두 갈래로 본다 —
        ⓐ 밴드+ATR 만큼 관통한 종가, ⓑ 밴드 밖 종가 3봉 연속. 마지막 봉
        하나만 보면, 사흘 연속 무너진 뒤 하루 반등한 종목(엔진이 방금 '이탈
        확정'으로 판정한 선)이 지지 리스트에 오르는 구멍이 생긴다."""
        ctx_c = close[-(CTX_BARS + 1):-1]   # 직전 20봉 (당일 제외 — 당일은 시험 봉)
        ctx_m = ma[-(CTX_BARS + 1):-1]
        if len(ctx_c) < CTX_BARS or not (np.isfinite(ctx_c).all()
                                         and np.isfinite(ctx_m).all()):
            return None
        if not (np.isfinite(ma[-1]) and ma[-1] > 0
                and np.isfinite(ma[-(SLOPE_BARS + 1)])
                and np.isfinite(band[-1]) and band[-1] > 0):
            return None
        above_frac = float(np.mean(ctx_c > ctx_m))
        slope = float(ma[-1] / ma[-(SLOPE_BARS + 1)] - 1)

        r = slice(-RECENT_TOUCH_BARS, None)
        fin = np.isfinite(ma[r]) & np.isfinite(band[r]) & np.isfinite(atr_arr[r])
        touched_from_above = bool(np.any(fin & (low[r] <= ma[r] + band[r])))
        touched_from_below = bool(np.any(fin & (high[r] >= ma[r] - band[r])))

        # 최근 5봉 내 '확정 이탈/돌파' (엔진 break 정의의 거울) — 있으면 그
        # 선은 이미 깨진 선이므로 지지(저항) 후보에서 제외한다
        k = self.params.break_consec_closes
        deep = np.maximum(self.params.break_atr_mult * atr_arr[r], band[r])
        broke_down = (bool(np.any(fin & (close[r] < ma[r] - deep)))
                      or self._consec(fin & (close[r] < ma[r] - band[r]), k))
        broke_up = (bool(np.any(fin & (close[r] > ma[r] + deep)))
                    or self._consec(fin & (close[r] > ma[r] + band[r]), k))

        if (above_frac >= CTX_FRAC and touched_from_above
                and not broke_down
                and close[-1] >= ma[-1] - band[-1]      # 오늘도 밴드 안쪽
                and slope >= -SLOPE_TOL):
            return "support"
        if ((1.0 - above_frac) >= CTX_FRAC and touched_from_below
                and not broke_up
                and close[-1] <= ma[-1] + band[-1]      # 오늘도 밴드 안쪽
                and slope <= SLOPE_TOL):
            return "resistance"
        return None

    def _analyze_sync(self, info: SymbolInfo, df: pd.DataFrame) -> dict[str, Any] | None:
        close = df["close"].to_numpy(float)
        high = df["high"].to_numpy(float)
        low = df["low"].to_numpy(float)
        n = len(df)
        # 워밍업 + 백테스트 표본이 모두 가능해야 한다 (장기선은 더 긴 데이터 필요)
        if n < max(MIN_BARS, self.period * 2):
            return None

        ma = sma(close, self.period)
        a = atr_fn(high, low, close, self.params.atr_period)
        band = np.maximum(self.params.touch_atr_mult * a,
                          self.params.touch_pct_floor * close)

        side = self._classify_now(close, high, low, ma, band, a)
        if side is None:
            return None  # 대부분 종목이 여기서 걸러져 비싼 백테스트를 건너뛴다

        # 기준 5: 과거 검증 — 엔진 백테스트로 그 선의 방향별 성적 확인
        window_start = max(0, n - WINDOW_BARS)
        report = analyze_timeframe(df, [self.period], self.params, "day", window_start)
        stat = report.stats[0]
        if stat.insufficient_data:
            return None
        side_st = _side_stats(stat, side)
        if side_st is None:
            return None
        respect, n_eff, w_bounces = side_st
        if respect < MIN_SIDE_RESPECT:
            return None
        score = wilson_lower_bound(respect, n_eff, self.params.wilson_z) \
            * float(np.log1p(w_bounces))

        ma_now = float(ma[-1])
        item = {
            "symbol": info.symbol, "name": info.name, "market": info.market,
            "side": side,
            "period": self.period,
            "respectRate": round(respect, 4),
            "decided": int(sum(1 for e in stat.episodes
                               if e.side == side and e.outcome in ("bounce", "break"))),
            "touches": stat.touches,
            "maScore": round(score, 4),
            "distPct": round((float(close[-1]) / ma_now - 1) * 100, 2),
            "slopePct": round(float(ma[-1] / ma[-(SLOPE_BARS + 1)] - 1) * 100, 2),
            "maValue": round(ma_now, 2),
            "close": round(float(close[-1]), 2),
        }

        # 카드 차트: 최근 봉 + 해당 이평선 (터치 스캐너와 동일 형식)
        tail = df.tail(CHART_BARS).reset_index(drop=True)
        dates = tail["date"].dt.strftime("%Y-%m-%d")
        offset = n - len(tail)
        item["candles"] = [
            {"time": dates.iloc[i], "open": float(tail["open"].iloc[i]),
             "high": float(tail["high"].iloc[i]), "low": float(tail["low"].iloc[i]),
             "close": float(tail["close"].iloc[i])}
            for i in range(len(tail))
        ]
        item["maLine"] = [
            {"time": dates.iloc[i], "value": round(float(ma[offset + i]), 2)}
            for i in range(len(tail)) if np.isfinite(ma[offset + i])
        ]
        return item
