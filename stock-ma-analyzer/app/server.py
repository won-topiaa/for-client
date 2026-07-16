"""FastAPI 서버: 정적 프런트엔드 + 검색/분석 API."""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import secrets
import socket
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    RedirectResponse,
    Response,
)
from fastapi.staticfiles import StaticFiles

from .auth import (
    COOKIE_NAME,
    SESSION_TTL_SEC,
    AuthError,
    AuthStore,
    EmailTaken,
    InvalidCredentials,
)
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
    # candles 조회 wait_for(25초)보다 짧게 잡아, hang 소켓이 wait_for 취소 직후
    # 스스로 죽어 페치 스레드가 오래 남지 않게 한다.
    socket.setdefaulttimeout(20)

    settings = load_settings()
    app.state.settings = settings
    # 회원 인증 저장소 (SQLite). 시작 시 만료 세션 정리.
    app.state.auth = AuthStore()
    app.state.auth.purge_expired()
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
    # 진행 중인 백그라운드 스캔을 정리하고 종료 — 안 하면 "Task was destroyed
    # but it is pending!" 경고와 함께 행 스레드가 셧다운을 지연시킨다
    for scanner in (list(app.state.scanners.values())
                    + list(app.state.touch_scanners.values())):
        task = scanner._task
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
    if hasattr(app.state.provider, "aclose"):
        await app.state.provider.aclose()
    app.state.auth.close()


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
        _, _, password = decoded.partition(":")
        # bytes 로 비교: compare_digest 는 비ASCII 문자열에서 TypeError 를 던져
        # 공격자가 헤더 하나로 500 을 유발할 수 있었다 (타이밍 안전성은 동일)
        return secrets.compare_digest(password.encode("utf-8"),
                                      SITE_PASSWORD.encode("utf-8"))
    except Exception:
        return False


# /api/analyze 는 요청마다 업스트림 페치 + CPU 분석이 도는 증폭 지점이라
# IP 당 분당 호출 수를 제한한다 (같은 종목 반복은 어차피 캐시가 흡수).
ANALYZE_RATE_LIMIT_PER_MIN = 30
_rate_windows: dict[str, tuple[float, int]] = {}


def _client_ip(request: Request) -> str:
    # XFF 는 「클라이언트가 보낸 값들, ..., 마지막 프록시가 덧붙인 실제 접속 IP」
    # 형태다. 첫 항목은 클라이언트가 마음대로 위조할 수 있어 (요청마다 바꾸면
    # 제한 우회) 신뢰할 수 있는 마지막 홉을 쓴다 (Render 등 단일 LB 전제).
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[-1].strip()
    return request.client.host if request.client else "?"


def _rate_limited(key: str) -> bool:
    """key(보통 "버킷:IP") 기준 분당 호출 제한. 버킷을 나눠, 로그인 무차별
    대입이 분석 호출 예산을 갉아먹거나 그 반대가 되지 않게 한다."""
    now = time.time()
    window, count = _rate_windows.get(key, (now, 0))
    if now - window >= 60.0:
        window, count = now, 0
    count += 1
    if len(_rate_windows) > 10_000:  # 메모리 보호
        # 전체 초기화는 다량의 가짜 IP 로 정상 사용자들의 창까지 리셋시키는
        # 우회 수단이 된다 — 오래된(=대부분 만료된) 창부터 절반만 비운다
        for k in sorted(_rate_windows, key=lambda k: _rate_windows[k][0])[:5_000]:
            _rate_windows.pop(k, None)
    _rate_windows[key] = (window, count)
    return count > ANALYZE_RATE_LIMIT_PER_MIN


# 공용 배포 기본 보안 헤더 — 미들웨어와 조기응답(429/401) 양쪽에서 함께 쓴다.
_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
        "base-uri 'none'; frame-ancestors 'none'"
    ),
}


@app.middleware("http")
async def security_headers(request: Request, call_next):
    """공용 배포용 기본 보안 헤더 — esc() 뒤의 2차 방어선.

    스크립트는 전부 자체 호스팅(인라인 <script> 없음)이라 script-src 'self' 로
    조여도 깨지지 않는다. 인라인 style 속성은 쓰므로 unsafe-inline 유지,
    파비콘이 data: URI 라 img-src 에 data: 허용.
    """
    response = await call_next(request)
    for name, value in _SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    return response


# 증폭/무차별 대입 방지를 위해 IP당 분당 호출을 제한하는 경로
_RATE_LIMITED_PATHS = frozenset(
    {"/api/analyze", "/api/auth/login", "/api/auth/signup"}
)


