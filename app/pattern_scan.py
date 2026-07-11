"""패턴 스크리너: 종목 유니버스를 훑어 패턴별 상위 매칭을 만든다.

유니버스 선정 근거 (관련 논문 기반 — README 참고):
- 국내: 일평균 거래대금 상위 300 (유동성 확보; Park·Irwin 의 거래비용 경고)
  에서 시가총액 상위 30(초대형주) 제외 — MA/패턴 효과는 고변동·정보
  불확실성 높은 종목에서 강함 (Han·Yang·Zhou 2013, Lo 외 2000)
- 미국: S&P500 구성종목(유동성 검증된 풀)에서 메가캡 제외
- 유니버스는 스캔 때마다 최신 상장목록으로 다시 뽑아 시장 변화를 따라감

스캔은 수십 초~수 분이 걸릴 수 있으므로 백그라운드 태스크로 돌고, 결과는
30분간 전 사용자가 공유한다. 진행률을 노출해 프런트가 폴링할 수 있게 한다.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Awaitable, Callable

import numpy as np
import pandas as pd

from .patterns import PATTERN_KEYS, run_all
from .providers.base import Provider, SymbolInfo

logger = logging.getLogger("ma-analyzer")

RESULT_TTL_SEC = 1800.0     # 스캔 결과 공유 시간
FETCH_BARS = 480            # 종목당 필요한 일봉 수 (30주선 + 베이스 이력)
CONCURRENCY = 6
TOP_N = 8                   # 패턴별 보관 상위 개수
CHART_BARS = 200            # 결과 카드에 실어줄 봉 수

KR_TOP_LIQUIDITY = 300      # 국내: 거래대금 상위 N
KR_EXCLUDE_MEGA = 30        # 국내: 시가총액 상위 N 제외 (초대형주)
INDEX_SYMBOL = {"kr": "KS11", "us": "US500"}  # 상대강도(RS) 비교 지수

# 미국 메가캡 (S&P500 에서 제외할 초대형주 — Han·Yang·Zhou 기준 효과 최약 구간)
MEGA_US = frozenset({
    "AAPL", "MSFT", "NVDA", "GOOGL", "GOOG", "AMZN", "META", "TSLA", "AVGO",
    "BRK.B", "BRK-B", "LLY", "JPM", "WMT", "V", "UNH", "XOM", "MA", "ORCL",
    "PG", "COST", "JNJ", "HD", "NFLX", "BAC", "ABBV", "CRM", "AMD", "KO",
})

# S&P500 목록을 못 받아올 때의 최소 폴백 (유동성 높은 비-메가캡 위주)
US_FALLBACK = [
    ("UBER", "Uber Technologies", "US"), ("PLTR", "Palantir", "US"),
    ("SHOP", "Shopify", "US"), ("SQ", "Block", "US"), ("SNAP", "Snap", "US"),
    ("PYPL", "PayPal", "US"), ("INTC", "Intel", "US"), ("MU", "Micron", "US"),
    ("DIS", "Walt Disney", "US"), ("NKE", "Nike", "US"), ("SBUX", "Starbucks", "US"),
    ("BA", "Boeing", "US"), ("GE", "GE Aerospace", "US"), ("F", "Ford", "US"),
    ("GM", "General Motors", "US"), ("DAL", "Delta Air Lines", "US"),
    ("MRNA", "Moderna", "US"), ("PFE", "Pfizer", "US"), ("T", "AT&T", "US"),
    ("VZ", "Verizon", "US"), ("CSCO", "Cisco", "US"), ("QCOM", "Qualcomm", "US"),
    ("TXN", "Texas Instruments", "US"), ("AMAT", "Applied Materials", "US"),
    ("LRCX", "Lam Research", "US"), ("ADBE", "Adobe", "US"),
    ("NOW", "ServiceNow", "US"), ("MDB", "MongoDB", "US"),
]

UniverseFn = Callable[[], Awaitable[list[SymbolInfo]]]


def _unwrap(provider: Provider):
    """CachingProvider 래퍼를 벗겨 원 공급자(listing 접근용)를 얻는다."""
    return getattr(provider, "inner", provider)


def make_universe_fn(provider: Provider, market: str, fallback: list[SymbolInfo]) -> UniverseFn:
    """스캔 때마다 최신 목록으로 유니버스를 다시 뽑는 함수를 만든다."""

    async def resolve() -> list[SymbolInfo]:
        inner = _unwrap(provider)
        if provider.name == "sample" or not hasattr(inner, "listing_frame"):
            return fallback
        try:
            if market == "kr":
                lf = await inner.listing_frame()
                if lf is None or "amount" not in lf.columns or "marcap" not in lf.columns:
                    return fallback
                df = lf[~lf["market"].str.upper().str.contains("KONEX", na=False)]
                df = df.dropna(subset=["amount", "marcap"])
                mega = set(df.nlargest(KR_EXCLUDE_MEGA, "marcap")["symbol"])
                pool = df[~df["symbol"].isin(mega)].nlargest(KR_TOP_LIQUIDITY, "amount")
                out = [SymbolInfo(r["symbol"], r["name"], r["market"])
                       for _, r in pool.iterrows()]
                return out or fallback
            # us
            lst = await inner.us_listing()
            if not lst:
                return [SymbolInfo(*t) for t in US_FALLBACK]
            return [SymbolInfo(s, n, sec or "US") for s, n, sec in lst
                    if s.upper() not in MEGA_US] or [SymbolInfo(*t) for t in US_FALLBACK]
        except Exception:
            logger.exception("유니버스 선정 실패 (%s) — 폴백 사용", market)
            return fallback if market == "kr" else [SymbolInfo(*t) for t in US_FALLBACK]

    return resolve


class PatternScanner:
    def __init__(self, provider: Provider, universe_fn: UniverseFn,
                 index_symbol: str | None = None):
        self.provider = provider
        self.universe_fn = universe_fn
        self.index_symbol = index_symbol
        self._results: dict[str, Any] | None = None
        self._generated = 0.0
        self._task: asyncio.Task | None = None
        self._done = 0
        self._total = 0
        self._errors = 0

    def _fresh(self) -> bool:
        return (self._results is not None
                and time.monotonic() - self._generated < RESULT_TTL_SEC)

    async def snapshot(self) -> dict[str, Any]:
        """상태 조회 + 필요 시 스캔 시작."""
        if self._fresh():
            return {"status": "done", **self._results}
        if self._task is None or self._task.done():
            self._done = 0
            self._errors = 0
            self._task = asyncio.create_task(self._scan())
        return {"status": "running", "done": self._done,
                "total": self._total, "errors": self._errors}

    async def _scan(self) -> None:
        started = time.monotonic()
        universe = await self.universe_fn()
        self._total = len(universe)

        # 상대강도(RS) 계산용 시장 지수 — 실패해도 스캔은 계속
        index_close: np.ndarray | None = None
        if self.index_symbol:
            try:
                idx_df = await self.provider.candles(self.index_symbol, "day", 300)
                index_close = idx_df["close"].to_numpy(float)
            except Exception:
                logger.info("지수(%s) 조회 실패 — RS 없이 스캔", self.index_symbol)

        sem = asyncio.Semaphore(CONCURRENCY)
        per_symbol: list[tuple[SymbolInfo, dict, pd.DataFrame]] = []

        async def one(info: SymbolInfo):
            async with sem:
                try:
                    df = await self.provider.candles(info.symbol, "day", FETCH_BARS)
                    if len(df) < 60:
                        raise ValueError("데이터 부족")
                    hits = await asyncio.to_thread(run_all, df, index_close)
                    per_symbol.append((info, hits, df.tail(CHART_BARS).reset_index(drop=True)))
                except Exception as exc:  # noqa: BLE001
                    self._errors += 1
                    logger.info("패턴 스캔 스킵 %s (%s)", info.symbol, exc)
                finally:
                    self._done += 1

        await asyncio.gather(*(one(s) for s in universe))

        results: dict[str, Any] = {"patterns": {}, "universe": len(universe),
                                   "scanned": len(per_symbol),
                                   "elapsedSec": round(time.monotonic() - started, 1)}
        for key in PATTERN_KEYS:
            matched = [(info, hits[key], df) for info, hits, df in per_symbol
                       if hits.get(key) and hits[key].matched]
            matched.sort(key=lambda t: t[1].score, reverse=True)
            results["patterns"][key] = [
                _serialize_match(info, hit, df) for info, hit, df in matched[:TOP_N]
            ]
        self._results = results
        self._generated = time.monotonic()
        logger.info("패턴 스캔 완료: %d종목 / %.1fs / 오류 %d",
                    len(per_symbol), results["elapsedSec"], self._errors)


def _serialize_match(info: SymbolInfo, hit, df: pd.DataFrame) -> dict[str, Any]:
    dates = df["date"].dt.strftime("%Y-%m-%d")
    n = len(df)
    candles = [
        {"time": dates.iloc[i], "open": float(df["open"].iloc[i]),
         "high": float(df["high"].iloc[i]), "low": float(df["low"].iloc[i]),
         "close": float(df["close"].iloc[i])}
        for i in range(n)
    ]
    return {
        "symbol": info.symbol, "name": info.name, "market": info.market,
        "score": hit.score, "summary": hit.summary,
        "candles": candles,
        "overlays": _map_overlays(hit, df),
    }


def _map_overlays(hit, chart_df: pd.DataFrame) -> list[dict[str, Any]]:
    """탐지 컨텍스트 인덱스 -> 차트 날짜 좌표.

    탐지 컨텍스트(tail(300))와 차트(tail(200))는 같은 '끝 봉'을 공유하므로
    chart_idx = idx - (ctx_len - n) 으로 변환된다. 차트 범위를 벗어난 점은
    선분을 차트 왼쪽 경계에서 잘라 보간한다.
    """
    n = len(chart_df)
    ctx_len = int(hit.detail.get("_ctx_len", n))
    shift = ctx_len - n
    dates = chart_df["date"].dt.strftime("%Y-%m-%d")
    out = []
    for ov in hit.overlays:
        raw = [(int(idx) - shift, float(val)) for idx, val in ov["points"]]
        pts = []
        for j, (ci, val) in enumerate(raw):
            if ci >= 0:
                pts.append({"time": dates.iloc[min(ci, n - 1)], "value": round(val, 2)})
            elif j + 1 < len(raw) and raw[j + 1][0] > 0:
                # 차트 밖 -> 안으로 이어지는 선분은 경계(0)에서 잘라 보간
                ni, nv = raw[j + 1]
                t = (0 - ci) / (ni - ci)
                pts.append({"time": dates.iloc[0],
                            "value": round(val + (nv - val) * t, 2)})
        if len(pts) >= 2:
            out.append({"name": ov.get("name", ""), "points": pts})
    return out
