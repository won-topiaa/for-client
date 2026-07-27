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


async def _prewarm_until_frozen(targets, deadline_sec: float = 5400.0,
                                kick_gap_sec: float = 1.0,
                                round_gap_sec: float = 70.0) -> bool:
    """모든 스캐너가 '완주(하루 고정) + 신선'이 될 때까지 스냅숏을 반복한다.

    snapshot() 은 방문자의 폴링과 같은 효과 — stale 이면 스캔을 킥하고, 부분/
    실패로 끝난 스캔은 쿨다운(60초)이 지나면 다음 라운드에서 자연히 재시작된다.
    이렇게 '봐주지' 않으면 첫 스캔이 부분으로 끝난 시장(주로 미국)은 방문자가
    올 때까지 방치된다. 완료 시 True, 시한(기본 90분) 초과 시 False.
    round_gap(70초)은 부분 결과 쿨다운·휴지(60초)보다 약간 길게 잡는다."""
    from .pattern_scan import SCAN_SOFT_BUDGET_SEC

    start = time.monotonic()
    while True:
        pending = False
        for sc in targets:
            try:
                await sc.snapshot()
                # 순차 예열: 이 스캐너의 스캔이 끝날 때까지 기다렸다 다음으로.
                # 4개를 동시에 터뜨리면 부팅/아침 직후 업스트림에 요청이 몰려
                # 전면 차단(fail-fast) → 방문자에게 '스캔 실패'가 보일 확률이
                # 커진다. 방문자 트리거 스캔은 그대로 동시 허용 — 예열만 순하게.
                task = getattr(sc, "_task", None)
                if task is not None and not task.done():
                    await asyncio.wait({task}, timeout=SCAN_SOFT_BUDGET_SEC + 60)
            except Exception:  # noqa: BLE001
                logger.warning("예열 스냅샷 실패", exc_info=True)
            if not (sc._daily_frozen and sc._fresh()):
                pending = True
            await asyncio.sleep(kick_gap_sec)  # 스캔 사이 간격 (업스트림 배려)
        if not pending:
            return True
        if time.monotonic() - start > deadline_sec:
            logger.warning("예열 시한 초과 — 나머지는 방문자 폴링이 이어받는다")
            return False
        await asyncio.sleep(round_gap_sec)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from .pattern_scan import INDEX_SYMBOL, US_FALLBACK, PatternScanner, make_universe_fn
    from .providers.base import SymbolInfo
    from .touch_scan import TouchScanner

    # 표준 socket 모듈을 직접 쓰는 코드용 전역 기본 타임아웃. 주의: requests/
    # urllib3 에는 적용되지 않는다(timeout=None 을 '무한 대기'로 그대로 쓴다) —
    # FDR 내부의 timeout 없는 requests 호출은 free_data 의
    # _install_requests_default_timeout() 이 별도로 유한하게 만든다.
    socket.setdefaulttimeout(20)

    settings = load_settings()
    app.state.settings = settings
    # 회원 인증 저장소 (SQLite/Postgres). 초기화(=첫 DB 연결 + 스키마 생성)에
    # 시간 상한을 둔다 — 상한 없이 걸리면 서버가 리슨 소켓도 못 연 채 좀비로
    # 남는다. 초과 시 명확히 실패시켜 플랫폼이 재시작하게 한다.
    # (connect_timeout=10 × 재시도 5회 + 백오프 ≈ 최악 80초 < 90초)
    try:
        app.state.auth = await asyncio.wait_for(asyncio.to_thread(AuthStore), 90)
    except asyncio.TimeoutError:
        # raise 만으로는 프로세스가 안 죽는다: to_thread 워커가 libpq 안에서
        # 계속 블록돼 있고, 종료 경로(loop.shutdown_default_executor 와
        # threading._shutdown)가 그 스레드를 join 하며 매달린다 — 리슨 소켓도
        # 못 연 채 영원히 살아 있는 좀비가 되어 플랫폼이 재시작도 못 시킨다.
        # 로그를 남기고 즉시 죽여 재시작을 받는다.
        logger.critical("인증 DB 초기화 90초 초과 — DATABASE_URL 대상 응답 없음. "
                        "프로세스를 종료해 재시작을 유도합니다.")
        os._exit(1)
    # 시작 시 만료 세션 정리 — 부가 작업이므로 실패해도 부팅을 막지 않는다.
    try:
        await asyncio.wait_for(asyncio.to_thread(app.state.auth.purge_expired), 15)
    except Exception:  # noqa: BLE001
        logger.warning("시작 시 만료 세션 정리 실패 (계속 진행)", exc_info=True)
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
        m: PatternScanner(provider, universe_fns[m], INDEX_SYMBOL[m], market=m)
        for m in ("kr", "us")
    }
    app.state.touch_scanners = {
        m: TouchScanner(provider, universe_fns[m],
                        candidates=settings.candidates["day"],
                        min_touches=settings.min_touches["day"], market=m)
        for m in ("kr", "us")
    }
    # 맞춤 이평선 스크리너: (시장, 기간)별 스캐너를 요청 시 lazily 생성.
    # 시세 캐시는 위 스캐너들과 공유되므로 추가 비용은 CPU 계산뿐이다.
    app.state.universe_fns = universe_fns
    app.state.line_scanners = {}
    # (시장, 기간)별 마지막 스캔 종료 시각·재시도 휴지 — 스캐너 인스턴스가
    # 등록소에서 퇴출돼도 살아남는다. 없으면 '퇴출→재생성'이 쿨다운·백오프를
    # 초기화해, 키를 바꿔가며 요청하는 것만으로 무한 스캔을 돌릴 수 있다.
    # 키 공간이 유한(시장 2 × 기간 246)해 크기도 자연히 유계다.
    app.state.line_cooldowns = {}
    # 마지막 '고정 결과 회수' 시각 — 3순위 회수의 전역 간격 제한용
    app.state.line_frozen_evict_ts = 0.0

    # 하루 한 번(아침) 자동 예열: 갱신 시각이 지나면 패턴·터치 스캐너(국내+미국
    # 전부)를 미리 돌려둔다 → 아침 첫 방문자가 몇 분짜리 스캔을 기다리지 않는다.
    # 스캔을 '한 번 툭 치고' 끝내면 첫 시도가 부분/실패로 끝난 시장(주로 미국 —
    # 야후 페이싱·세마포어 경쟁)은 다음 방문자가 올 때까지 방치된다. 그래서
    # 네 스캐너 모두 완주(하루 고정)될 때까지 폴링 방문자처럼 반복해서 킥한다.
    # (맞춤선은 기간별 on-demand 라 예열 대상에서 제외)
    prewarm_targets = (list(app.state.scanners.values())
                       + list(app.state.touch_scanners.values()))

    async def _daily_prewarm() -> None:
        from .pattern_scan import _next_daily_boundary
        # 부팅 직후 10초 유예 — 배포 전환(헬스체크·트래픽 이동)이 끝난 뒤에
        # 예열을 시작해, 재시작 순간의 업스트림 요청 폭주를 피한다
        await asyncio.sleep(10)
        while True:
            # 예상 못 한 예외로 예열 루프가 조용히 죽으면 이후 매일 아침 예열이
            # 전부 사라진다 — 한 사이클의 어떤 실패도 다음 사이클을 막지 않게
            # 감싼다. (그래도 방문자 폴링 = 예열과 동일 효과라는 최종 안전망 존재)
            try:
                # 부팅 직후/경계 통과 후 — 방문자 없이도 결과가 준비되게
                ok = await _prewarm_until_frozen(prewarm_targets)
                if not ok:
                    # 아침 상류 장애가 90분+ 지속 — 내일까지 포기하면 방문자
                    # 없는 시장은 하루 종일 비어 있다. 30분 뒤 다시 봐준다.
                    await asyncio.sleep(1800)
                    continue
                # 하루 한 번 만료 세션 정리 (부팅 시 1회 + 매 아침) — 로그인이
                # 쌓기만 하고 지우는 곳이 없으면 무료 DB 가 세션 행으로 붓는다
                try:
                    await asyncio.wait_for(
                        asyncio.to_thread(app.state.auth.purge_expired), 15)
                except Exception:  # noqa: BLE001
                    logger.warning("만료 세션 정리 실패 (계속)", exc_info=True)
                now = time.time()
                # 경계 +5초: 통과 직후 _fresh 가 확실히 stale 로 판정되게 여유
                await asyncio.sleep(max(1.0, _next_daily_boundary(now) - now + 5))
            except asyncio.CancelledError:
                raise                      # 종료 시그널은 그대로 전파
            except Exception:  # noqa: BLE001
                logger.exception("예열 사이클 실패 — 60초 후 계속")
                await asyncio.sleep(60)

    if settings.provider != "sample" or os.getenv("FORCE_PREWARM") == "1":
        app.state.prewarm_task = asyncio.create_task(_daily_prewarm())
    else:
        # 샘플(테스트/데모) 모드: 합성 데이터 예열은 의미가 없고, 테스트마다
        # 백그라운드 스캔 4개가 본문과 경쟁해 스위트만 분 단위로 느려진다
        app.state.prewarm_task = None
    yield
    # 예열 스케줄러 먼저 정리 — 종료 중 새 스캔을 킥하지 않게
    pw = getattr(app.state, "prewarm_task", None)
    if pw is not None and not pw.done():
        pw.cancel()
        try:
            await pw
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
    # 진행 중인 백그라운드 스캔을 정리하고 종료 — 안 하면 "Task was destroyed
    # but it is pending!" 경고와 함께 행 스레드가 셧다운을 지연시킨다
    for scanner in (list(app.state.scanners.values())
                    + list(app.state.touch_scanners.values())
                    + list(app.state.line_scanners.values())):
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
# 전체 기간 분석 응답은 수백 KB 를 넘을 수 있어 압축 필수.
# compresslevel 기본값(9)은 6 대비 CPU 를 ~3배 쓰면서 크기 이득은 몇 %뿐 —
# 단일 워커 이벤트 루프에서 압축이 돌므로 6 이 폴링 응답에 알맞다.
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)

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


