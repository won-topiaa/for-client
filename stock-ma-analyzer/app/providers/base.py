"""데이터 공급자 공통 인터페이스."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import pandas as pd

REQUIRED_COLUMNS = ["date", "open", "high", "low", "close", "volume"]


@dataclass
class SymbolInfo:
    symbol: str
    name: str
    market: str = ""


class Provider(Protocol):
    name: str

    async def search(self, query: str) -> list[SymbolInfo]:
        """종목명/코드 검색."""
        ...

    async def candles(self, symbol: str, timeframe: str, max_bars: int) -> pd.DataFrame:
        """오름차순 OHLCV. columns = date, open, high, low, close, volume.

        timeframe: "day" | "week" | "month".
        max_bars 이상을 줄 수 있으면 그만큼, 없으면 가능한 전부.
        """
        ...


def validate_candles(df: pd.DataFrame) -> pd.DataFrame:
    """공급자 응답을 표준화: 컬럼 확인, 정렬, 중복 제거, 숫자형 변환."""
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"캔들 데이터에 누락된 컬럼: {missing}")
    out = df[REQUIRED_COLUMNS].copy()
    out["date"] = pd.to_datetime(out["date"])
    for col in ("open", "high", "low", "close", "volume"):
        out[col] = pd.to_numeric(out[col], errors="coerce")
    out = (
        out.dropna(subset=["date", "open", "high", "low", "close"])
        .drop_duplicates(subset=["date"], keep="last")
        .sort_values("date")
        .reset_index(drop=True)
    )
    return out
