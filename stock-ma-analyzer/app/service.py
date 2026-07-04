"""분석 오케스트레이션: 데이터 취득 -> 엔진 실행 -> 직렬화."""
from __future__ import annotations

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


async def fetch_candles(
    provider: Provider, symbol: str, timeframe: str, max_bars: int
) -> pd.DataFrame:
    """타임프레임 캔들 취득. 주/월봉 API 가 안 되면 일봉 리샘플링으로 폴백."""
    try:
        return await provider.candles(symbol, timeframe, max_bars)
    except Exception:
        if timeframe == "day":
            raise
        logger.warning(
            "%s %s봉 직접 조회 실패 — 일봉 리샘플링으로 폴백합니다.",
            symbol, timeframe, exc_info=True,
        )
        ratio = {"week": 5, "month": 21}[timeframe]
        daily = await provider.candles(symbol, "day", max_bars * ratio)
        df = resample_daily(daily, timeframe)
        return df.tail(max_bars).reset_index(drop=True)


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
        events.append({
            "time": dates.iloc[e.end],
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


async def analyze_symbol(
    provider: Provider,
    settings: Settings,
    symbol: str,
    lookback_years: dict[str, float | None],
) -> dict[str, Any]:
    """일/주/월봉 각각 분석해 프런트엔드용 JSON 으로 반환."""
    result: dict[str, Any] = {"symbol": symbol, "provider": provider.name, "timeframes": {}}
    for tf in TIMEFRAMES:
        candidates = settings.candidates[tf]
        params = EngineParams(min_touches=settings.min_touches[tf],
                              **TF_ENGINE_OVERRIDES.get(tf, {}))
        warmup = _warmup_bars(candidates, params)
        years = lookback_years.get(tf)
        if years:
            # 아주 작은 years 값도 최소 1봉 창으로 — 창/라벨 불일치 방지
            lookback_bars = max(1, int(years * BARS_PER_YEAR[tf]))
            need = lookback_bars + warmup
        else:
            lookback_bars = None
            need = 100_000  # 전체 기간: 공급자가 주는 만큼 전부

        try:
            df = await fetch_candles(provider, symbol, tf, need)
        except Exception as exc:
            logger.exception("%s %s봉 데이터 취득 실패", symbol, tf)
            result["timeframes"][tf] = {"timeframe": tf, "error": str(exc)}
            continue

        if lookback_bars is not None:
            window_start = max(0, len(df) - lookback_bars)
        else:
            window_start = 0
        report = analyze_timeframe(df, candidates, params, tf, window_start)
        payload = serialize_report(report, df)
        payload["lookbackYears"] = years
        result["timeframes"][tf] = payload
    return result