# /api/analyze·/api/search 는 요청마다 업스트림 페치/CPU 스캔이 도는 증폭
# 지점이라 IP 당 분당 호출 수를 제한한다 (같은 종목 반복은 어차피 캐시가 흡수).
# 버킷별 상한: 로그인 무차별대입·분석은 30/분, 검색은 자동완성이라 좀 더 넉넉히.
# 가입은 대량 이메일 프로빙·쓰레기 계정 생성을 늦추기 위해 더 좁게 (정상
# 사용자는 가입을 분당 몇 번씩 시도하지 않는다), presence 는 하트비트(45초
# 간격 1회)라 널널한 상한으로 봇의 CPU 소모만 막는다.
ANALYZE_RATE_LIMIT_PER_MIN = 30   # auth(로그인)·analyze 버킷 공용
SEARCH_RATE_LIMIT_PER_MIN = 60    # 검색(자동완성)은 사람 타이핑이라 넉넉히
SIGNUP_RATE_LIMIT_PER_MIN = 10    # 가입: 오탈자 재시도는 넉넉히, 대량 생성은 차단
PRESENCE_RATE_LIMIT_PER_MIN = 60  # 하트비트 정상치(1~2/분)의 30배 여유
# 맞춤선 스크리너: 정상 폴링은 2초 간격(30/분), 두 탭이어도 60/분 — 그 2배.
# (기간, 시장) 조합마다 새 스캔을 유발할 수 있는 증폭 지점이라 상한이 필수다.
LINES_RATE_LIMIT_PER_MIN = 120
# 터치 폴링도 같은 예산 — 위조 세션 쿠키를 바꿔가며 DB 조회를 무한 유발하는
# 증폭(캐시 미스마다 SELECT)을 막는다
TOUCHES_RATE_LIMIT_PER_MIN = 120
# 패턴 스크리너 폴링 — 매 호출이 매칭 수백 봉을 직렬화·압축하는 CPU 증폭
# 지점이라 다른 스크리너와 같은 예산으로 묶는다 (없으면 유일하게 무제한이었다).
PATTERNS_RATE_LIMIT_PER_MIN = 120
# 회원 전용 페이지(HTML)도 진입 때마다 세션 조회(캐시 미스 시 DB SELECT)를
# 한다 — 쿠키를 바꿔가며 때리는 증폭을 막되, 정상 탐색은 절대 막지 않을 만큼
# 넉넉하게.
PAGE_RATE_LIMIT_PER_MIN = 120
_rate_windows: dict[str, tuple[float, int]] = {}

