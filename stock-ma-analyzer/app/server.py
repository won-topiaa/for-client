"""FastAPI 서버: 정적 프런트엔드 + 검색/분석 API."""
from __future__ import annotations

import base64
import logging
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from .config import DEFAULT_LOOKBACK_YEARS, Settings, load_settings
from .providers.base import Provider
from .providers.cache import CachingProvider
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
        return TossProvider(settings.toss, data_dir=settings.data_dir)
    logger.info("샘플 데이터 공급자 사용 (API 키 없음 또는 provider=sample)")
    return SampleProvider(data_dir=settings.data_dir)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = load_settings()
    app.state.settings = settings
    # 캐시 래퍼: 같은 종목 반복/동시 조회 시 실제 API 호출은 TTL 당 1회
    app.state.provider = CachingProvider(build_provider(settings))
    yield
    if hasattr(app.state.provider, "aclose"):
        await app.state.provider.aclose()


app = FastAPI(title="이평선 레이더 — 주요 지지/저항 이동평균선 분석기", lifespan=lifespan)
# 전체 기간 분석 응답은 수백 KB 를 넘을 수 있어 압축 필수
app.add_middleware(GZipMiddleware, minimum_size=1024)

# 퍼블릭 배포용 간단 보호: SITE_PASSWORD 환경변수를 설정하면
# 모든 요청에 HTTP Basic 인증(아이디 아무거나 + 이 비밀번호)을 요구한다.
SITE_PASSWORD = os.environ.get("SITE_PASSWORD", "")


def _password_ok(auth_header: str | None) -> bool:
    if not auth_header or not auth_header.lower().startswith("basic "):
        return False
    try:
        decoded = base64.b64decode(auth_header.split(" ", 1)[1]).decode("utf-8")
    except Exception:
        return False
    _, _, password = decoded.partition(":")
    return secrets.compare_digest(password, SITE_PASSWORD)


@app.middleware("http")
async def require_password(request: Request, call_next):
    # /api/health 는 호스팅 플랫폼의 생존 확인용이라 인증 예외 (민감정보 없음)
    if (
        SITE_PASSWORD
        and request.url.path != "/api/health"
        and not _password_ok(request.headers.get("Authorization"))
    ):
        return Response(
            status_code=401,
            content="인증이 필요합니다.",
            headers={"WWW-Authenticate": 'Basic realm="ma-radar"'},
        )
    return await call_next(request)


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
    # 종목코드/티커 형식만 허용 (경로 문자 등 차단)
    symbol: str = Query(..., min_length=1, max_length=20,
                        pattern=r"^[A-Za-z0-9.\-]+$"),
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
