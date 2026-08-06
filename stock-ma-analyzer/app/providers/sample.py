"""샘플 데이터 공급자.

토스 API 키 없이도 프로그램 전체(검색 -> 분석 -> 차트)를 돌려볼 수 있도록
1) 종목별 시드 고정 합성 일봉 (이평선 회귀 성질을 넣어 실제와 비슷한
   지지/저항 상호작용이 생기게 생성)
2) data/ 폴더의 CSV (date,open,high,low,close,volume) — 실제 데이터를
   내려받아 넣으면 그대로 분석 가능
를 제공한다. 주봉/월봉은 일봉을 리샘플링해서 만든다.
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pandas as pd

from ..resample import resample_daily
from .base import SymbolInfo, validate_candles

UNIVERSE: list[SymbolInfo] = [
    SymbolInfo("005930", "삼성전자", "KOSPI"),
    SymbolInfo("000660", "SK하이닉스", "KOSPI"),
    SymbolInfo("035420", "NAVER", "KOSPI"),
    SymbolInfo("035720", "카카오", "KOSPI"),
    SymbolInfo("005380", "현대차", "KOSPI"),
    SymbolInfo("373220", "LG에너지솔루션", "KOSPI"),
    SymbolInfo("068270", "셀트리온", "KOSPI"),
    SymbolInfo("005490", "POSCO홀딩스", "KOSPI"),
    SymbolInfo("000270", "기아", "KOSPI"),
    SymbolInfo("207940", "삼성바이오로직스", "KOSPI"),
]


def generate_daily(seed: int, days: int = 3600, s0: float = 60000.0) -> pd.DataFrame:
    """이평선 앵커(평균회귀) 항이 들어간 합성 일봉 생성기.

    가격이 MA20/MA60/MA120 에서 멀어지면 되돌리는 힘이 생겨, 실제 차트처럼
    이평선 부근에서 반등/저항이 자연스럽게 나타난다. 시드 고정 -> 재현 가능.
    """
    rng = np.random.default_rng(seed)
    n = days
    closes = np.empty(n)
    closes[0] = s0
    drift = 0.0
    sigma = 0.018
    for t in range(1, n):
        if t % 120 == 0:  # 4~6개월마다 추세 레짐 전환
            drift = rng.normal(0.0003, 0.0012)
            sigma = float(np.clip(rng.normal(0.018, 0.005), 0.008, 0.035))
        r = rng.normal(drift, sigma)
        for window, k in ((20, 0.020), (60, 0.010), (120, 0.006)):
            if t > window:
                ma = closes[t - window:t].mean()
                dev = (closes[t - 1] - ma) / ma
                r -= k * dev
        closes[t] = closes[t - 1] * (1.0 + r)

    opens = closes * (1.0 + rng.normal(0, 0.004, n))
    opens[0] = closes[0]
    body_hi = np.maximum(opens, closes)
    body_lo = np.minimum(opens, closes)
    highs = body_hi * (1.0 + np.abs(rng.normal(0, 0.006, n)))
    lows = body_lo * (1.0 - np.abs(rng.normal(0, 0.006, n)))
    volume = np.exp(rng.normal(13.5, 0.6, n)).astype(np.int64)

    dates = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=n)
    df = pd.DataFrame({
        "date": dates,
        "open": np.round(opens, 0),
        "high": np.round(highs, 0),
        "low": np.round(lows, 0),
        "close": np.round(closes, 0),
        "volume": volume,
    })
    return validate_candles(df)


class SampleProvider:
    name = "sample"

    def __init__(self, data_dir: Path | None = None):
        self.data_dir = data_dir
        # key: symbol, value: (csv mtime | None, DataFrame) — 파일이 바뀌면 재로딩
        self._cache: dict[str, tuple[float | None, pd.DataFrame]] = {}

    def _csv_symbols(self) -> list[SymbolInfo]:
        if not self.data_dir or not self.data_dir.exists():
            return []
        out = []
        for f in sorted(self.data_dir.glob("*.csv")):
            out.append(SymbolInfo(f.stem, f"{f.stem} (CSV)", "CSV"))
        return out

    async def search(self, query: str) -> list[SymbolInfo]:
        q = query.strip().lower()
        pool = UNIVERSE + self._csv_symbols()
        if not q:
            return pool[:20]
        return [
            s for s in pool
            if q in s.symbol.lower() or q in s.name.lower()
        ][:20]

    # 종목코드/티커로 쓸 수 있는 문자만 허용 — 경로 탈출(../) 등 차단
    _SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-]{1,20}$")
    _MAX_CACHE = 50

    def _load_daily(self, symbol: str) -> pd.DataFrame:
        if not self._SYMBOL_RE.match(symbol):
            raise ValueError(f"잘못된 종목코드 형식: {symbol!r}")
        csv_path = (self.data_dir / f"{symbol}.csv") if self.data_dir else None
        if csv_path is not None:
            # 이중 방어: 최종 경로가 data 폴더 밖이면 거부
            resolved = csv_path.resolve()
            if resolved.parent != self.data_dir.resolve():
                raise ValueError(f"허용되지 않는 경로: {symbol!r}")
            csv_path = resolved
        mtime = csv_path.stat().st_mtime if csv_path and csv_path.exists() else None
        cached = self._cache.get(symbol)
        if cached is not None and cached[0] == mtime:
            return cached[1]
        if mtime is not None:
            raw = pd.read_csv(csv_path)
            raw.columns = [c.strip().lower() for c in raw.columns]
            df = validate_candles(raw)
        else:
            seed = int.from_bytes(symbol.encode("utf-8"), "little") % (2**32)
            base = 20000.0 + (seed % 17) * 15000.0
            df = generate_daily(seed, days=3600, s0=base)
        if len(self._cache) >= self._MAX_CACHE:  # 메모리 보호
            self._cache.pop(next(iter(self._cache)))
        self._cache[symbol] = (mtime, df)
        return df

    async def candles(self, symbol: str, timeframe: str, max_bars: int) -> pd.DataFrame:
        daily = self._load_daily(symbol)
        df = resample_daily(daily, timeframe)
        return df.tail(max_bars).reset_index(drop=True)