_RATE_LIMITS = {
    "search": lambda: SEARCH_RATE_LIMIT_PER_MIN,
    "signup": lambda: SIGNUP_RATE_LIMIT_PER_MIN,
    "presence": lambda: PRESENCE_RATE_LIMIT_PER_MIN,
    "lines": lambda: LINES_RATE_LIMIT_PER_MIN,
    "touches": lambda: TOUCHES_RATE_LIMIT_PER_MIN,
    "patterns": lambda: PATTERNS_RATE_LIMIT_PER_MIN,
    "page": lambda: PAGE_RATE_LIMIT_PER_MIN,
}


def _rate_limit_for(bucket: str) -> int:
    """버킷별 분당 상한 (상수를 런타임에 읽어 테스트의 monkeypatch 도 반영)."""
    fn = _RATE_LIMITS.get(bucket)
    return fn() if fn else ANALYZE_RATE_LIMIT_PER_MIN


def _client_ip(request: Request) -> str:
    # XFF 는 「클라이언트가 보낸 값들, ..., 마지막 프록시가 덧붙인 실제 접속 IP」
    # 형태다. 첫 항목은 클라이언트가 마음대로 위조할 수 있어 (요청마다 바꾸면
    # 제한 우회) 신뢰할 수 있는 마지막 홉을 쓴다 (Render 등 단일 LB 전제).
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[-1].strip()
    return request.client.host if request.client else "?"


def _rate_limited(key: str, limit: int = ANALYZE_RATE_LIMIT_PER_MIN) -> bool:
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
    return count > limit


# 공용 배포 기본 보안 헤더 — 미들웨어와 조기응답(429/401) 양쪽에서 함께 쓴다.
_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    # 이메일·비밀번호를 https 로 받는 사이트라 HSTS 로 http 다운그레이드를 막는다
    # (Render 는 항상 https 종단이라 안전). 2년 + 서브도메인 포함.
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
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
# 세션 조회(캐시 미스 시 DB SELECT)를 유발하는 HTML 페이지들
_MEMBER_PAGES = frozenset({"/touches", "/lines", "/login"})

_RATE_LIMITED_PATHS = frozenset(
    {"/api/analyze", "/api/search", "/api/presence", "/api/lines",
     "/api/touches", "/api/patterns", "/api/indices/spark",
     "/api/auth/login", "/api/auth/signup", "/api/auth/me", "/api/auth/logout"}
    | _MEMBER_PAGES
)


def _rate_bucket(path: str) -> str:
    """경로 → 레이트리밋 버킷. 인증·가입·검색·분석·하트비트를 분리해
    한쪽의 소진·남용이 다른 쪽 예산을 갉아먹지 않게 한다."""
    if path == "/api/auth/signup":
        return "signup"
    if path.startswith("/api/auth/"):
        return "auth"
    if path == "/api/search":
        return "search"
    if path == "/api/presence":
        return "presence"
    if path == "/api/lines":
        return "lines"
    if path == "/api/touches":
        return "touches"
    if path == "/api/patterns":
        return "patterns"
    if path == "/api/indices/spark":
        return "page"
    if path in _MEMBER_PAGES:
        return "page"
    return "analyze"


def _plain(status: int, msg: str, extra: dict | None = None) -> Response:
    """미들웨어 조기 응답 공통 꼴 — 보안 헤더를 항상 싣는다."""
    return Response(status_code=status, content=msg,
                    headers={**(extra or {}), **_SECURITY_HEADERS},
                    media_type="text/plain; charset=utf-8")


def _same_origin(request: Request) -> bool:
    """Origin 헤더가 있으면 요청 호스트와 일치해야 한다 (CSRF 방어).

    브라우저는 모든 크로스사이트 POST 에 Origin 을 싣는다 — 불일치는 다른
    사이트에서 쏜 요청. 헤더가 없으면(curl·구형 클라이언트·테스트) 통과."""
    origin = request.headers.get("origin", "")
    if not origin:
        return True
    host = request.headers.get("host", "")
    try:
        from urllib.parse import urlsplit
        return bool(host) and urlsplit(origin).netloc == host
    except ValueError:
        return False


