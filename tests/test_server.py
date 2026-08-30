"""API 통합 테스트 (샘플 공급자)."""
import pytest
from fastapi.testclient import TestClient

from app.server import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["provider"] in ("sample", "toss")


def test_search_korean_name(client):
    r = client.get("/api/search", params={"q": "삼성"})
    assert r.status_code == 200
    results = r.json()["results"]
    assert any("삼성전자" in x["name"] for x in results)


def test_search_by_code(client):
    r = client.get("/api/search", params={"q": "005930"})
    results = r.json()["results"]
    assert results and results[0]["symbol"] == "005930"


def test_analyze_full_shape(client):
    r = client.get("/api/analyze", params={"symbol": "005930"})
    assert r.status_code == 200
    body = r.json()
    assert set(body["timeframes"].keys()) == {"day", "week", "month"}
    day = body["timeframes"]["day"]
    assert day["bars"] > 500
    assert 2 <= len(day["recommended"]) <= 3
    rec = day["recommended"][0]
    assert rec["ma"], "MA 라인 데이터가 비어 있음"
    assert rec["touches"] >= 1
    # 차트 데이터와 MA 라인의 시간 범위 일치
    assert day["candles"][0]["time"] <= rec["ma"][0]["time"]
    # 월봉은 기본 전체 기간
    assert body["timeframes"]["month"]["lookbackYears"] is None


def test_analyze_custom_years(client):
    r = client.get("/api/analyze", params={"symbol": "005930", "years_day": 1})
    day = r.json()["timeframes"]["day"]
    assert day["lookbackYears"] == 1
    # 1년 ≈ 248봉 (±약간)
    assert 200 <= day["bars"] <= 260


def test_analyze_zero_means_full(client):
    r = client.get("/api/analyze", params={"symbol": "005930", "years_day": 0})
    day = r.json()["timeframes"]["day"]
    assert day["lookbackYears"] is None
    assert day["bars"] > 3000