@app.middleware("http")
async def require_password(request: Request, call_next):
    path = request.url.path
    if path in _RATE_LIMITED_PATHS:
        bucket = "auth" if path.startswith("/api/auth/") else "analyze"
        if _rate_limited(f"{bucket}:{_client_ip(request)}"):
            # 조기 응답도 보안 헤더를 달아 내보낸다 (이 미들웨어가 바깥이라
            # security_headers 가 실행되지 않으므로 직접 붙인다)
            return Response(
                status_code=429,
                content="요청이 너무 잦습니다 — 잠시 후 다시 시도해 주세요.",
                headers={"Retry-After": "30", **_SECURITY_HEADERS},
                media_type="text/plain; charset=utf-8",
            )
    # /api/health 는 호스팅 플랫폼의 생존 확인용이라 인증 예외 (민감정보 없음)
    if (
        SITE_PASSWORD
        and request.url.path != "/api/health"
        and not _password_ok(request.headers.get("Authorization"))
    ):
        return Response(
            status_code=401,
            content="인증이 필요합니다.",
            headers={"WWW-Authenticate": 'Basic realm="ma-radar"', **_SECURITY_HEADERS},
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


# 동시 접속자(현재 사이트를 보고 있는 방문자) 근사 집계 — 각 브라우저가
# 주기적으로 하트비트를 보내면, 최근 _PRESENCE_TTL 초 안에 신호를 준 고유
# 방문자 수를 센다. 서버 메모리에만 두므로(단일 워커) 재시작 시 0부터 다시
# 세고, 저장하는 것은 임의의 클라이언트 ID뿐이라 개인정보가 아니다.
_PRESENCE_TTL_SEC = 75.0
_PRESENCE_MAX = 50000          # 폭주 방어: 이 이상은 새 방문자를 더 담지 않는다
_presence: dict[str, float] = {}


@app.get("/api/presence")
async def presence(cid: str = Query("", max_length=64, pattern=r"^[A-Za-z0-9_-]*$")):
    """동시 접속자 근사치. 방문자별 하트비트를 받아 활성 수를 돌려준다."""
    now = time.monotonic()
    # 오래된 방문자 정리 (반복마다 만료분 제거 — 딕셔너리가 활성 창 크기로 유지)
    stale = [k for k, seen in _presence.items() if now - seen > _PRESENCE_TTL_SEC]
    for k in stale:
        _presence.pop(k, None)
    if cid and (cid in _presence or len(_presence) < _PRESENCE_MAX):
        _presence[cid] = now
    return {"active": len(_presence)}


# ── 회원 인증 (이메일 가입/로그인) — '오늘의 지지선 터치' 게이팅용 ──
def _cookie_secure(request: Request) -> bool:
    # 프로덕션(https)에서만 Secure 쿠키를 건다. Render 는 X-Forwarded-Proto 로
    # https 를 알려주고, 로컬 http 테스트에서는 Secure 를 빼 쿠키가 정상 왕복한다.
    return (request.url.scheme == "https"
            or request.headers.get("x-forwarded-proto", "").lower() == "https")


async def _current_user(request: Request) -> dict | None:
    """세션 쿠키로 로그인한 사용자 {'id','email'} 또는 None (DB 조회는 스레드로)."""
    return await asyncio.to_thread(
        request.app.state.auth.user_for_token, request.cookies.get(COOKIE_NAME))


async def _auth_json(request: Request) -> tuple[str, str]:
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — 잘못된 JSON 은 400 으로
        raise HTTPException(400, "요청 형식이 올바르지 않습니다.")
    if not isinstance(body, dict):
        raise HTTPException(400, "요청 형식이 올바르지 않습니다.")
    return str(body.get("email", "")), str(body.get("password", ""))


def _session_response(email: str, token: str, request: Request) -> JSONResponse:
    resp = JSONResponse({"email": email.strip().lower()})
    resp.set_cookie(COOKIE_NAME, token, max_age=SESSION_TTL_SEC, httponly=True,
                    samesite="lax", secure=_cookie_secure(request), path="/")
    return resp


@app.post("/api/auth/signup")
async def auth_signup(request: Request):
    email, password = await _auth_json(request)
    try:
        token = await asyncio.to_thread(request.app.state.auth.signup, email, password)
    except EmailTaken as exc:
        raise HTTPException(409, str(exc))
    except AuthError as exc:
        raise HTTPException(400, str(exc))
    return _session_response(email, token, request)


@app.post("/api/auth/login")
async def auth_login(request: Request):
    email, password = await _auth_json(request)
    try:
        token = await asyncio.to_thread(request.app.state.auth.login, email, password)
    except InvalidCredentials as exc:
        raise HTTPException(401, str(exc))
    except AuthError as exc:
        raise HTTPException(400, str(exc))
    return _session_response(email, token, request)


@app.post("/api/auth/logout")
async def auth_logout(request: Request):
    await asyncio.to_thread(request.app.state.auth.logout, request.cookies.get(COOKIE_NAME))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


@app.get("/api/auth/me")
async def auth_me(request: Request):
    user = await _current_user(request)
    if not user:
        raise HTTPException(401, "로그인이 필요합니다.")
    return {"email": user["email"]}


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
        "partial": bool(snap.get("partial")),        # 시간예산으로 일부만 훑음
        "generatedAt": snap.get("generatedAt"),      # 스캔 고유 식별자
        "matches": matches[:4],  # 요청 스펙: 3~4개
        "totalMatches": len(matches),
    }