@app.middleware("http")
async def require_password(request: Request, call_next):
    path = request.url.path
    if request.method == "POST":
        # 요청 본문 크기 상한 — 이 앱의 POST(가입/로그인)는 작은 JSON 뿐이다.
        # Content-Length 없는 전송(chunked)은 헤더 검사로 못 걸러 무한 본문을
        # 버퍼링(await request.json())하게 되므로 411 로 거부한다 — 브라우저
        # fetch(JSON)는 항상 Content-Length 를 실어 정상 사용자는 영향 없음.
        clen = request.headers.get("content-length", "")
        if not clen.isdigit():
            return _plain(411, "Content-Length 헤더가 필요합니다.")
        if int(clen) > 16_384:
            return _plain(413, "요청 본문이 너무 큽니다.")
        # CSRF 방어(2중): ① Origin 이 있으면 우리 호스트여야 하고 ② 본문을
        # 파싱하는 인증 POST 는 JSON Content-Type 만 받는다 — HTML 폼(form
        # urlencoded/multipart)으로는 교차 사이트에서 조용히 못 쏘고, JSON
        # Content-Type 의 교차 출처 fetch 는 CORS 사전요청에서 막힌다.
        if path.startswith("/api/auth/") and not _same_origin(request):
            return _plain(403, "허용되지 않은 출처의 요청입니다.")
        if path in ("/api/auth/login", "/api/auth/signup"):
            ctype = request.headers.get("content-type", "")
            if not ctype.lower().startswith("application/json"):
                return _plain(415, "application/json 요청만 받아요.")
    if path in _RATE_LIMITED_PATHS:
        bucket = _rate_bucket(path)
        if _rate_limited(f"{bucket}:{_client_ip(request)}",
                         _rate_limit_for(bucket)):
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
_PRESENCE_SWEEP_SEC = 5.0      # 만료 정리 최소 간격 — 호출마다 전체 훑기 방지
_presence: dict[str, float] = {}
_presence_last_sweep = 0.0


@app.get("/api/presence")
async def presence(cid: str = Query("", max_length=64, pattern=r"^[A-Za-z0-9_-]*$")):
    """동시 접속자 근사치. 방문자별 하트비트를 받아 활성 수를 돌려준다."""
    global _presence_last_sweep
    now = time.monotonic()
    # 오래된 방문자 정리 — 호출마다 전체 dict 를 훑으면 방문자가 많을 때
    # 요청당 O(n) CPU 가 되므로 몇 초에 한 번만 쓸어낸다 (개수는 근사치라
    # 몇 초 묵은 항목이 섞여도 무해). 정상 비용은 O(1) 삽입뿐.
    if now - _presence_last_sweep >= _PRESENCE_SWEEP_SEC:
        _presence_last_sweep = now
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


# 세션 조회 캐시 — '오늘의 지지선 터치' 페이지는 폴링(2~5초)이라, 캐시가 없으면
# 매 폴에 세션 DB 를 때린다. 토큰→판정 결과를 아주 짧게(30초) 기억해 DB 부하를
# 낮춘다. 로그아웃은 즉시 무효화하고, 만료 세션도 최대 30초만 늦게 반영된다
# (2주짜리 세션에는 무의미). 무효 토큰(None)도 캐시해 만료된 탭의 폴링이 DB 를
# 계속 두드리지 않게 한다.
_SESSION_CACHE_TTL_SEC = 30.0
_SESSION_CACHE_MAX = 10_000
_session_cache: dict[str, tuple[float, dict | None]] = {}
# 로그아웃된 토큰 → 무효화 시각. 로그아웃과 겹친 진행 중 조회가 캐시를
# 되살리지 못하게 하는 용도라 TTL 만큼만 의미가 있다 (주기적으로 정리).
_session_revoked: dict[str, float] = {}


def _session_cache_evict(token: str | None) -> None:
    """로그아웃 시 즉시 무효화 — 캐시된 '로그인됨' 판정이 남지 않게.

    무효화 '시점'도 함께 기록한다. 로그아웃과 겹쳐 이미 DB 를 조회 중이던
    요청이 뒤늦게 돌아와 캐시에 '로그인됨'을 다시 써 넣으면, 방금 로그아웃한
    토큰이 캐시 TTL(30초) 동안 되살아난다."""
    if token:
        _session_cache.pop(token, None)
        now = time.monotonic()
        _session_revoked[token] = now
        # TTL 이 지난 항목은 항상 정리한다 — 개수 임계값으로만 정리하면 그
        # 아래에서는 오래된 항목이 무한정 남고, 임계값을 넘는 순간에도
        # '최근 로그아웃'뿐이면 아무것도 못 지워 계속 자란다.
        cutoff = now - _SESSION_CACHE_TTL_SEC
        for k in [k for k, t in _session_revoked.items() if t < cutoff]:
            _session_revoked.pop(k, None)


