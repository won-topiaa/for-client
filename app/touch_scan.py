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


class TouchScanner(BaseScanner):
    def __init__(self, provider: Provider, universe_fn: UniverseFn,
                 candidates: list[int], min_touches: int = 5):
        super().__init__(provider, universe_fn)
        self.candidates = candidates
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

        async def one(info: SymbolInfo):
            nonlocal scanned, attempted
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
        self._partial = budget_hit.is_set()

        # 믿을 만한 선 순서: 선의 점수(자주+믿을만) 우선, 같은 점수면 더 가까이
        matches.sort(key=lambda m: (-m["maScore"], abs(m["distPct"])))
        results: dict[str, Any] = {"matches": matches[:TOP_N],
                                   "totalMatches": len(matches)}
        coverage = self._finish(results, len(universe), scanned, started)
        logger.info("터치 스캔 완료: %d종목 중 터치 %d / %.1fs (커버리지 %.0f%%)",
                    scanned, len(matches), results["elapsedSec"], coverage * 100)

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
            if not s.qualified or s.support_bounces < 2:
                continue  # 지지 이력이 검증된 선만
            ma_now = touched.get(s.period)
            if ma_now is None:
                continue  # 오늘 안 닿은 선은 볼 필요 없음
            dist_pct = (close[-1] / ma_now - 1) * 100
            cand = {
                "symbol": info.symbol, "name": info.name, "market": info.market,
                "period": s.period,
                "successRate": round(s.weighted_success, 4),
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