def test_index_served(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "이평선 레이더" in r.text


def test_us_scanner_falls_back_to_us_symbols(client):
    """상장목록이 없는 모드(sample 등)에서 미국 탭이 국내 종목을 보여주면 안 된다."""
    import asyncio

    from app.pattern_scan import US_FALLBACK

    fn = app.state.scanners["us"].universe_fn
    out = asyncio.new_event_loop().run_until_complete(fn())
    assert {s.symbol for s in out} == {t[0] for t in US_FALLBACK}


def test_landing_links_to_both_tools(client):
    """랜딩 홈: 두 도구 카드와 각 페이지 링크가 있어야 한다."""
    r = client.get("/")
    assert "이평선 레이더" in r.text
    assert "차트 패턴 스크리너" in r.text
    assert 'href="/ma"' in r.text and 'href="/patterns"' in r.text


def test_tool_pages_served(client):
    ma = client.get("/ma")
    assert ma.status_code == 200 and 'id="searchInput"' in ma.text
    pt = client.get("/patterns")
    assert pt.status_code == 200 and 'id="scanStatus"' in pt.text


def test_legacy_symbol_deeplink_redirects_to_ma(client):
    """옛 딥링크(/?symbol=...)는 이평선 분석 페이지로 넘어간다."""
    r = client.get("/?symbol=005930", follow_redirects=False)
    assert r.status_code == 307
    assert r.headers["location"] == "/ma?symbol=005930"


def test_touches_page_and_api(client):
    # /touches 페이지는 회원 전용 — 가입해 세션을 얻은 뒤 접근
    # (/api/touches 자체는 공개다. test_auth.py 참고)
    client.post("/api/auth/signup",
                json={"email": "touchview@example.com", "password": "password123"})
    try:
        r = client.get("/touches")
        assert r.status_code == 200 and 'id="scanStatus"' in r.text
        api = client.get("/api/touches", params={"market": "kr"})
        assert api.status_code == 200
        assert api.json()["status"] in ("running", "done")
    finally:
        client.post("/api/auth/logout")  # 세션 정리 (다른 테스트 영향 방지)


def test_app_client_gets_token_and_bearer_auth_works(client):
    """client:"app" 이면 본문으로 토큰을 받고, 쿠키 없이 Authorization: Bearer
    만으로 회원 전용 API 를 쓸 수 있다.

    참고: 앱인토스 미니앱은 정책상 자체 로그인을 제공할 수 없어 이 경로를 더는
    쓰지 않는다(앱은 계정 없이 공개 API 만 호출). 서버 기능 자체는 유지한다."""
    r = client.post("/api/auth/signup",
                    json={"email": "appuser@example.com",
                          "password": "password123", "client": "app"})
    assert r.status_code == 200
    token = r.json().get("token")
    assert token, "앱 클라이언트 응답에 토큰이 없음"
    client.cookies.clear()  # 쿠키를 지워 헤더만으로 인증되는지 확인
    try:
        api = client.get("/api/auth/me",
                         headers={"Authorization": f"Bearer {token}"})
        assert api.status_code == 200
        # 로그인도 앱 클라이언트면 토큰을 돌려준다
        r2 = client.post("/api/auth/login",
                         json={"email": "appuser@example.com",
                               "password": "password123", "client": "app"})
        assert r2.status_code == 200 and r2.json().get("token")
    finally:
        # 로그아웃도 Bearer 로 동작해야 한다 (앱은 쿠키가 없다)
        client.cookies.clear()
        out = client.post("/api/auth/logout",
                          headers={"Authorization": f"Bearer {token}"})
        assert out.status_code == 200
    # 로그아웃된 토큰은 즉시 무효
    api = client.get("/api/auth/me",
                     headers={"Authorization": f"Bearer {token}"})
    assert api.status_code == 401


def test_web_client_response_has_no_token(client):
    """웹(client 미지정) 로그인/가입 응답 본문에는 토큰이 노출되지 않는다."""
    r = client.post("/api/auth/signup",
                    json={"email": "webonly@example.com", "password": "password123"})
    try:
        assert r.status_code == 200
        assert "token" not in r.json()
    finally:
        client.post("/api/auth/logout")


def test_indices_api(client):
    """헤더 티커용 지수 스냅샷 — 샘플 모드에선 4개 모두 합성 데이터로 응답."""
    r = client.get("/api/indices")
    assert r.status_code == 200
    idx = r.json()["indices"]
    assert len(idx) == 4
    for it in idx:
        assert {"key", "name", "value", "changePct", "date"} <= set(it)
        assert it["value"] > 0


def test_about_page(client):
    r = client.get("/about")
    assert r.status_code == 200
    assert "원토피아" in r.text
    assert "양주원" not in r.text  # 본명은 노출하지 않는다 (유래는 '이름 끝 글자 원'으로만)
    assert "mailto:yangjuwon240@gmail.com" in r.text


def test_presence_counts_distinct_visitors(client):
    """동시 접속자: 고유 방문자만 세고, 같은 방문자 재호출은 중복 집계하지 않는다."""
    a = client.get("/api/presence?cid=pv1").json()["active"]
    b = client.get("/api/presence?cid=pv2").json()["active"]
    assert b == a + 1                      # 새 방문자는 +1
    c = client.get("/api/presence?cid=pv1").json()["active"]
    assert c == b                          # 기존 방문자 재호출은 그대로
    # cid 없이 호출하면 세기만 하고 새로 추가하지 않는다
    assert client.get("/api/presence").json()["active"] == b


def test_presence_rejects_bad_cid(client):
    """비정상 cid(너무 김/허용 안 된 문자)는 422로 거부하고 500이 아니다."""
    assert client.get("/api/presence?cid=" + "x" * 100).status_code == 422
    assert client.get("/api/presence?cid=bad chars").status_code == 422
    assert client.get("/api/presence?cid=drop;table").status_code == 422


def test_password_with_non_ascii_returns_401_not_500(monkeypatch):
    """비ASCII 비밀번호 헤더가 500(compare_digest TypeError)이 아니라 401."""
    import base64

    import app.server as server_mod
    from fastapi.testclient import TestClient

    monkeypatch.setattr(server_mod, "SITE_PASSWORD", "test1234")
    with TestClient(server_mod.app) as c:
        cred = base64.b64encode("u:pässwörd".encode()).decode()
        r = c.get("/api/health/../..", headers={"Authorization": f"Basic {cred}"})
        r = c.get("/", headers={"Authorization": f"Basic {cred}"})
        assert r.status_code == 401


def test_security_headers_present(client):
    r = client.get("/")
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert r.headers.get("X-Frame-Options") == "DENY"
    assert "default-src 'self'" in r.headers.get("Content-Security-Policy", "")


def test_analyze_rate_limit(monkeypatch):
    """/api/analyze 는 IP 당 분당 호출 제한 — 초과 시 429."""
    import app.server as server_mod
    from fastapi.testclient import TestClient

    monkeypatch.setattr(server_mod, "ANALYZE_RATE_LIMIT_PER_MIN", 3)
    server_mod._rate_windows.clear()
    with TestClient(server_mod.app) as c:
        codes = [c.get("/api/analyze", params={"symbol": "005930"}).status_code
                 for _ in range(5)]
    server_mod._rate_windows.clear()
    assert codes[:3] == [200, 200, 200]
    assert 429 in codes[3:]


def test_search_rate_limit(monkeypatch):
    """/api/search 도 IP 당 분당 호출 제한 — 봇이 목록 스캔을 무한 유발하지 못하게."""
    import app.server as server_mod
    from fastapi.testclient import TestClient

    monkeypatch.setattr(server_mod, "SEARCH_RATE_LIMIT_PER_MIN", 3)
    server_mod._rate_windows.clear()
    with TestClient(server_mod.app) as c:
        # 서로 다른 검색어라 캐시로 새지 않는다 (제한은 미들웨어라 캐시와 무관하지만)
        codes = [c.get("/api/search", params={"q": f"가나다{i}"}).status_code
                 for i in range(5)]
    server_mod._rate_windows.clear()
    assert codes[:3] == [200, 200, 200]
    assert 429 in codes[3:]


def test_touches_bucket_is_separate_and_generous(monkeypatch):
    """공개된 /api/touches 는 전용 버킷을 쓴다 — 폴링이 분석 예산을 갉지 않고,
    분석 예산이 바닥나도 터치 폴링은 계속 돼야 한다.

    상한이 넉넉한 것도 함께 확인한다: 앱·웹이 스캔 중 2초 간격(30회/분)으로
    폴링하고 CGNAT 로 IP 를 공유할 수 있어, 상한이 낮으면 정상 사용자가 429 를
    맞는다."""
    import app.server as server_mod
    from fastapi.testclient import TestClient

    # 실제 상한이 한 사람의 폴링(30회/분)보다 충분히 커야 한다
    assert server_mod.TOUCHES_RATE_LIMIT_PER_MIN >= 30 * 5

    monkeypatch.setattr(server_mod, "ANALYZE_RATE_LIMIT_PER_MIN", 2)
    monkeypatch.setattr(server_mod, "TOUCHES_RATE_LIMIT_PER_MIN", 5)
    server_mod._rate_windows.clear()
    with TestClient(server_mod.app) as c:
        analyze_codes = [c.get("/api/analyze", params={"symbol": "005930"}).status_code
                         for i in range(4)]
        # 분석 예산을 다 써도 터치 폴링은 통과해야 한다 (버킷 분리)
        touches_code = c.get("/api/touches", params={"market": "kr"}).status_code
        # 터치도 자기 버킷을 넘기면 막힌다
        touches_codes = [c.get("/api/touches", params={"market": "kr"}).status_code
                         for i in range(6)]
    server_mod._rate_windows.clear()
    assert 429 in analyze_codes           # 분석은 2회 초과로 막힘
    assert touches_code == 200            # 터치 예산은 멀쩡
    assert 429 in touches_codes           # 터치도 자기 상한은 지킨다


def test_search_and_analyze_have_separate_buckets(monkeypatch):
    """검색과 분석은 버킷이 분리돼, 한쪽을 다 써도 다른 쪽 예산은 남는다."""
    import app.server as server_mod
    from fastapi.testclient import TestClient

    monkeypatch.setattr(server_mod, "SEARCH_RATE_LIMIT_PER_MIN", 2)
    monkeypatch.setattr(server_mod, "ANALYZE_RATE_LIMIT_PER_MIN", 5)
    server_mod._rate_windows.clear()
    with TestClient(server_mod.app) as c:
        search_codes = [c.get("/api/search", params={"q": f"라마바{i}"}).status_code
                        for i in range(4)]
        # 검색 예산을 다 써도 분석은 여전히 통과해야 한다 (버킷 분리)
        analyze_code = c.get("/api/analyze", params={"symbol": "005930"}).status_code
    server_mod._rate_windows.clear()
    assert 429 in search_codes            # 검색은 2회 초과로 막힘
    assert analyze_code == 200            # 분석 예산은 멀쩡


def test_session_cache_reduces_db_lookups_and_logout_evicts(monkeypatch):
    """세션 조회 캐시: 폴링 반복이 매번 DB 를 때리지 않고, 로그아웃은 즉시 무효화."""
    import app.server as server_mod
    from fastapi.testclient import TestClient

    with TestClient(server_mod.app) as c:
        real = c.app.state.auth.user_for_token
        calls = {"n": 0}

        def spy(token):
            calls["n"] += 1
            return real(token)

        monkeypatch.setattr(c.app.state.auth, "user_for_token", spy)
        server_mod._session_cache.clear()
        c.post("/api/auth/signup",
               json={"email": "cacheuser@example.com", "password": "password123"})
        token = c.cookies.get(server_mod.COOKIE_NAME)
        assert token
        # 첫 폴은 DB 조회(미스), 두 번째는 캐시 히트라 조회하지 않는다
        # (프로브는 인증이 필요한 /api/auth/me — /api/touches 는 공개로 바뀌었다)
        assert c.get("/api/auth/me").status_code == 200
        assert c.get("/api/auth/me").status_code == 200
        assert calls["n"] == 1, f"두 번째 폴이 캐시를 안 쓰고 DB 를 또 때림 ({calls['n']})"
        assert token in server_mod._session_cache
        # 로그아웃하면 캐시에서 즉시 제거되고 이후 접근은 401
        c.post("/api/auth/logout")
        assert token not in server_mod._session_cache
        assert c.get("/api/auth/me").status_code == 401
    server_mod._session_cache.clear()


def test_indices_single_flight(monkeypatch):
    """지수 캐시가 비었을 때 동시 요청이 몰려도 업스트림 갱신은 한 번만 나간다."""
    import asyncio

    import pandas as pd

    import app.server as server_mod

    calls = {"n": 0}

    class FakeInner:
        name = "fake"

        async def candles(self, sym, tf, n):
            calls["n"] += 1
            await asyncio.sleep(0.02)  # 두 요청의 갱신 구간이 겹칠 시간
            return pd.DataFrame({
                "date": pd.bdate_range("2020-01-01", periods=3),
                "open": [1, 2, 3], "high": [1, 2, 3], "low": [1, 2, 3],
                "close": [10, 11, 12], "volume": [1, 1, 1]})

    class FakeProvider:
        name = "fake"
        inner = FakeInner()

    saved_provider = server_mod.app.state.provider
    saved_cache = dict(server_mod._indices_cache)
    try:
        server_mod.app.state.provider = FakeProvider()
        server_mod._indices_cache["data"] = None
        server_mod._indices_cache["ts"] = -1e9

        async def go():
            return await asyncio.gather(server_mod.indices(), server_mod.indices())

        r1, r2 = asyncio.new_event_loop().run_until_complete(go())
        # 지수 4개 × 1회 = 4. 단일 비행이 없으면 두 요청이 각자 받아 8이 된다.
        assert calls["n"] == 4, f"동시 요청인데 업스트림을 {calls['n']}번 때림(4여야 함)"
        assert r1 == r2 and len(r1["indices"]) == 4
    finally:
        server_mod.app.state.provider = saved_provider
        server_mod._indices_cache.update(saved_cache)


def test_post_without_content_length_rejected_411(client):
    """Content-Length 없는 POST(chunked)는 무한 본문 버퍼링(OOM) 벡터 — 411.
    httpx 는 제너레이터 본문을 chunked 로 보내므로 그 경로로 재현한다."""
    r = client.post("/api/auth/login", content=iter([b'{"a":', b"1}"]),
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 411


def test_auth_post_requires_json_content_type(client):
    """로그인/가입은 JSON Content-Type 만 받는다 — HTML 폼으로 위장한
    교차 사이트 CSRF 전송을 차단 (샌드박스: SameSite=Lax 의 2차 방어)."""
    r = client.post("/api/auth/login", content=b"email=a@b.c&password=12345678",
                    headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert r.status_code == 415
    # 정상 JSON 은 통과해 인증 로직까지 간다 (401 = 자격증명 불일치)
    r2 = client.post("/api/auth/login",
                     json={"email": "nouser@example.com", "password": "password123"})
    assert r2.status_code == 401


def test_auth_post_rejects_cross_origin(client):
    """Origin 헤더가 요청 호스트와 다르면 403 — 브라우저발 CSRF 차단.
    같은 호스트 Origin 과 Origin 없음(비브라우저)은 통과한다."""
    body = {"email": "nouser@example.com", "password": "password123"}
    bad = client.post("/api/auth/login", json=body,
                      headers={"Origin": "https://evil.example"})
    assert bad.status_code == 403
    ok = client.post("/api/auth/login", json=body,
                     headers={"Origin": "http://testserver"})
    assert ok.status_code == 401  # 출처 통과 → 자격증명 검사까지 도달


def test_presence_rate_limited(monkeypatch):
    """/api/presence 도 IP 당 상한 — cid 를 바꿔가며 CPU/메모리를 태우는
    봇을 막는다 (정상 하트비트는 분당 1~2회라 영향 없음)."""
    import app.server as server_mod
    from fastapi.testclient import TestClient

    monkeypatch.setattr(server_mod, "PRESENCE_RATE_LIMIT_PER_MIN", 3)
    server_mod._rate_windows.clear()
    with TestClient(server_mod.app) as c:
        codes = [c.get("/api/presence", params={"cid": f"bot{i}"}).status_code
                 for i in range(5)]
    server_mod._rate_windows.clear()
    assert codes[:3] == [200, 200, 200]
    assert 429 in codes[3:]


def test_signup_has_own_stricter_bucket(monkeypatch):
    """가입은 로그인과 분리된 더 좁은 버킷 — 가입 소진이 로그인을 막지 않고,
    대량 이메일 프로빙/쓰레기 계정 생성은 빨리 429 에 막힌다."""
    import app.server as server_mod
    from fastapi.testclient import TestClient

    monkeypatch.setattr(server_mod, "SIGNUP_RATE_LIMIT_PER_MIN", 2)
    server_mod._rate_windows.clear()
    with TestClient(server_mod.app) as c:
        codes = [c.post("/api/auth/signup",
                        json={"email": f"probe{i}@example.com", "password": "pw"}).status_code
                 for i in range(4)]
        # 가입 예산 소진 후에도 로그인 버킷은 멀쩡해야 한다
        login = c.post("/api/auth/login",
                       json={"email": "nouser@example.com", "password": "password123"})
    server_mod._rate_windows.clear()
    assert 429 in codes[2:]           # 3번째부터 가입 차단 (2/분 초과)
    assert login.status_code == 401   # 로그인은 별도 버킷이라 통과


def test_theme_toggle_on_every_page(client):
    """라이트/다크 딸깍 토글: 모든 페이지가 theme.js(head 동기 로드)와
    토글 버튼, 수동 테마 변수 블록(:root[data-theme])을 갖춘다."""
    assert "wt_theme" in client.get("/static/theme.js").text

    def check(page):
        html = client.get(page).text
        assert 'id="themeToggle"' in html, page
        assert "/static/theme.js" in html, page
        assert ':root[data-theme="dark"]' in html, page
        assert ':root[data-theme="light"]' in html, page

    check("/login")  # 로그인 전에 확인 (로그인 뒤엔 /touches 로 리다이렉트됨)
    # 회원 전용 /touches 는 로그인 후 확인
    client.post("/api/auth/signup",
                json={"email": "themetest@example.com", "password": "password123"})
    try:
        for page in ("/", "/ma", "/patterns", "/touches", "/about", "/privacy", "/terms"):
            check(page)
    finally:
        client.post("/api/auth/logout")


def test_privacy_link_in_every_footer(client):
    """이메일을 수집하는 사이트 — 개인정보처리방침 링크가 모든 주요 페이지
    푸터에서 도달 가능해야 한다 (개인정보보호법 고지 의무)."""
    client.post("/api/auth/signup",
                json={"email": "footercheck@example.com", "password": "password123"})
    try:
        for page in ("/", "/ma", "/patterns", "/touches", "/about"):
            html = client.get(page).text
            assert 'href="/privacy"' in html, f"{page} 푸터에 개인정보처리방침 링크 없음"
    finally:
        client.post("/api/auth/logout")


def test_home_has_howto_with_reasons(client):
    """홈의 '처음이신가요?' 이용방법: 3단계 + 각 단계의 '왜' 설명 + 주의문."""
    html = client.get("/").text
    assert "처음이신가요?" in html
    assert html.count("왜 이렇게 하나요?") == 3      # 세 단계 모두 이유를 설명
    for target in ('href="/ma"', 'href="/patterns"', 'href="/touches"'):
        assert target in html
    assert "과거 데이터 통계" in html               # 확인 도구라는 주의


def test_client_ip_uses_last_forwarded_hop():
    """XFF 는 클라이언트가 앞쪽 항목을 위조할 수 있으므로, 신뢰할 수 있는
    마지막 홉(LB 가 덧붙인 실제 접속 IP)을 써야 제한 우회를 막는다."""
    import app.server as server_mod

    class FakeReq:
        def __init__(self, xff):
            self.headers = {"x-forwarded-for": xff}
            self.client = None

    ip = server_mod._client_ip(FakeReq("1.1.1.1, 2.2.2.2, 9.9.9.9"))
    assert ip == "9.9.9.9", "위조 가능한 첫 홉 대신 마지막 홉을 써야 함"


def test_rate_window_overflow_keeps_recent_ips():
    """제한창 초과 정리는 전체 초기화가 아니라 오래된 절반만 비워야 한다 —
    가짜 IP 를 대량으로 보내 정상 사용자 창까지 리셋시키는 우회를 막는다."""
    import time as _t

    import app.server as server_mod

    server_mod._rate_windows.clear()
    now = _t.time()
    # 최신 IP 하나가 현재 창에서 이미 한도까지 찬 상태
    server_mod._rate_windows["recent"] = (now, 999)
    # 오래된 가짜 IP 로 10k 초과 유발 (창은 지났지만 아직 dict 에 남아 있음)
    for i in range(10_050):
        server_mod._rate_windows[f"old{i}"] = (now - 1000.0, 1)
    server_mod._rate_limited("recent")  # 정리 트리거 (recent 는 같은 창이라 +1)
    # 최신 IP 의 카운트가 살아남아야 (전체 초기화면 1로 리셋됨)
    assert server_mod._rate_windows["recent"][1] >= 1000
    assert len(server_mod._rate_windows) < 10_050
    assert server_mod._rate_windows.get("recent") is not None
    server_mod._rate_windows.clear()


def test_vendored_chart_lib_checksum():
    """벤더 파일 변조/실수 수정 감지 — 의도적 업그레이드 시 체크섬도 갱신할 것."""
    import hashlib
    from pathlib import Path

    vendor = Path(__file__).resolve().parent.parent / "static" / "vendor"
    recorded = (vendor / "CHECKSUMS.sha256").read_text().split()[0]
    actual = hashlib.sha256(
        (vendor / "lightweight-charts.standalone.production.js").read_bytes()
    ).hexdigest()
    assert actual == recorded, "벤더 라이브러리가 기록된 체크섬과 다름"


def test_loading_tips_served_and_wired(client):
    """로딩 한입 지식 카드(tips.js)가 서빙되고 두 스캐너 페이지에 연결되어 있다."""
    r = client.get("/static/tips.js")
    assert r.status_code == 200
    assert "LoadingTips" in r.text
    # /touches 는 회원 전용이라 로그인해야 실제 페이지가 나온다 (아니면 /login 리다이렉트)
    client.post("/api/auth/signup",
                json={"email": "tipsview@example.com", "password": "password123"})
    try:
        for page in ("/patterns", "/touches"):
            assert "/static/tips.js" in client.get(page).text
    finally:
        client.post("/api/auth/logout")


def test_loading_tips_fit_two_lines():
    """카드 규칙: 본문 85자 이내(길어야 두 줄) · 태그는 정해진 분류만 사용."""
    import re
    from pathlib import Path

    src = (Path(__file__).resolve().parent.parent / "static" / "tips.js").read_text()
    tips = re.findall(r'T\("([^"]+)", "([^"]+)"\)', src)
    assert len(tips) >= 20, "지식 카드가 예상보다 적음"
    # 형식이 어긋난 카드(이스케이프 따옴표·문자열 연결 등)가 아래 규칙 검사를
    # 조용히 빠져나가지 못하게, 정적 카드 + 동적(백틱) 카드 수를 전체와 대조
    total_calls = len(re.findall(r'T\("', src))
    dynamic_calls = len(re.findall(r'T\("[^"]+", `', src))
    assert len(tips) + dynamic_calls == total_calls, "규칙 검사를 비껴간 카드가 있음"
    allowed = {"패턴 사전", "패턴 이론", "명언", "매크로"}
    for tag, text in tips:
        assert tag in allowed, f"미정의 태그: {tag}"
        assert len(text) <= 85, f"두 줄 규칙(85자) 초과 ({len(text)}자): {text}"
    # 시장 등락 요약 카드(동적 생성)도 존재해야 한다
    assert '"시장 등락"' in src