async def _current_user(request: Request) -> dict | None:
    """세션 쿠키로 로그인한 사용자 {'id','email'} 또는 None.

    토큰→판정을 짧게 캐시해, 폴링 페이지가 매 요청 세션 DB 를 때리지 않게 한다
    (미스일 때만 DB 조회를 스레드로 넘긴다)."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    now = time.monotonic()
    hit = _session_cache.get(token)
    if hit is not None and now - hit[0] < _SESSION_CACHE_TTL_SEC:
        return hit[1]
    # 로그아웃된 토큰은 DB 를 볼 필요조차 없다. 세션 토큰은 로그인마다 새로
    # 발급되므로(재사용 없음) '무효화 목록에 있다'는 사실만으로 충분하다.
    revoked_at = _session_revoked.get(token)
    if revoked_at is not None and now - revoked_at < _SESSION_CACHE_TTL_SEC:
        return None
    user = await asyncio.to_thread(request.app.state.auth.user_for_token, token)
    # 조회 중에 로그아웃됐어도 결과를 버린다. 시각을 비교하면 안 된다 —
    # 로그아웃은 '무효화 기록 → DB 삭제' 순서라, 그 사이에 시작된 조회는
    # revoked_at < started 가 되어 통과하고 30초 동안 세션이 되살아난다.
    if token in _session_revoked:
        return None
    if len(_session_cache) > _SESSION_CACHE_MAX:
        # 통째로 비우면 위조 쿠키 폭주가 정상 사용자 캐시까지 지워 전원이 DB 를
        # 다시 때리게 된다 — 오래된(대부분 만료/위조) 절반만 비운다
        for k in sorted(_session_cache,
                        key=lambda k: _session_cache[k][0])[:_SESSION_CACHE_MAX // 2]:
            _session_cache.pop(k, None)
    _session_cache[token] = (now, user)
    return user


async def _auth_json(request: Request) -> tuple[str, str]:
    try:
        # 시간 상한 필수: Content-Length 헤더만 보내고 본문을 안 보내는 클라이언트
        # (slowloris)가 있으면 본문 읽기가 영원히 대기해, IP 하나가 미결 핸들러
        # 태스크·소켓을 시간당 수천 개까지 쌓을 수 있다 (uvicorn 은 요청 '사이'
        # keep-alive 타임아웃만 있고 본문 읽기 중 타임아웃은 없다).
        body = await asyncio.wait_for(request.json(), timeout=10)
    except Exception:  # noqa: BLE001 — 잘못된 JSON·시간 초과 모두 400 으로
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
    token = request.cookies.get(COOKIE_NAME)
    _session_cache_evict(token)  # 캐시된 '로그인됨' 판정을 먼저 지운다
    await asyncio.to_thread(request.app.state.auth.logout, token)
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
        raise HTTPException(
            status_code=502, detail="검색을 일시적으로 처리할 수 없어요.") from exc
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
        # 원 예외 문자열을 클라이언트에 노출하지 않는다(내부정보 유출 방지) — 진단은 로그로
        logger.exception("분석 실패")
        raise HTTPException(
            status_code=502,
            detail="분석을 일시적으로 처리할 수 없어요 — 잠시 후 다시 시도해 주세요.") from exc


def _unchanged_since(snap: dict, since: str | None) -> bool:
    """폴링 클라이언트가 이미 렌더한 스냅숏과 같은가 (안정 상태에서만).

    하루 고정 결과를 5~30분마다 수백 KB 씩 다시 직렬화·압축해 보내는 것이
    유휴 상태 이벤트루프 CPU 의 대부분이었다 — 같으면 몇십 바이트로 답한다."""
    if not since or snap.get("refreshing") or snap.get("partial"):
        return False
    try:
        return abs(float(since) - float(snap.get("generatedAt", 0))) < 1e-6
    except (TypeError, ValueError):
        return False


_UNCHANGED_SINCE_Q = Query(None, max_length=32, pattern=r"^[0-9.]+$")


@app.get("/api/patterns")
async def patterns_api(
    pattern: str = Query("stage2", pattern=r"^(stage2|triangle|head_shoulders|inv_head_shoulders|cup_handle)$"),
    market: str = Query("kr", pattern=r"^(kr|us)$"),
    since: str | None = _UNCHANGED_SINCE_Q,
):
    """패턴 스크리너: 스캔 상태 또는 상위 매칭 반환 (프런트가 폴링)."""
    snap = await app.state.scanners[market].snapshot()
    if snap["status"] != "done":
        return snap
    if _unchanged_since(snap, since):
        return {"status": "done", "unchanged": True,
                "generatedAt": snap.get("generatedAt")}
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
# 실시간 지수를 쓰므로 캐시는 프런트 폴링 주기(60초)보다 짧게 잡는다 —
# 120초면 폴링 두 번에 한 번은 같은 값이라 '멈춘 것처럼' 보인다.
_INDICES_TTL_SEC = 45.0
_INDICES_FAIL_COOLDOWN_SEC = 30.0  # 전부 실패 직후 이 시간 동안은 재조회하지 않는다
_indices_cache: dict[str, Any] = {"ts": -1e9, "data": None, "fail_ts": -1e9}
_indices_last_good: dict[str, dict] = {}  # 실패한 지수는 직전 값을 유지(티커 안정)
_indices_lock = asyncio.Lock()            # 단일 비행(single-flight): 동시에 하나만 갱신


@app.get("/api/indices")
async def indices():
    """주요 지수 스냅샷 — 헤더 티커용. 2분 캐시 + 신선 조회(캔들 30분 캐시 우회)."""
    import time as _time

    now = _time.monotonic()
    if (_indices_cache["data"] is not None
            and now - _indices_cache["ts"] < _INDICES_TTL_SEC):
        return _indices_cache["data"]

    # 캐시가 비었/만료됐을 때 동시 요청이 몰리면 각자 4개 지수를 업스트림에서
    # 받아(요청 폭증) 야후 429 를 부른다. 락으로 한 번만 갱신하고, 대기자는
    # 그 결과를 재사용한다 (락 대기 중 갱신됐는지 다시 확인).
    async with _indices_lock:
        now = _time.monotonic()
        if (_indices_cache["data"] is not None
                and now - _indices_cache["ts"] < _INDICES_TTL_SEC):
            return _indices_cache["data"]
        # 직전 갱신이 '전부 실패'였다면 잠시 재조회하지 않는다 — 업스트림 전면
        # 장애 때 락 대기열의 요청들이 25초짜리 실패 조회를 1건씩 직렬로 반복하며
        # (호송 현상) 대기열이 무한히 자라는 것을 막는다. 대기자들은 즉시 빈
        # 목록을 받고, 쿨다운이 지나면 첫 요청 하나만 다시 시도한다.
        if now - _indices_cache["fail_ts"] < _INDICES_FAIL_COOLDOWN_SEC:
            return {"indices": []}
        return await _refresh_indices(now)


async def _live_kr_index(sym: str, name: str) -> dict | None:
    """국내 지수 실시간 시세 행 — 실패하면 None (호출자가 일봉 경로로 폴백)."""
    try:
        from .providers.free_data import fetch_kr_index_quote_sync
    except Exception:  # noqa: BLE001 — 샘플/토스 모드 등 모듈이 없을 수 있다
        return None
    if sym.upper() not in ("KS11", "KQ11"):
        return None
    if getattr(app.state, "settings", None) is not None and \
            app.state.settings.provider == "sample":
        return None                      # 샘플 모드는 합성 데이터만 (테스트 결정성)
    try:
        quote = await asyncio.wait_for(
            asyncio.to_thread(fetch_kr_index_quote_sync, sym), 8)
    except Exception:  # noqa: BLE001 — 실시간 실패는 조용히 폴백
        return None
    if not quote:
        return None
    import datetime as _dt
    kst = _dt.datetime.now(_dt.timezone(_dt.timedelta(hours=9)))
    row = {"key": sym, "name": name, "value": quote["value"],
           "changePct": quote["changePct"],
           "date": quote.get("date") or kst.strftime("%m/%d"),
           "live": True}   # 진단용 — 실시간 소스에서 온 값인지 구분
    _indices_last_good[sym] = row
    return row


async def _refresh_indices(now: float):
    # 30분 캔들 캐시를 우회해 원 공급자에서 최신 일봉을 직접 받는다 (장중 갱신 반영)
    inner = getattr(app.state.provider, "inner", app.state.provider)

    async def one(sym: str, name: str):
        # 국내 지수는 실시간 시세를 먼저 시도한다. FDR 의 지수 경로는 GitHub
        # 정적 CSV 캐시(완성된 일봉만)라 장중에 값이 전혀 움직이지 않았다.
        live = await _live_kr_index(sym, name)
        if live is not None:
            return live
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
    if data["indices"]:  # 전부 실패면 캐시하지 않고 짧은 실패 쿨다운만 기록
        _indices_cache["data"] = data
        _indices_cache["ts"] = now
    else:
        # 실패 '종료' 시각 기준 — 인자 now(시작 시각)로 재면 25초 걸린 실패 뒤
        # 쿨다운이 그만큼 일찍 풀린다
        _indices_cache["fail_ts"] = time.monotonic()
    return data


# 배경 그래프용 지수 시계열 — 값만 주는 /api/indices 와 달리 '모양'을 그린다.
# 장식이지만 데이터는 진짜여야 하므로 실제 일봉 종가를 쓴다.
_SPARK_TTL_SEC = 900.0          # 15분 (일봉이라 더 자주 받을 이유가 없다)
_SPARK_BARS = 90                # 약 4개월치 — 배경 곡선으로 보기 좋은 길이
_spark_cache: dict[str, Any] = {"data": None, "ts": 0.0, "fail_ts": 0.0}
_spark_lock = asyncio.Lock()


@app.get("/api/indices/spark")
async def indices_spark():
    """주요 지수의 최근 종가 시계열 (배경 그래프용).

    실패해도 화면이 깨지지 않게 빈 목록을 준다 — 호출자는 장식으로만 쓴다."""
    now = time.monotonic()
    if (_spark_cache["data"] is not None
            and now - _spark_cache["ts"] < _SPARK_TTL_SEC):
        return _spark_cache["data"]
    async with _spark_lock:
        now = time.monotonic()
        if (_spark_cache["data"] is not None
                and now - _spark_cache["ts"] < _SPARK_TTL_SEC):
            return _spark_cache["data"]
        if now - _spark_cache["fail_ts"] < _INDICES_FAIL_COOLDOWN_SEC:
            return {"indices": []}

        async def one(sym: str, name: str):
            try:
                df = await app.state.provider.candles(sym, "day", _SPARK_BARS + 10)
                closes = [round(float(v), 2) for v in df["close"].tail(_SPARK_BARS)]
                if len(closes) >= 10:
                    return {"key": sym, "name": name, "closes": closes}
            except Exception:  # noqa: BLE001 — 하나 실패해도 나머지로 그린다
                logger.info("지수 시계열 조회 실패: %s", sym)
            return None

        rows = await asyncio.gather(*(one(s, n) for s, n in INDEX_TICKER))
        data = {"indices": [r for r in rows if r]}
        if data["indices"]:
            _spark_cache["data"] = data
            _spark_cache["ts"] = time.monotonic()
        else:
            _spark_cache["fail_ts"] = time.monotonic()
        return data


@app.get("/api/touches")
async def touches_api(request: Request,
                      market: str = Query("kr", pattern=r"^(kr|us)$"),
                      since: str | None = _UNCHANGED_SINCE_Q):
    """오늘의 지지선 터치: 스캔 상태 또는 상위 매칭 반환 (프런트가 폴링).

    회원 전용 — 로그인하지 않았으면 401 (프런트가 /login 으로 보낸다)."""
    if not await _current_user(request):
        raise HTTPException(401, "로그인이 필요합니다.")
    snap = await app.state.touch_scanners[market].snapshot()
    if snap["status"] != "done":
        return snap
    if _unchanged_since(snap, since):
        return {"status": "done", "unchanged": True,
                "generatedAt": snap.get("generatedAt")}
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


# 동시에 살아 있는 맞춤선 스캐너 상한 — (시장, 기간) 조합이 무한히 늘며
# 메모리·페치 예산을 잠식하지 않게 유휴 스캐너부터 비운다. 스캐너당 결과가
# 수백 KB 수준이라 16개여도 몇 MB — 하루 고정 결과를 지키는 쪽이 이득이다.
_MAX_LINE_SCANNERS = 16
# '신선한 고정 결과'를 희생하는 3순위 회수는 전역으로 드물게만 허용한다.
# 이게 없으면 기간을 5~250 으로 바꿔가며 요청하는 것만으로 요청 한 번당 전체
# 유니버스 재스캔이 하나씩 생기고(0.1 vCPU 인스턴스), 그때마다 다른 사용자의
# 하루 고정 결과가 사라져 '오늘은 목록이 안 바뀐다'는 약속이 깨진다.
# 간격을 두면 17번째 조합은 몇 분 안에 들어오되(교착 해소 유지) 남용은 막힌다.
LINE_FROZEN_EVICT_MIN_INTERVAL_SEC = 180.0
# 회수당한 키가 곧바로 재스캔되지 않도록 '지금'을 기준으로 부여하는 휴지.
# 승계한 _scan_ended 는 몇 시간 전이라 그대로 물려주면 휴지가 즉시 만료된다.
LINE_EVICT_COOLDOWN_SEC = 120.0


def _evict_line_slot(reg: dict, cooldowns: dict) -> bool:
    """등록소에서 슬롯 하나를 회수한다.

    1순위: 유휴이면서 '하루 고정(신선)' 결과가 아닌 스캐너(부분/만료/오류) —
    고정 결과를 버리면 그 키의 다음 방문이 전체 재스캔을 유발해, 키를 돌려가며
    요청하는 것만으로 하루 1회 원칙이 무한 재스캔 churn 으로 바뀐다.
    2순위: 워치독 시한(900초)을 넘긴 행(hang) 스캐너 취소·회수.
    전부 '정상 스캔 중'이거나 '신선한 고정 결과'면 False — 호출자가 429
    백프레셔로 답해, 과부하가 재계산 폭주로 번지지 않게 한다."""
    from .pattern_scan import SCAN_TIMEOUT_SEC

    for k in list(reg):                   # 삽입 순 = LRU 순 (사용 시 재삽입하므로)
        cand = reg[k]
        if ((cand._task is None or cand._task.done())
                and not (getattr(cand, "_daily_frozen", False) and cand._fresh())):
            cooldowns[k] = (cand._scan_ended, cand._retry_wait)
            reg.pop(k, None)
            return True
    now = time.monotonic()
    for k in list(reg):
        cand = reg[k]
        # '실행 중'인 태스크만 행 판정 대상 — 유휴(고정 결과 보호로 1순위에서
        # 남은) 스캐너는 _scan_started 가 오래돼도 행이 아니다
        if (cand._task is not None and not cand._task.done()
                and now - cand._scan_started > SCAN_TIMEOUT_SEC):
            cand._task.cancel()
            cooldowns[k] = (now, cand._retry_wait)
            reg.pop(k, None)
            logger.warning("맞춤선 스캐너 %s 행(hang) 회수 (%.0f초 초과)",
                           k, SCAN_TIMEOUT_SEC)
            return True
    # 3순위: 남은 게 전부 '신선한 고정 결과'뿐이면 가장 오래 안 쓴 것을 내준다.
    # 이 단계가 없으면 서로 다른 (시장, 기간) 16개가 고정되는 순간부터 다음
    # 아침까지 17번째 조합은 하루 종일 429 만 받는다 — 기다려도 절대 안 풀리는
    # 교착이다.
    #
    # 단, 요청마다 허용하면 안 된다. 승계하는 (_scan_ended, _retry_wait) 는
    # 고정 결과의 경우 '몇 시간 전 + 60초'라 휴지가 이미 만료된 값이어서,
    # 재생성된 스캐너가 즉시 전체 재스캔을 시작한다 — 기간을 바꿔가며 부르는
    # 것만으로 재스캔이 계속 쌓이고, 그때마다 남의 하루 고정 결과가 사라진다.
    # 그래서 ① 전역 간격 제한을 두고 ② 회수 시각 기준으로 휴지를 새로 부여한다.
    now_evict = time.monotonic()
    if now_evict - getattr(app.state, "line_frozen_evict_ts", 0.0) \
            < LINE_FROZEN_EVICT_MIN_INTERVAL_SEC:
        return False              # 잠시 후 다시 — 그동안은 429 백프레셔
    for k in list(reg):
        cand = reg[k]
        if cand._task is None or cand._task.done():
            cooldowns[k] = (now_evict, max(cand._retry_wait, LINE_EVICT_COOLDOWN_SEC))
            reg.pop(k, None)
            app.state.line_frozen_evict_ts = now_evict
            logger.info("맞춤선 슬롯 부족 — 고정 결과 %s 를 LRU 로 회수", k)
            return True
    return False   # 전부 실제 스캔 중 — 이때의 429 는 정당한 백프레셔


def _line_scanner(market: str, period: int):
    """(시장, 기간) 스캐너를 등록소에서 꺼내거나 만든다. 가득 찼는데 전부
    스캔 중이면 None (호출자가 429 로 답한다)."""
    from .line_scan import LineScanner
    from .pattern_scan import PARTIAL_RESCAN_COOLDOWN_SEC

    reg: dict = app.state.line_scanners
    cooldowns: dict = app.state.line_cooldowns
    key = (market, period)
    sc = reg.pop(key, None)
    if sc is None:
        if len(reg) >= _MAX_LINE_SCANNERS and not _evict_line_slot(reg, cooldowns):
            return None                   # 전부 정상 스캔 중 — 잠시 후 다시
        sc = LineScanner(app.state.provider, app.state.universe_fns[market], period,
                         market=market)
        # 같은 키의 이전 인스턴스가 남긴 휴지·백오프를 승계한다 — 퇴출→재생성이
        # 쿨다운을 초기화하면 스캔 churn 방지 장치 전체가 우회된다
        sc._scan_ended, sc._retry_wait = cooldowns.get(
            key, (0.0, PARTIAL_RESCAN_COOLDOWN_SEC))
    reg[key] = sc                          # 재삽입으로 '최근 사용'을 맨 뒤로
    return sc


@app.get("/api/lines")
async def lines_api(request: Request,
                    market: str = Query("kr", pattern=r"^(kr|us)$"),
                    period: int = Query(20, ge=5, le=250),
                    since: str | None = _UNCHANGED_SINCE_Q):
    """맞춤 이평선 스크리너: N일선의 지지/저항 종목 리스트 (프런트가 폴링).

    회원 전용 — 로그인하지 않았으면 401 (프런트가 /login 으로 보낸다)."""
    if not await _current_user(request):
        raise HTTPException(401, "로그인이 필요합니다.")
    sc = _line_scanner(market, period)
    if sc is None:
        raise HTTPException(429, "지금 다른 이평선 스캔이 많아요 — 잠시 후 다시 시도해 주세요.")
    snap = await sc.snapshot()
    if snap["status"] != "done":
        return snap
    if _unchanged_since(snap, since):
        return {"status": "done", "unchanged": True,
                "generatedAt": snap.get("generatedAt")}
    return {
        "status": "done",
        "market": market,
        "period": snap.get("period", period),
        "scanned": snap.get("scanned"),
        "universe": snap.get("universe"),
        "elapsedSec": snap.get("elapsedSec"),
        "refreshing": bool(snap.get("refreshing")),
        "partial": bool(snap.get("partial")),
        "generatedAt": snap.get("generatedAt"),
        "support": snap.get("support") or [],
        "resistance": snap.get("resistance") or [],
        "totalSupport": snap.get("totalSupport", 0),
        "totalResistance": snap.get("totalResistance", 0),
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
        return RedirectResponse(url=_login_redirect("/touches", request),
                                status_code=302)
    return FileResponse(STATIC_DIR / "touches.html")


@app.get("/lines")
async def lines_page(request: Request):
    """맞춤 이평선 스크리너 — 회원 전용 (터치 스크리너와 동일 규칙)."""
    if not await _current_user(request):
        return RedirectResponse(url=_login_redirect("/lines", request),
                                status_code=302)
    return FileResponse(STATIC_DIR / "lines.html")


def _login_redirect(dest: str, request: Request) -> str:
    """회원 전용 페이지 → 로그인 페이지 이동 URL.

    들어온 ?lang= 을 그대로 물려준다. 버리면 공유된 영어 링크
    (/touches?lang=en)를 비회원이 열었을 때 로그인 화면이 한국어로 뜨고,
    로그인 뒤 돌아온 페이지도 한국어라 외국인 방문자의 흐름이 끊긴다."""
    from urllib.parse import quote

    lang = request.query_params.get("lang", "")
    suffix = f"?lang={lang}" if lang in ("en", "ko") else ""
    url = f"/login?next={quote(dest + suffix, safe='')}"
    return url + (f"&lang={lang}" if suffix else "")


def _safe_next(nxt: str) -> str:
    """오픈 리다이렉트 방지 — 사이트 내부 절대경로만 허용한다.
    브라우저는 URL 에서 제어문자(탭·개행 등 <0x20)를 제거하므로, 먼저 그것들을
    없앤 값으로 판정한다 (예: '/\\t/evil.com' → '//evil.com' 우회 차단). '/'로
    시작해도 '//' 또는 '/\\' 로 시작하면 프로토콜-상대 URL 이라 외부로 튄다."""
    cleaned = "".join(c for c in (nxt or "") if ord(c) >= 0x20)
    if (not cleaned.startswith("/")
            or cleaned.startswith("//") or cleaned.startswith("/\\")):
        return "/touches"
    return cleaned


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


@app.get("/links")
async def links_page():
    """링크 모음(link-in-bio) — SNS 프로필에 걸어 두는 한 장짜리 목차."""
    return FileResponse(STATIC_DIR / "links.html")


@app.get("/privacy")
async def privacy_page():
    """개인정보처리방침 (회원 이메일 수집 고지)."""
    return FileResponse(STATIC_DIR / "privacy.html")
