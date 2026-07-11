"""패턴 스크리너: 종목 유니버스를 훑어 패턴별 상위 매칭을 만든다.

스캔은 수십 초가 걸릴 수 있으므로 백그라운드 태스크로 돌고, 결과는
30분간 전 사용자가 공유한다 (같은 시점의 시장은 같은 패턴이므로).
진행률을 노출해 프런트가 폴링할 수 있게 한다.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import pandas as pd

from .patterns import PATTERN_KEYS, run_all
from .providers.base import Provider, SymbolInfo

logger = logging.getLogger("ma-analyzer")

RESULT_TTL_SEC = 1800.0     # 스캔 결과 공유 시간
FETCH_BARS = 480            # 종목당 필요한 일봉 수 (stage 150MA + 워밍업)
CONCURRENCY = 5
TOP_N = 8                   # 패턴별 보관 상위 개수
CHART_BARS = 200            # 결과 카드에 실어줄 봉 수


class PatternScanner:
    def __init__(self, provider: Provider, universe: list[SymbolInfo]):
        self.provider = provider
        self.universe = universe
        self._results: dict[str, Any] | None = None
        self._generated = 0.0
        self._task: asyncio.Task | None = None
        self._done = 0
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
                "total": len(self.universe), "errors": self._errors}

    async def _scan(self) -> None:
        started = time.monotonic()
        sem = asyncio.Semaphore(CONCURRENCY)
        per_symbol: list[tuple[SymbolInfo, dict, pd.DataFrame]] = []

        async def one(info: SymbolInfo):
            async with sem:
                try:
                    df = await self.provider.candles(info.symbol, "day", FETCH_BARS)
                    if len(df) < 60:
                        raise ValueError("데이터 부족")
                    hits = await asyncio.to_thread(run_all, df)
                    per_symbol.append((info, hits, df.tail(CHART_BARS).reset_index(drop=True)))
                except Exception as exc:  # noqa: BLE001
                    self._errors += 1
                    logger.info("패턴 스캔 스킵 %s (%s)", info.symbol, exc)
                finally:
                    self._done += 1

        await asyncio.gather(*(one(s) for s in self.universe))

        results: dict[str, Any] = {"patterns": {}, "universe": len(self.universe),
                                   "scanned": len(per_symbol),
                                   "elapsedSec": round(time.monotonic() - started, 1)}
        for key in PATTERN_KEYS:
            matched = [(info, hits[key], df) for info, hits, df in per_symbol
                       if hits.get(key) and hits[key].matched]
            matched.sort(key=lambda t: t[1].score, reverse=True)
            if key == "stage":
                by_stage: dict[str, list] = {"1": [], "2": [], "3": [], "4": []}
                for info, hit, df in matched:
                    by_stage[str(hit.detail.get("stage", 0))].append(
                        _serialize_match(info, hit, df))
                for k in by_stage:
                    by_stage[k] = by_stage[k][:TOP_N]
                results["patterns"][key] = by_stage
            else:
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
