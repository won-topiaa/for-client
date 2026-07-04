"""일봉 -> 주봉/월봉 리샘플링.

API 가 주봉/월봉을 직접 주면 그것을 쓰고, 아니면 일봉을 집계한다.
주봉은 금요일 라벨(한국 시장 월~금), 월봉은 월말 라벨.
"""
from __future__ import annotations

import pandas as pd

_RULES = {"week": "W-FRI", "month": "ME"}

_AGG = {
    "open": "first",
    "high": "max",
    "low": "min",
    "close": "last",
    "volume": "sum",
}


def resample_daily(df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    """df: date(datetime64), open, high, low, close, volume 오름차순 일봉."""
    if timeframe == "day":
        return df
    rule = _RULES[timeframe]
    out = (
        df.set_index("date")
        .resample(rule)
        .agg(_AGG)
        .dropna(subset=["open", "high", "low", "close"])
        .reset_index()
    )
    # 라벨(주말/월말)이 아니라 실제 마지막 거래일을 date 로 쓰고 싶으면
    # 아래처럼 마지막 거래일을 붙인다. 차트 x축 정확성을 위해 적용.
    last_dates = (
        df.set_index("date")["close"].resample(rule).apply(lambda s: s.index[-1] if len(s) else pd.NaT)
    )
    out["date"] = last_dates.dropna().to_numpy()
    return out
