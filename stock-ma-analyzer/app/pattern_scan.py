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
import random
import time
import weakref
from typing import Any, Awaitable, Callable

import numpy as np
import pandas as pd

from .patterns import PATTERN_KEYS, run_all
from .providers.base import Provider, SymbolInfo

logger = logging.getLogger("ma-analyzer")

RESULT_TTL_SEC = 1800.0     # 스캔 결과 공유 시간
LOW_COVERAGE_TTL_SEC = 300.0  # 절반도 못 훑었으면(업스트림 장애 등) 짧게 재시도
ERROR_COOLDOWN_SEC = 60.0   # 스캔 실패 후 재시도 대기 (실패 폭주 방지)
SCAN_TIMEOUT_SEC = 900.0    # 워치독: 스캔이 이보다 오래 걸리면 행(hang)으로 보고 중단
# 종목당 일봉 수 — 터치 스캐너와 같은 값으로 맞춰, 두 스캐너가 시세 캐시의
# 같은 페치 한 번을 공유하게 한다 (패턴 자체는 뒤쪽 500봉만 사용)
FETCH_BARS = 1050
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
                # 소스 데이터 방어: 중복 코드, NaN 시장명(JSON 직렬화 불가),
                # 문자열이 섞인 숫자 컬럼이 와도 스캔이 죽지 않게 정리
                df = lf.drop_duplicates(subset=["symbol"]).copy()
                df["market"] = df["market"].fillna("").astype(str)
                df["name"] = df["name"].fillna(df["symbol"]).astype(str)
                df["amount"] = pd.to_numeric(df["amount"], errors="coerce")
                df["marcap"] = pd.to_numeric(df["marcap"], errors="coerce")
                df = df[~df["market"].str.upper().str.contains("KONEX", na=False)]
                df = df.dropna(subset=["amount", "marcap"])
                mega = set(df.nlargest(KR_EXCLUDE_MEGA, "marcap")["symbol"])
                pool = df[~df["symbol"].isin(mega)].nlargest(KR_TOP_LIQUIDITY, "amount")
                out = [SymbolInfo(str(r["symbol"]), r["name"], r["market"])
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


# 국내/미국 스캐너가 동시에 돌아도 업스트림 동시 요청 합계가 CONCURRENCY 를
# 넘지 않도록 이벤트루프별로 하나의 세마포어를 공유한다.
_fetch_sems: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = (
    weakref.WeakKeyDictionary()
)


def _shared_fetch_sem() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    sem = _fetch_sems.get(loop)
    if sem is None:
        sem = asyncio.Semaphore(CONCURRENCY)
        _fetch_sems[loop] = sem
    return sem


class BaseScanner:
    """백그라운드 유니버스 스캐너 공통 상태기계.

    결과 TTL 공유 · 실패 시 쿨다운(재시작 폭주 방지) · 만료 결과 우선 제공
    (stale-while-revalidate) 을 제공한다. 하위 클래스는 `_scan_inner` 에서
    유니버스를 훑고 `_finish(results, ...)` 로 결과를 확정한다.
    """

    def __init__(self, provider: Provider, universe_fn: UniverseFn):
        self.provider = provider
        self.universe_fn = universe_fn
        self._results: dict[str, Any] | None = None
        self._generated = 0.0
        self._ttl = RESULT_TTL_SEC
        self._task: asyncio.Task | None = None
        self._done = 0
        self._total = 0
        self._errors = 0
        self._error: str | None = None   # 마지막 스캔 전체 실패 사유
        self._error_ts = 0.0
        self._scan_started = 0.0         # 워치독용: 현재 스캔 시작 시각

    def _fresh(self) -> bool:
        return (self._results is not None
                and time.monotonic() - self._generated < self._ttl)

    async def snapshot(self) -> dict[str, Any]:
        """상태 조회 + 필요 시 스캔 시작.

        - 결과가 만료돼도 남아 있으면 우선 그대로 내주고 뒤에서 재스캔
          (stale-while-revalidate — 사용자는 기다리지 않음)
        - 스캔 자체가 통째로 실패하면 잠깐(ERROR_COOLDOWN_SEC) 재시도를 멈춰
          업스트림 장애 시 무한 재시작 폭주를 막는다
        """
        if self._fresh():
            return {"status": "done", **self._results}
        idle = self._task is None or self._task.done()
        if not idle and time.monotonic() - self._scan_started > SCAN_TIMEOUT_SEC:
            # 워치독: 업스트림 요청이 행(hang)에 걸리면 스캔이 영원히 '진행 중'에
            # 갇힌다 — 끊고 실패 처리해 쿨다운 후 새로 시도하게 한다
            self._task.cancel()
            self._error = "스캔 시간 초과 (업스트림 응답 없음)"
            self._error_ts = time.monotonic()
            logger.warning("%s 워치독: %.0f초 초과로 스캔 중단",
                           type(self).__name__, SCAN_TIMEOUT_SEC)
            idle = True
        cooling = (self._error is not None
                   and time.monotonic() - self._error_ts < ERROR_COOLDOWN_SEC)
        if idle and not cooling:
            self._done = 0
            self._total = 0   # 유니버스 선정 동안 이전 스캔의 total 이 비치지 않게
            self._errors = 0
            self._scan_started = time.monotonic()
            self._task = asyncio.create_task(self._scan())
            idle = False
        if self._results is not None:
            return {"status": "done", "refreshing": not idle, **self._results}
        if idle:  # 쿨다운 중 + 보여줄 과거 결과도 없음
            return {"status": "error",
                    "detail": f"스캔 실패 ({self._error}) — 잠시 후 자동으로 다시 시도합니다."}
        return {"status": "running", "done": self._done,
                "total": self._total, "errors": self._errors}

    async def _scan(self) -> None:
        try:
            await self._scan_inner()
            self._error = None
        except Exception as exc:  # noqa: BLE001
            self._error = str(exc) or exc.__class__.__name__
            self._error_ts = time.monotonic()
            logger.exception("%s 스캔 실패", type(self).__name__)

    def _finish(self, results: dict[str, Any], universe_n: int,
                scanned_n: int, started: float) -> float:
        """결과 확정 + 커버리지 기반 TTL 결정. 커버리지를 반환."""
        results.update({"universe": universe_n, "scanned": scanned_n,
                        "elapsedSec": round(time.monotonic() - started, 1)})
        coverage = scanned_n / universe_n if universe_n else 1.0
        # 절반도 못 훑었으면(부분 장애) 결과 수명을 짧게 잡아 금방 재시도
        self._ttl = RESULT_TTL_SEC if coverage >= 0.5 else LOW_COVERAGE_TTL_SEC
        self._results = results
        self._generated = time.monotonic()
        return coverage

    async def _scan_inner(self) -> None:
        raise NotImplementedError


class PatternScanner(BaseScanner):
    def __init__(self, provider: Provider, universe_fn: UniverseFn,
                 index_symbol: str | None = None):
        super().__init__(provider, universe_fn)
        self.index_symbol = index_symbol

    async def _scan_inner(self) -> None:
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

        sem = _shared_fetch_sem()
        per_symbol: list[tuple[SymbolInfo, dict, pd.DataFrame]] = []

        async def one(info: SymbolInfo):
            async with sem:
                try:
                    # 요청 사이 짧은 지터 — 업스트림(무료 시세) 레이트리밋 배려
                    await asyncio.sleep(0.05 + random.random() * 0.2)
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
        if universe and not per_symbol:
            raise RuntimeError("종목 데이터를 하나도 가져오지 못했습니다")

        results: dict[str, Any] = {"patterns": {}}
        for key in PATTERN_KEYS:
            matched = [(info, hits[key], df) for info, hits, df in per_symbol
                       if hits.get(key) and hits[key].matched]
            matched.sort(key=lambda t: t[1].score, reverse=True)
            results["patterns"][key] = [
                _serialize_match(info, hit, df) for info, hit, df in matched[:TOP_N]
            ]
        coverage = self._finish(results, len(universe), len(per_symbol), started)
        logger.info("패턴 스캔 완료: %d종목 / %.1fs / 오류 %d (커버리지 %.0f%%)",
                    len(per_symbol), results["elapsedSec"], self._errors,
                    coverage * 100)


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