# 헤더 시세 티커에 보여줄 주요 지수 (FDR 표기)
INDEX_TICKER = [
    ("KS11", "코스피"), ("KQ11", "코스닥"),
    ("US500", "S&P 500"), ("IXIC", "나스닥"),
]


# 티커 지수는 30분 캔들 캐시를 우회해 짧게(2분) 따로 캐시한다 — 장중에 지수가
# 실제로 움직이는 것을 보여주기 위함(무료 소스의 일봉 마지막 값은 장중에 현재가로
# 갱신된다). 2분 간격이면 저빈도라 야후 등 소스에 부담도 없다.
_INDICES_TTL_SEC = 120.0
_indices_cache: dict[str, Any] = {"ts": -1e9, "data": None}
_indices_last_good: dict[str, dict] = {}  # 실패한 지수는 직전 값을 유지(티커 안정)


@app.get("/api/indices")
async def indices():
    """주요 지수 스냅샷 — 헤더 티커용. 2분 캐시 + 신선 조회(캔들 30분 캐시 우회)."""
    import time as _time

    now = _time.monotonic()
    if (_indices_cache["data"] is not None
            and now - _indices_cache["ts"] < _INDICES_TTL_SEC):
        return _indices_cache["data"]

    # 30분 캔들 캐시를 우회해 원 공급자에서 최신 일봉을 직접 받는다 (장중 갱신 반영)
    inner = getattr(app.state.provider, "inner", app.state.provider)

    async def one(sym: str, name: str):
        try:
            df = await inner.candles(sym, "day", 10)
            if len(df) >= 2:
                last = float(df["close"].iloc[-1])
                prev = float(df["close"].iloc[-2])
                if prev > 0:
                    row = {
                        "key": sym, "name": name, "value": round(last, 2),
                        "changePct": round(last / prev * 100 - 100, 2),
                        "date": df["date"].iloc[-1].strftime("%m/%d"),
                    }
                    _indices_last_good[sym] = row
                    return row
        except Exception:  # noqa: BLE001 — 지수 하나 실패로 티커 전체가 죽지 않게
            logger.info("지수 조회 실패: %s", sym)
        return _indices_last_good.get(sym)  # 이번에 실패하면 직전 값 유지

    rows = await asyncio.gather(*(one(s, n) for s, n in INDEX_TICKER))
    data = {"indices": [r for r in rows if r]}
    if data["indices"]:  # 전부 실패면 캐시하지 않아 다음 호출이 곧바로 재시도
        _indices_cache["data"] = data
        _indices_cache["ts"] = now
    return data


@app.get("/api/touches")
async def touches_api(request: Request, market: str = Query("kr", pattern=r"^(kr|us)$")):
    """오늘의 지지선 터치: 스캔 상태 또는 상위 매칭 반환 (프런트가 폴링).

    회원 전용 — 로그인하지 않았으면 401 (프런트가 /login 으로 보낸다)."""
    if not await _current_user(request):
        raise HTTPException(401, "로그인이 필요합니다.")
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
        "partial": bool(snap.get("partial")),    # 시간예산으로 일부만 훑음
        "generatedAt": snap.get("generatedAt"),  # 스캔 고유 식별자
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
async def touches_page(request: Request):
    """회원 전용 — 로그인 안 했으면 로그인 페이지로 보낸다 (로그인 후 되돌아옴)."""
    if not await _current_user(request):
        return RedirectResponse(url="/login?next=%2Ftouches", status_code=302)
    return FileResponse(STATIC_DIR / "touches.html")


def _safe_next(nxt: str) -> str:
    """오픈 리다이렉트 방지 — 사이트 내부 절대경로만 허용한다.
    '/'로 시작해도 '//' 또는 '/\\' 로 시작하면 프로토콜-상대 URL 이라 외부(예:
    //evil.com → http://evil.com)로 튀므로 막는다."""
    if (not nxt or not nxt.startswith("/")
            or nxt.startswith("//") or nxt.startswith("/\\")):
        return "/touches"
    return nxt


@app.get("/login")
async def login_page(request: Request):
    """이메일 로그인/가입 페이지. 이미 로그인했으면 목적지(next)로 넘긴다."""
    if await _current_user(request):
        return RedirectResponse(
            url=_safe_next(request.query_params.get("next", "/touches")),
            status_code=302,
        )
    return FileResponse(STATIC_DIR / "login.html")


@app.get("/about")
async def about_page():
    """원토피아 회사 소개."""
    return FileResponse(STATIC_DIR / "about.html")


@app.get("/privacy")
async def privacy_page():
    """개인정보처리방침 (회원 이메일 수집 고지)."""
    return FileResponse(STATIC_DIR / "privacy.html")
