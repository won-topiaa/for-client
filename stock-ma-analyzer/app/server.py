"""FastAPI 서버: 정적 프런트엔드 + 검색/분석 API."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import DEFAULT_LOOKBACK_YEARS, Settings, load_settings
from .providers.base import Provider
from .providers.sample import SampleProvider
from .providers.toss import TossProvider

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("ma-analyzer")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


def build_provider(settings: Settings) -> Provider:
    if settings.provider == "toss" or (
        settings.provider == "auto" and settings.toss.configured
    ):
        if not settings.toss.configured:
            raise RuntimeError(
                "provider=toss 인데 TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 없습니다."
            )
        logger.info("토스증권 Open API 공급자 사용 (base=%s)", settings.toss.base_url)
        return TossProvider(settings.toss)
    logger.info("샘플 데이터 공급자 사용 (API 키 없음 또는 provider=sample)")
    return SampleProvider(data_dir=settings.data_dir)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = load_settings()
    app.state.settings = settings
    app.state.provider = build_provider(settings)
    yield
    if hasattr(app.state.provider, "aclose"):
        await app.state.provider.aclose()


app = FastAPI(title="이평선 레이더 — 주요 지지/저항 이동평균선 분석기", lifespan=lifespan)
# 전체 기간 분석 응답은 수백 KB 를 넘을 수 있어 압축 필수
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "provider": app.state.provider.name,
        "defaults": {
            "lookbackYears": {
                k: v for k, v in app.state.settings.lookback_years.items()
            },
        },
    }


@app.get("/api/search")
async def search(q: str = Query("", max_length=40)):
    try:
        results = await app.state.provider.search(q)
    except Exception as exc:
        logger.exception("검색 실패")
        raise HTTPException(status_code=502, detail=f"검색 실패: {exc}") from exc
    return {
        "provider": app.state.provider.name,
        "results": [
            {"symbol": s.symbol, "name": s.name, "market": s.market} for s in results
        ],
    }


@app.get("/api/analyze")
async def analyze(
    symbol: str = Query(..., min_length=1, max_length=20),
    years_day: float = Query(None, ge=0, le=50),
    years_week: float = Query(None, ge=0, le=50),
    years_month: float = Query(None, ge=0, le=50),
):
    """years_* : 0 이면 전체 기간, 생략하면 기본 추천값."""
    from .service import analyze_symbol  # 순환 import 방지

    settings: Settings = app.state.settings

    def norm(val: float | None, tf: str) -> float | None:
        if val is None:
            return settings.lookback_years.get(tf, DEFAULT_LOOKBACK_YEARS[tf])
        return None if val == 0 else val

    lookback = {
        "day": norm(years_day, "day"),
        "week": norm(years_week, "week"),
        "month": norm(years_month, "month"),
    }
    try:
        return await analyze_symbol(app.state.provider, settings, symbol, lookback)
    except Exception as exc:
        logger.exception("분석 실패")
        raise HTTPException(status_code=502, detail=f"분석 실패: {exc}") from exc


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")
