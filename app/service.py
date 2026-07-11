"""분석 오케스트레이션: 데이터 취득 -> 엔진 실행 -> 직렬화."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import pandas as pd

from .analysis import EngineParams, MAStat, TimeframeReport, analyze_timeframe, atr, sma
from .config import BARS_PER_YEAR, Settings, TIMEFRAMES
from .providers.base import Provider
from .resample import resample_daily

logger = logging.getLogger("ma-analyzer")

# 판정 지평선 등 타임프레임별 미세 조정
TF_ENGINE_OVERRIDES: dict[str, dict[str, Any]] = {
    "day": {"confirm_horizon": 10},
    "week": {"confirm_horizon": 8},
    "month": {"confirm_horizon": 6},
}


def _warmup_bars(candidates: list[int], params: EngineParams) -> int:
    return max(candidates) + params.atr_period + 10


# 한 타임프레임 봉 1개당 대략적인 거래일(일봉) 수 — 필요한 일봉 수 환산용
DAILY_PER_TF_BAR = {"day": 1, "week": 5, "month": 21}


def _stat_to_dict(s: MAStat, dates: pd.Series) -> dict[str, Any]:
    return {
        "period": s.period,
        "touches": s.touches,
        "supportBounces": s.support_bounces,
        "resistanceBounces": s.resistance_bounces,
        "bounces": s.bounces,
        "breaks": s.breaks,
        "undecided": s.undecided,
        "successRate": round(s.weighted_success, 4),
        "wilsonLb": round(s.wilson_lb, 4),
        "score": round(s.score, 4),
        "qualified": s.qualified,
        "insufficientData": s.insufficient_data,
        "lastTouch": (
            dates.iloc[s.last_touch_index] if s.last_touch_index is not None else None
        ),
    }


def _events_for_chart(s: MAStat, dates: pd.Series, window_start: int) -> list[dict]:
    events = []
    for e in s.episodes:
        if e.end < window_start:
            continue
        # 마커는 사건이 실제로 일어난 봉(반등: 최심 터치봉, 돌파: 확정봉)에.
        # 사건 봉이 분석 창(차트 표시 범위) 이전이면 마커를 생략한다 —
        # 창 첫 봉으로 옮겨 붙이면 엉뚱한 봉에 표시되는 왜곡이 생긴다.
        marker_at = e.anchor if e.anchor is not None else e.end
        if marker_at < window_start:
            continue
        events.append({
            "time": dates.iloc[marker_at],
            "side": e.side,
            "outcome": e.outcome,
            "period": s.period,
        })
    return events


def _ma_series(
    df: pd.DataFrame, dates: pd.Series, period: int, window_start: int
) -> list[dict]:
    values = sma(df["close"].to_numpy(dtype=float), period)
    out = []
    for i in range(window_start, len(df)):
        v = values[i]
        if v == v:  # not NaN
            out.append({"time": dates.iloc[i], "value": round(float(v), 2)})
    return out


def serialize_report(
    report: TimeframeReport, df: pd.DataFrame
) -> dict[str, Any]:
    ws = report.window_start
    dates = df["date"].dt.strftime("%Y-%m-%d")
    candles = [
        {
            "time": dates.iloc[i],
            "open": float(df["open"].iloc[i]),
            "high": float(df["high"].iloc[i]),
            "low": float(df["low"].iloc[i]),
            "close": float(df["close"].iloc[i]),
        }
        for i in range(ws, len(df))
    ]
    recommended = []
    for s in report.recommended:
        recommended.append({
            **_stat_to_dict(s, dates),
            "ma": _ma_series(df, dates, s.period, ws),
            "events": _events_for_chart(s, dates, ws),
        })
    return {
        "timeframe": report.timeframe,
        "bars": len(df) - ws,
        "windowStart": dates.iloc[ws] if len(df) > ws else None,
        "windowEnd": dates.iloc[-1] if len(df) else None,
        "halfLifeBars": round(report.half_life, 1),
        "candles": candles,
        "recommended": recommended,
        "stats": [_stat_to_dict(s, dates) for s in report.stats],
    }


def _timeframe_plan(
    settings: Settings, lookback_years: dict[str, float | None]
) -> dict[str, dict[str, Any]]:
    """타임프레임별 후보/파라미터/워밍업/룩백(해당 봉 단위)을 미리 계산."""
    plan: dict[str, dict[str, Any]] = {}
    for tf in TIMEFRAMES:
        candidates = settings.candidates[tf]
        params = EngineParams(min_touches=settings.min_touches[tf],
                              **TF_ENGINE_OVERRIDES.get(tf, {}))
        warmup = _warmup_bars(candidates, params)
        years = lookback_years.get(tf)
        lookback_bars = max(1, int(years * BARS_PER_YEAR[tf])) if years else None
        plan[tf] = {
            "candidates": candidates,
            "params": params,
            "warmup": warmup,
            "years": years,
            "lookback_bars": lookback_bars,
        }
    return plan


def _daily_bars_needed(plan: dict[str, dict[str, Any]]) -> int:
    """모든 타임프레임을 만들기 위해 필요한 일봉 수(최댓값).

    전체 기간(lookback None)이 하나라도 있으면 공급자가 주는 만큼 전부.
    """
    need = 300
    for tf, p in plan.items():
        if p["lookback_bars"] is None:
            return 100_000  # 전체 기간
        tf_bars = p["lookback_bars"] + p["warmup"]
        need = max(need, tf_bars * DAILY_PER_TF_BAR[tf] + 5)
    return need


async def analyze_symbol(
    provider: Provider,
    settings: Settings,
    symbol: str,
    lookback_years: dict[str, float | None],
) -> dict[str, Any]:
    """일/주/월봉 분석해 프런트엔드용 JSON 으로 반환.

    핵심: 일봉을 '한 번만' 받아 주봉/월봉은 그 일봉을 리샘플링해 만든다.
    (토스 공식 API 는 주/월봉을 제공하지 않고, 세 번 따로 받으면 요청 한도에
    걸리기 때문 — rate limit 회피의 핵심.)
    """
    result: dict[str, Any] = {"symbol": symbol, "provider": provider.name, "timeframes": {}}
    plan = _timeframe_plan(settings, lookback_years)
    need_daily = _daily_bars_needed(plan)

    try:
        daily = await provider.candles(symbol, "day", need_daily)
    except Exception as exc:
        logger.exception("%s 일봉 데이터 취득 실패", symbol)
        msg = str(exc)
        for tf in TIMEFRAMES:
            result["timeframes"][tf] = {"timeframe": tf, "error": msg}
        return result

    for tf in TIMEFRAMES:
        try:
            # pandas/numpy 연산은 순수 동기 CPU 작업이라 이벤트 루프를 막는다.
            # 스레드로 분리해 다른 사용자의 요청이 그동안에도 처리되게 한다.
            result["timeframes"][tf] = await asyncio.to_thread(
                _analyze_one_sync, daily, tf, plan[tf]
            )
        except Exception as exc:
            logger.exception("%s %s봉 분석 실패", symbol, tf)
            result["timeframes"][tf] = {"timeframe": tf, "error": str(exc)}
    return result


def _analyze_one_sync(daily: pd.DataFrame, tf: str, p: dict[str, Any]) -> dict[str, Any]:
    df = daily if tf == "day" else resample_daily(daily, tf)
    if df.empty:
        raise ValueError("리샘플링 결과가 비어 있습니다.")
    lookback_bars = p["lookback_bars"]
    window_start = max(0, len(df) - lookback_bars) if lookback_bars is not None else 0
    report = analyze_timeframe(df, p["candidates"], p["params"], tf, window_start)
    payload = serialize_report(report, df)
    payload["lookbackYears"] = p["years"]
    return payload
