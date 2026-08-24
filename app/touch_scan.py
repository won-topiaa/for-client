"""오늘의 지지선 터치 스캐너.

이평선 레이더 엔진을 유니버스 전체에 거꾸로 적용한다: 종목마다 '무엇이 좋은
선인가'를 백테스트로 찾는 대신, "검증된(백테스트 추천 + 표본 충분) 이평선에
**오늘 가격이 닿아 있는** 종목"을 찾아준다.

터치 판정은 엔진과 완전히 동일한 기준을 쓴다:
- 허용 밴드 = max(0.5 × ATR14, 종가의 0.15%)  (analysis.EngineParams 기본값)
- 지지 터치 = 최근 문맥(직전 20봉 평균)이 선 위 + 오늘 저가가 밴드까지 내려옴
  + 종가가 밴드 밑으로 확정 이탈하지는 않음
- 후보 선 = 일봉 3년 백테스트에서 추천된(qualified) 이평선만 — "자주 그리고
  믿을 만하게" 지지가 된 선 (Wilson 하한 × 가중 성공 점수)
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from typing import Any

import numpy as np
import pandas as pd

from .analysis import EngineParams, analyze_timeframe, atr as atr_fn, sma
from .pattern_scan import (
    FAIL_FAST_PROBE,
    FETCH_BARS,
    PUBLISH_INTERVAL_SEC,
    SCAN_SOFT_BUDGET_SEC,
    BaseScanner,
    UniverseFn,
    _shared_fetch_sem,
)
from .providers.base import Provider, SymbolInfo
from .providers.cache import NegativeCacheSkip

logger = logging.getLogger("ma-analyzer")

WINDOW_BARS = 744          # 백테스트 창: 일봉 3년 (이평선 레이더 기본값과 동일)
# FETCH_BARS 는 pattern_scan 과 공유 — 두 스캐너가 캐시 페치 한 번을 나눠 쓴다
# (3년 창 744 + MA240 워밍업 ≈264 + 여유 = 1050)
CHART_BARS = 130           # 결과 카드 차트 봉 수
TOP_N = 12                 # 표시 상위 개수
MIN_BARS = 320             # 최소 데이터 (워밍업 안 되는 종목 스킵)

# ── 터치 스크리너 품질 기준 (개별 이평선 분석보다 엄격하게 건다) ──
# 이 화면의 핵심은 "오늘 닿은 그 선이 정말 믿을 만한가"다. 그래서 이평선
# 레이더의 추천 기준(자격) 위에 추가 품질 바를 얹어, 지지 성공 확률이 높은
# 종목만 남긴다. (개별 종목 분석 페이지에는 영향을 주지 않는다 — 여기서만 좁힌다)
TOUCH_MIN_MA_PERIOD = 10       # 5일선 제외 — 단기선은 흔들림이 커 '지지선' 신뢰도가 낮다
TOUCH_MIN_SUPPORT_BOUNCES = 3  # 과거 지지 성공(반등) 최소 3회 — 우연 아닌, 반복 검증된 선만
TOUCH_MIN_SUCCESS = 0.60       # 가중 지지 성공률 하한 — 절반이 아니라 과반(60%) 넘게 지켜진 선만


def _support_success_rate(stat) -> float:
    """지지 전용 가중 성공률 — MAStat.support_success 래퍼."""
    return stat.support_success


class TouchScanner(BaseScanner):
    def __init__(self, provider: Provider, universe_fn: UniverseFn,
                 candidates: list[int], min_touches: int = 5):
        super().__init__(provider, universe_fn)
        # 단기선(기본 5일선)은 터치 스크리너 후보에서 뺀다 — 지지선으로서 신뢰도가
        # 낮기 때문. 개별 분석에는 그대로 남고, 여기서만 좁힌다.
        self.candidates = [p for p in candidates if p >= TOUCH_MIN_MA_PERIOD]
        self.params = EngineParams(min_touches=min_touches, confirm_horizon=10)

    async def _scan_inner(self) -> None:
        started = time.monotonic()
        universe = await self.universe_fn()
        self._total = len(universe)

        sem = _shared_fetch_sem()
        matches: list[dict[str, Any]] = []
        scanned = 0
        abort = asyncio.Event()       # 전면 장애 조기중단 (→ 오류)
        budget_hit = asyncio.Event()  # 소프트 시간예산 초과 (→ 부분결과 발행)
        attempted = 0  # 실제 업스트림 조회 시도 수 (네거티브 캐시 스킵 제외)
        last_publish = 0.0  # 0 으로 시작해 '첫 검증이 끝나는 즉시' 한 번 공개

        def publish(partial: bool) -> None:
            """지금까지 모은 matches 로 결과를 만들어 공개 (동기 — 레이스 없음).

            재스캔이 이전 커버리지에 도달하기 전에는 기존 결과를 대체하지
            않는다 (pattern_scan 과 동일 규칙 — 목록 깜빡임 방지)."""
            prev = self._results.get("scanned", 0) if self._results is not None else 0
            if scanned < prev:
                if not partial:
                    self._generated = time.monotonic()  # 기존 결과 유지 + churn 방지
                return
            self._partial = partial
            ranked = sorted(matches, key=lambda m: (-m["maScore"], abs(m["distPct"])))
            self._finish({"matches": ranked[:TOP_N], "totalMatches": len(matches)},
                         len(universe), scanned, started)

        async def one(info: SymbolInfo):
            nonlocal scanned, attempted, last_publish
            if abort.is_set() or budget_hit.is_set():
                return
            async with sem:
                if abort.is_set() or budget_hit.is_set():
                    return
                if time.monotonic() - started > SCAN_SOFT_BUDGET_SEC:
                    budget_hit.set()  # 시간예산 초과 — 새 종목은 그만, 모은 것으로 마무리
                    return
                skipped = False
                try:
                    # 요청 사이 짧은 지터 — 업스트림(무료 시세) 레이트리밋 배려
                    await asyncio.sleep(0.02 + random.random() * 0.08)
                    df = await self.provider.candles(info.symbol, "day", FETCH_BARS,
                                                     use_fail_cache=True)
                    if len(df) < MIN_BARS:
                        raise ValueError("데이터 부족")
                    item = await asyncio.to_thread(self._analyze_sync, info, df)
                    scanned += 1
                    if item:
                        matches.append(item)
                except NegativeCacheSkip:
                    # 방금 실패해 건너뛴 종목 — 조기중단 판정에서 제외 (선두가
                    # 캐시된 실패여도 스캔이 신선한 종목까지 진행해 완주한다)
                    skipped = True
                    self._errors += 1
                except Exception as exc:  # noqa: BLE001
                    self._errors += 1
                    logger.info("터치 스캔 스킵 %s (%s)", info.symbol, exc)
                finally:
                    self._done += 1
                    if not skipped:
                        attempted += 1
            if attempted >= FAIL_FAST_PROBE and scanned == 0:
                abort.set()
            # 진행 중 결과를 주기적으로 공개 — 첫 결과가 빨리 뜨고 점점 채워진다.
            # abort(전면 장애) 뒤 뒤늦게 성공한 스트래글러의 부분 공개는 막는다.
            if (scanned and not abort.is_set()
                    and time.monotonic() - last_publish > PUBLISH_INTERVAL_SEC):
                last_publish = time.monotonic()
                publish(partial=True)

        await asyncio.gather(*(one(s) for s in universe))
        if abort.is_set():
            # 전면 장애 조기중단 — 스트래글러가 뒤늦게 성공했더라도 반쪽 결과는
            # 공개하지 않는다 (pattern_scan 과 동일한 규칙)
            raise RuntimeError(
                "스캔 초반 종목 시세 조회가 모두 실패했습니다 "
                "(데이터 소스 장애 또는 요청 제한)")
        # scanned==0 이면 보여줄 게 없다 (시간예산 초과 등). scanned>0 이면
        # matches 가 비어도 정상(오늘 터치 없음) — 결과를 발행한다.
        if universe and scanned == 0:
            raise RuntimeError(
                "종목 시세를 하나도 가져오지 못했습니다 (데이터 소스 장애 또는 요청 제한)")
        publish(partial=budget_hit.is_set())
        logger.info("터치 스캔 완료: %d종목 중 터치 %d / %.1fs",
                    scanned, len(matches), self._results["elapsedSec"])

    def _touched_today(self, close: np.ndarray, low: np.ndarray,
                       band_now: float) -> dict[int, float]:
        """오늘 '지지 터치' 조건을 만족하는 후보 이평선 {period: ma_now}.

        본 판정과 완전히 같은 조건(문맥이 선 위 + 오늘 저가가 밴드까지 닿음 +
        종가가 밴드 아래로 확정이탈 아님)을 싸게(SMA 만) 먼저 확인한다.
        """
        touched: dict[int, float] = {}
        for period in self.candidates:
            ma = sma(close, period)
            if not np.isfinite(ma[-1]) or ma[-1] <= 0:
                continue
            ma_now = float(ma[-1])
            ctx = close[-21:-1] - ma[-21:-1]
            if not np.isfinite(ctx).all() or float(np.mean(ctx)) <= 0:
                continue
            if low[-1] <= ma_now + band_now and close[-1] >= ma_now - band_now:
                touched[period] = ma_now
        return touched

    def _analyze_sync(self, info: SymbolInfo, df: pd.DataFrame) -> dict[str, Any] | None:
        """한 종목: 오늘 이평선 터치가 있으면 백테스트로 '검증된 선'인지 확인해 직렬화."""
        close = df["close"].to_numpy(float)
        high = df["high"].to_numpy(float)
        low = df["low"].to_numpy(float)
        n = len(df)

        a = atr_fn(high, low, close, 14)
        atr_now = a[-1] if np.isfinite(a[-1]) else 0.0
        band_now = max(self.params.touch_atr_mult * atr_now,
                       self.params.touch_pct_floor * close[-1])

        # 싼 사전 필터: 오늘 어떤 후보 이평선에도 안 닿아 있으면(대부분 종목이
        # 그렇다) 비싼 3년 백테스트를 아예 돌리지 않는다 — 터치 스캔 속도의 핵심.
        touched = self._touched_today(close, low, band_now)
        if not touched:
            return None

        window_start = max(0, n - WINDOW_BARS)
        report = analyze_timeframe(df, self.candidates, self.params, "day", window_start)

        best: dict[str, Any] | None = None
        for s in report.recommended:
            # 검증된 지지선만 통과: 자격 + 지지 성공(반등) 3회 이상 + 지지 성공률 60% 이상.
            # 성공률은 '지지 전용'으로 계산한다 — engine 의 weighted_success 는 저항
            # 반등까지 섞인 양방향 값이라, 저항으로 버틴 선이 지지 기준을 통과하는
            # 오탐을 막는다.
            if not s.qualified or s.support_bounces < TOUCH_MIN_SUPPORT_BOUNCES:
                continue
            support_success = _support_success_rate(s)
            if support_success < TOUCH_MIN_SUCCESS:
                continue
            ma_now = touched.get(s.period)
            if ma_now is None:
                continue  # 오늘 안 닿은 선은 볼 필요 없음
            dist_pct = (close[-1] / ma_now - 1) * 100
            cand = {
                "symbol": info.symbol, "name": info.name, "market": info.market,
                "period": s.period,
                "successRate": round(support_success, 4),
                "touches": s.touches,
                "supportBounces": s.support_bounces,
                "maScore": round(s.score, 4),
                "distPct": round(dist_pct, 2),
                "maValue": round(ma_now, 2),
                "close": round(float(close[-1]), 2),
            }
            if best is None or cand["maScore"] > best["maScore"]:
                best = cand
        if best is None:
            return None

        # 카드 차트: 최근 봉 + 터치한 이평선
        tail = df.tail(CHART_BARS).reset_index(drop=True)
        dates = tail["date"].dt.strftime("%Y-%m-%d")
        offset = n - len(tail)
        ma_full = sma(close, best["period"])
        best["candles"] = [
            {"time": dates.iloc[i], "open": float(tail["open"].iloc[i]),
             "high": float(tail["high"].iloc[i]), "low": float(tail["low"].iloc[i]),
             "close": float(tail["close"].iloc[i])}
            for i in range(len(tail))
        ]
        best["maLine"] = [
            {"time": dates.iloc[i], "value": round(float(ma_full[offset + i]), 2)}
            for i in range(len(tail)) if np.isfinite(ma_full[offset + i])
        ]
        return best
