"""FastAPI 서버: 정적 프런트엔드 + 검색/분석 API."""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import secrets
import socket
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, RedirectResponse, Response
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
    provider = settings.provider
    if provider == "toss":
        if not settings.toss.configured:
            raise RuntimeError(
                "provider=toss 인데 TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 없습니다."
            )
        logger.info("토스증권 Open API 공급자 사용 (base=%s)", settings.toss.base_url)
        return TossProvider(settings.toss, data_dir=settings.data_dir)
    if provider == "sample":
        logger.info("샘플 데이터 공급자 사용 (provider=sample)")
        return SampleProvider(data_dir=settings.data_dir)
    # 기본값(auto/free): 키·IP 제한이 없는 무료 소스 (공개 배포에 적합)
    if provider not in ("auto", "free"):
        logger.warning("알 수 없는 provider=%r — 무료 공급자로 대체합니다.", provider)
    logger.info("무료 시세 공급자 사용 (FinanceDataReader/Yahoo, provider=%s)", provider)
    from .providers.free_data import FreeDataProvider
    return FreeDataProvider(data_dir=settings.data_dir)


def _kr_fallback_universe(settings: Settings, provider: Provider) -> list:
    """상장목록을 못 받아올 때의 국내 폴백: 샘플 유니버스 또는 내장 사전
    (+ data/symbols.csv 확장분)."""
    from .providers.base import SymbolInfo
    if provider.name == "sample":
        from .providers.sample import UNIVERSE
        return list(UNIVERSE)
    from .providers.kr_symbols import BUILTIN_KR_SYMBOLS, SymbolDictionary
    seen: set[str] = set()
    out: list[SymbolInfo] = []
    for sym, name, market in BUILTIN_KR_SYMBOLS:
        if sym not in seen:
            seen.add(sym)
            out.append(SymbolInfo(sym, name, market))
    for sym, name, market in SymbolDictionary(settings.data_dir)._csv_entries():
        if sym not in seen:
            seen.add(sym)
            out.append(SymbolInfo(sym, name, market))
    return out


@asynccontextmanager
async def lifespan(app: FastAPI):
    from .pattern_scan import INDEX_SYMBOL, US_FALLBACK, PatternScanner, make_universe_fn
    from .providers.base import SymbolInfo
    from .touch_scan import TouchScanner

    # 업스트림 라이브러리(FDR/yfinance 내부 requests)가 소켓 타임아웃 없이
    # 요청을 여는 경우가 있어, 블랙홀 커넥션에 걸린 스레드가 몇 시간씩 살아남아
    # 기본 스레드 실행기를 잠식할 수 있다. 전역 기본 타임아웃이 안전망이 된다
    # (asyncio 소켓은 논블로킹이라 영향 없음, httpx 는 자체 타임아웃 사용).
    socket.setdefaulttimeout(30)

    settings = load_settings()
    app.state.settings = settings
    # 캐시 래퍼: 같은 종목 반복/동시 조회 시 실제 API 호출은 TTL 당 1회
    provider = CachingProvider(build_provider(settings))
    app.state.provider = provider
    kr_fallback = _kr_fallback_universe(settings, provider)
    us_fallback = [SymbolInfo(*t) for t in US_FALLBACK]
    universe_fns = {
        "kr": make_universe_fn(provider, "kr", kr_fallback),
        "us": make_universe_fn(provider, "us", us_fallback),
    }
    app.state.scanners = {
        m: PatternScanner(provider, universe_fns[m], INDEX_SYMBOL[m])
        for m in ("kr", "us")
    }
    app.state.touch_scanners = {
        m: TouchScanner(provider, universe_fns[m],
                        candidates=settings.candidates["day"],
                        min_touches=settings.min_touches["day"])
        for m in ("kr", "us")
    }
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


@app.get("/api/patterns")
async def patterns_api(
    pattern: str = Query("stage2", pattern=r"^(stage2|triangle|head_shoulders|inv_head_shoulders|cup_handle)$"),
    market: str = Query("kr", pattern=r"^(kr|us)$"),
):
    """패턴 스크리너: 스캔 상태 또는 상위 매칭 반환 (프런트가 폴링)."""
    snap = await app.state.scanners[market].snapshot()
    if snap["status"] != "done":
        return snap
    matches = snap["patterns"].get(pattern) or []
    return {
        "status": "done",
        "pattern": pattern,
        "market": market,
        "scanned": snap.get("scanned"),
        "universe": snap.get("universe"),
        "elapsedSec": snap.get("elapsedSec"),
        "refreshing": bool(snap.get("refreshing")),  # 만료 결과 재스캔 중 여부
        "matches": matches[:4],  # 요청 스펙: 3~4개
        "totalMatches": len(matches),
    }


# 헤더 시세 티커에 보여줄 주요 지수 (FDR 표기)
INDEX_TICKER = [
    ("KS11", "코스피"), ("KQ11", "코스닥"),
    ("US500", "S&P 500"), ("IXIC", "나스닥"),
]


@app.get("/api/indices")
async def indices():
    """주요 지수 스냅샷 — 헤더 티커용. 실패한 지수는 조용히 생략한다."""
    async def one(sym: str, name: str):
        try:
            # 300봉 요청: 패턴 스캐너의 지수(RS) 조회와 같은 크기로 맞춰
            # 캐시 항목 하나를 공유한다 (5봉으로 받으면 스캐너가 재페치)
            df = await app.state.provider.candles(sym, "day", 300)
            if len(df) < 2:
                return None
            last = float(df["close"].iloc[-1])
            prev = float(df["close"].iloc[-2])
            if prev <= 0:
                return None
            return {
                "key": sym, "name": name, "value": round(last, 2),
                "changePct": round(last / prev * 100 - 100, 2),
                "date": df["date"].iloc[-1].strftime("%m/%d"),
            }
        except Exception:  # noqa: BLE001 — 지수 하나 실패로 티커 전체가 죽지 않게
            logger.info("지수 조회 실패: %s", sym)
            return None

    rows = await asyncio.gather(*(one(s, n) for s, n in INDEX_TICKER))
    return {"indices": [r for r in rows if r]}


@app.get("/api/touches")
async def touches_api(market: str = Query("kr", pattern=r"^(kr|us)$")):
    """오늘의 지지선 터치: 스캔 상태 또는 상위 매칭 반환 (프런트가 폴링)."""
    snap = await app.state.touch_scanners[market].snapshot()
    if snap["status"] != "done":
        return snap
    return {
        "status": "done",
        "market": market,
        "scanned": snap.get("scanned"),
        "universe": snap.get("universe"),
        "elapsedSec": snap.get("elapsedSec"),
        "refreshing": bool(snap.get("refreshing")),
        "matches": snap.get("matches") or [],
        "totalMatches": snap.get("totalMatches", 0),
    }


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def home(request: Request):
    """랜딩 홈: 도구별 소개 카드 -> /ma, /patterns 로 이동."""
    # 옛 딥링크(/?symbol=005930) 호환: 이평선 분석 페이지로 넘겨준다
    if request.query_params.get("symbol"):
        return RedirectResponse(url=f"/ma?{request.url.query}", status_code=307)
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/ma")
async def ma_page():
    return FileResponse(STATIC_DIR / "ma.html")


@app.get("/patterns")
async def patterns_page():
    return FileResponse(STATIC_DIR / "patterns.html")


@app.get("/touches")
async def touches_page():
    return FileResponse(STATIC_DIR / "touches.html")


@app.get("/about")
async def about_page():
    """원토피아 회사 소개."""
    return FileResponse(STATIC_DIR / "about.html")
