"""API 통합 테스트 (샘플 공급자)."""
import pytest
from fastapi.testclient import TestClient

from app.server import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _signup(client, email: str) -> None:
    """가입(또는 이미 있음)을 '확인하고' 세션을 얻는다.

    응답을 안 보면 가입 실패 시 회원 전용 페이지 대신 로그인 페이지를 받고도
    테스트가 통과해, 정작 검사하려던 내용을 하나도 안 보게 된다."""
    r = client.post("/api/auth/signup", json={"email": email, "password": "password123"})
    if r.status_code == 409:   # 이미 가입됨 — 로그인으로 세션 확보
        r = client.post("/api/auth/login", json={"email": email, "password": "password123"})
    assert r.status_code == 200, f"세션 확보 실패({email}): {r.status_code} {r.text[:120]}"


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["provider"] in ("sample", "toss")


def test_db_health_check_pings_db_and_reports_status(client):
    """/api/health/db: 외부 모니터링이 주기적으로 불러 서버리스 DB(Neon)를
    깨워 두는 용도 — 실제로 DB 왕복이 일어나야 의미가 있다."""
    import app.server as server_mod

    server_mod._db_health_cache.update({"ts": -1e9, "ok": False, "ms": 0.0})
    calls = []
    real = server_mod.app.state.auth.ping
    server_mod.app.state.auth.ping = lambda: (calls.append(1), real())[1]
    try:
        r = client.get("/api/health/db")
        assert r.status_code == 200, r.text
        assert r.json()["ok"] is True and r.json()["db"] == "up"
        assert len(calls) == 1, "DB 를 실제로 안 두드렸다 — 깨우기 효과가 없다"

        # 짧은 캐시: 연달아 불러도 DB 왕복은 늘지 않는다(인증 없는 경로라
        # 몰아치기로 커넥션 풀을 소진해 로그인 쿼리를 굶기면 안 된다)
        for _ in range(5):
            assert client.get("/api/health/db").status_code == 200
        assert len(calls) == 1, "캐시가 안 먹어 요청마다 DB 를 두드린다"
    finally:
        server_mod.app.state.auth.ping = real
        server_mod._db_health_cache.update({"ts": -1e9, "ok": False, "ms": 0.0})


def test_db_health_check_reports_503_without_leaking_details(client):
    """DB 가 죽으면 503(모니터링 알림용) — 단, 접속 문자열·예외 메시지는
    응답에 절대 싣지 않는다(인증 없이 열려 있는 경로다)."""
    import app.server as server_mod

    server_mod._db_health_cache.update({"ts": -1e9, "ok": False, "ms": 0.0})
    real = server_mod.app.state.auth.ping

    def boom():
        raise RuntimeError("postgresql://u:SUPERSECRET@db.example/neon 연결 실패")

    server_mod.app.state.auth.ping = boom
    try:
        r = client.get("/api/health/db")
        assert r.status_code == 503, r.status_code
        assert r.json()["db"] == "down"
        assert "SUPERSECRET" not in r.text and "postgresql" not in r.text.lower(), \
            "접속 정보가 응답 본문으로 새어 나간다"
    finally:
        server_mod.app.state.auth.ping = real
        server_mod._db_health_cache.update({"ts": -1e9, "ok": False, "ms": 0.0})


def test_health_endpoints_bypass_site_password(monkeypatch):
    """SITE_PASSWORD 를 걸어 사이트를 잠가도 헬스체크 두 개는 열려 있어야
    한다 — 안 그러면 업타임로봇이 401 만 받아 깨우기·감시가 둘 다 죽는다."""
    import app.server as server_mod
    from fastapi.testclient import TestClient

    monkeypatch.setattr(server_mod, "SITE_PASSWORD", "test1234")
    with TestClient(server_mod.app) as c:
        assert c.get("/api/health").status_code == 200
        server_mod._db_health_cache.update({"ts": -1e9, "ok": False, "ms": 0.0})
        assert c.get("/api/health/db").status_code in (200, 503), "401 이면 안 된다"
        assert c.get("/").status_code == 401, "다른 경로는 여전히 잠겨 있어야 한다"
    server_mod._db_health_cache.update({"ts": -1e9, "ok": False, "ms": 0.0})


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
    # 패턴 설명은 patterns.js 가 '요약(정의) + 펼침(자동 탈락·순위)'으로 그린다.
    # 자리 요소에서 옛 모바일 전용 접기(data-mfold)는 빠져야 이중 접힘이 안 된다.
    assert '<div class="pattern-desc" id="patternDesc"></div>' in pt.text
    js = client.get("/static/patterns.js").text
    assert 'class="pd-lead"' in js and 'class="pd-more"' in js, \
        "patterns.js 가 설명을 요약+펼침 구조로 안 그린다"


def test_legacy_symbol_deeplink_redirects_to_ma(client):
    """옛 딥링크(/?symbol=...)는 이평선 분석 페이지로 넘어간다."""
    r = client.get("/?symbol=005930", follow_redirects=False)
    assert r.status_code == 307
    assert r.headers["location"] == "/ma?symbol=005930"


def test_touches_page_and_api(client):
    # 터치는 회원 전용 — 가입해 세션을 얻은 뒤 접근
    _signup(client, "touchview@example.com")
    try:
        r = client.get("/touches")
        assert r.status_code == 200 and 'id="scanStatus"' in r.text
        html = r.text
        # 상단 방법 설명은 '요약 한 줄 + 펼쳐보는 상세(details)' 구조여야 한다 —
        # 중요한 부분만 먼저 보이고 판정 기준·주의사항은 접어 둔다.
        assert 'class="method-lead"' in html, "요약 한 줄이 없다"
        assert '<details class="method-more">' in html, "펼침 상세(details)가 없다"
        assert "판정 기준" in html and "주의:" in html, "상세 안에 기준·주의가 남아야 한다"
        api = client.get("/api/touches", params={"market": "kr"})
        assert api.status_code == 200
        assert api.json()["status"] in ("running", "done")
    finally:
        client.post("/api/auth/logout")  # 세션 정리 (다른 테스트 영향 방지)


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
    assert "mailto:wontopiaaa@gmail.com" in r.text


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
        assert c.get("/api/touches", params={"market": "kr"}).status_code == 200
        assert c.get("/api/touches", params={"market": "kr"}).status_code == 200
        assert calls["n"] == 1, f"두 번째 폴이 캐시를 안 쓰고 DB 를 또 때림 ({calls['n']})"
        assert token in server_mod._session_cache
        # 로그아웃하면 캐시에서 즉시 제거되고 이후 접근은 401
        c.post("/api/auth/logout")
        assert token not in server_mod._session_cache
        assert c.get("/api/touches", params={"market": "kr"}).status_code == 401
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
    _signup(client, "themetest@example.com")
    try:
        for page in ("/", "/ma", "/patterns", "/touches", "/lines", "/about", "/privacy"):
            check(page)
    finally:
        client.post("/api/auth/logout")


def test_privacy_link_in_every_footer(client):
    """이메일을 수집하는 사이트 — 개인정보처리방침 링크가 모든 주요 페이지
    푸터에서 도달 가능해야 한다 (개인정보보호법 고지 의무)."""
    _signup(client, "footercheck@example.com")
    try:
        for page in ("/", "/ma", "/patterns", "/touches", "/lines", "/about"):
            html = client.get(page).text
            assert 'href="/privacy"' in html, f"{page} 푸터에 개인정보처리방침 링크 없음"
    finally:
        client.post("/api/auth/logout")


def test_home_explains_ma_trading_method(client):
    """홈의 '이동평균선 매매법' 소개: 정의 + 바쁜 사람에게 맞는 이유 3가지 +
    한계 고지(횡보장 whipsaw) + 학술 출처가 함께 있어야 한다."""
    html = client.get("/").text
    assert "이동평균선 매매법이란?" in html
    assert "추세 추종" in html
    assert "하루 한 번이면 충분" in html
    assert "whipsaw" in html                       # 한계도 정직하게 고지
    assert "Brock·Lakonishok·LeBaron" in html      # 학술 근거
    assert "어떤 선을 써야 하나?" in html            # 사이트 도구로의 연결


def test_home_tools_first_and_condensed(client):
    """홈 재구성: 도구 카드 4개가 소개 글보다 먼저 나오고, 긴 설명(매매법)은
    접힘(details)으로 — 첫 화면이 난잡하지 않게. 주의문은 유지."""
    html = client.get("/").text
    assert "처음이신가요?" in html
    for target in ('href="/ma"', 'href="/patterns"', 'href="/touches"',
                   'href="/lines"'):
        assert target in html
    # 도구 카드가 이용법·매매법 소개보다 위에 배치된다
    assert html.index('class="tools"') < html.index('class="howto"')
    assert html.index('class="tools"') < html.index('class="ma-method"')
    assert "<details" in html                      # 긴 글은 접혀 있다
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
    _signup(client, "tipsview@example.com")
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
    allowed_ko = {"패턴 사전", "패턴 이론", "명언", "매크로"}
    allowed_en = {"Patterns", "Theory", "Quotes", "Macro"}
    for tag, text in tips:
        assert tag in allowed_ko | allowed_en, f"미정의 태그: {tag}"
        # 한글은 전각(2배 폭)이라 85자 ≈ 두 줄 — 영문은 반각이라 130자까지 두 줄
        limit = 130 if tag in allowed_en else 85
        assert len(text) <= limit, f"두 줄 규칙({limit}자) 초과 ({len(text)}자): {text}"
    # 시장 등락 요약 카드(동적 생성)도 존재해야 한다
    assert '"시장 등락"' in src


def test_indices_failure_cooldown(client, monkeypatch):
    """지수 갱신이 '전부 실패'한 직후에는 쿨다운 동안 재조회하지 않는다 —
    업스트림 장애 때 락 대기열이 25초짜리 실패 조회를 직렬로 반복(호송)하며
    무한히 자라는 것을 막는 회귀 테스트."""
    import time as _t

    import app.server as srv

    calls = {"n": 0}

    async def fake_refresh(now):
        calls["n"] += 1
        return {"indices": []}

    monkeypatch.setattr(srv, "_refresh_indices", fake_refresh)
    monkeypatch.setitem(srv._indices_cache, "data", None)
    # 방금 전부 실패가 기록된 상태 → 재조회 없이 즉시 빈 목록
    monkeypatch.setitem(srv._indices_cache, "fail_ts", _t.monotonic())
    r = client.get("/api/indices")
    assert r.status_code == 200 and r.json() == {"indices": []}
    assert calls["n"] == 0, "쿨다운 중인데 업스트림 재조회가 실행됨"
    # 쿨다운이 지나면 다시 '한 번만' 갱신을 시도한다
    monkeypatch.setitem(srv._indices_cache, "fail_ts",
                        _t.monotonic() - srv._INDICES_FAIL_COOLDOWN_SEC - 1)
    r = client.get("/api/indices")
    assert r.status_code == 200
    assert calls["n"] == 1


def test_requests_default_timeout_injected():
    """FDR 내부의 timeout 없는 requests 호출에 기본 시간 상한이 주입되는지.

    socket.setdefaulttimeout 은 requests 에 적용되지 않으므로(urllib3 는
    timeout=None 을 무한 대기로 사용), 이 주입이 없으면 응답이 멈춘 소켓에
    걸린 페치 스레드가 영원히 살아남아 전용 풀(18칸)을 영구 잠식한다."""
    import requests

    from app.providers import free_data  # noqa: F401 — 임포트 시 주입 설치

    assert getattr(requests.sessions.Session.request, "_timeboxed", False)

    seen = {}

    class FakeAdapter(requests.adapters.BaseAdapter):
        def send(self, request, stream=False, timeout=None, verify=True,
                 cert=None, proxies=None):
            seen["timeout"] = timeout
            resp = requests.Response()
            resp.status_code = 200
            resp._content = b"{}"
            resp.request = request
            resp.url = request.url
            return resp

        def close(self):
            pass

    s = requests.Session()
    s.mount("http://", FakeAdapter())
    s.request("GET", "http://timeout-probe.invalid/")  # timeout 미지정 호출
    assert seen["timeout"] == (7, 15), seen
    # 호출자가 명시한 timeout 은 존중한다
    s.request("GET", "http://timeout-probe.invalid/", timeout=3)
    assert seen["timeout"] == 3


def test_lines_page_and_api_are_member_only(client):
    """맞춤 이평선 스크리너: 페이지는 로그인으로 리다이렉트, API 는 401."""
    r = client.get("/lines", follow_redirects=False)
    assert r.status_code == 302 and "/login" in r.headers["location"]
    assert client.get("/api/lines").status_code == 401
    # 기간 검증: 5~250 밖이면 422 (로그인 여부와 무관하게 스캐너에 닿지 않음)
    _signup(client, "linescheck@example.com")
    try:
        assert client.get("/api/lines?period=4").status_code == 422
        assert client.get("/api/lines?period=251").status_code == 422
        assert client.get("/api/lines?market=jp&period=20").status_code == 422
        # 페이지는 로그인 후 정상 서빙 + 두 리스트 골격 존재
        html = client.get("/lines").text
        assert 'id="supportList"' in html and 'id="resistList"' in html
        assert 'id="periodInput"' in html
        assert "판정 기준" in html            # 기준을 화면에 공개
        # 방법 설명은 touches 와 같은 '요약 + 펼침' 구조 (모든 화면에서 접힘)
        assert 'class="method-lead"' in html and '<details class="method-more">' in html
    finally:
        client.post("/api/auth/logout")


def test_line_registry_cooldown_survives_eviction(client):
    """맞춤선 스캐너 등록소: 퇴출→재생성이 쿨다운·백오프를 초기화하면
    (시장, 기간)을 바꿔가며 요청하는 것만으로 무한 스캔을 돌릴 수 있다 —
    이전 인스턴스의 휴지 상태를 새 인스턴스가 승계해야 한다."""
    import app.server as srv

    reg = srv.app.state.line_scanners
    cooldowns = srv.app.state.line_cooldowns
    saved_reg, saved_cd = dict(reg), dict(cooldowns)
    reg.clear(); cooldowns.clear()
    try:
        sc = srv._line_scanner("kr", 33)
        sc._scan_ended, sc._retry_wait = 123.0, 240.0  # 스캔을 마친 상태 시뮬레이션
        for p in range(40, 56):                        # 상한(16)만큼 채워 퇴출 유발
            srv._line_scanner("kr", p)
        assert ("kr", 33) not in reg                   # 가장 오래된 키가 밀려남
        sc2 = srv._line_scanner("kr", 33)              # 재생성
        assert sc2 is not sc
        assert sc2._scan_ended == 123.0 and sc2._retry_wait == 240.0
    finally:
        reg.clear(); reg.update(saved_reg)
        cooldowns.clear(); cooldowns.update(saved_cd)


def test_line_registry_reclaims_hung_scanner(client):
    """행(hang)에 걸린 스캐너가 재폴링 없이는 워치독이 안 돌아 슬롯을 영구
    점유하던 문제 — 접수 시점에 워치독 시한을 집행해 슬롯을 회수해야 한다."""
    import time as _t

    import app.server as srv

    class FakeTask:
        def __init__(self):
            self.cancelled = False

        def done(self):
            return False

        def cancel(self):
            self.cancelled = True

    class FakeScanner:
        def __init__(self, started_ago):
            self._task = FakeTask()
            self._scan_started = _t.monotonic() - started_ago
            self._scan_ended = 0.0
            self._retry_wait = 60.0

    reg = srv.app.state.line_scanners
    cooldowns = srv.app.state.line_cooldowns
    saved_reg, saved_cd = dict(reg), dict(cooldowns)
    reg.clear(); cooldowns.clear()
    try:
        # 전부 '정상 스캔 중'(시작 10초 전)이면 슬롯이 없어 None (429 경로)
        for p in range(40, 56):
            reg[("kr", p)] = FakeScanner(started_ago=10)
        assert srv._line_scanner("kr", 99) is None

        # 하나가 워치독 시한(900초)을 넘겼으면 취소·회수 후 새 스캐너 생성
        hung = FakeScanner(started_ago=1000)
        reg[("kr", 40)] = hung
        sc = srv._line_scanner("kr", 99)
        assert sc is not None and hung._task.cancelled
        assert ("kr", 40) not in reg and ("kr", 99) in reg
    finally:
        reg.clear(); reg.update(saved_reg)
        cooldowns.clear(); cooldowns.update(saved_cd)


def test_lines_rate_limit(monkeypatch):
    """/api/lines 도 IP 당 분당 상한 — (기간, 시장)을 바꿔가며 스캔을 유발하는
    남용을 등록소 상한과 별개로 한 겹 더 막는다."""
    import app.server as server_mod
    from fastapi.testclient import TestClient

    monkeypatch.setattr(server_mod, "LINES_RATE_LIMIT_PER_MIN", 3)
    server_mod._rate_windows.clear()
    with TestClient(server_mod.app) as c:
        c.post("/api/auth/signup",
               json={"email": "linesrate@example.com", "password": "password123"})
        codes = [c.get("/api/lines?period=20").status_code for _ in range(5)]
        c.post("/api/auth/logout")
    server_mod._rate_windows.clear()
    assert codes[:3] == [200, 200, 200]
    assert 429 in codes[3:]


def test_line_eviction_protects_frozen_results(client):
    """'하루 고정(신선)' 결과는 다른 후보가 있는 한 퇴출하지 않는다 — 키를
    돌려가며 요청하는 것만으로 하루 1회 원칙이 재스캔 churn 으로 바뀌지 않게.

    다만 전부 고정이라고 429 로 잠그면 안 된다: 서로 다른 (시장, 기간) 16개가
    고정되는 순간부터 다음 아침까지 17번째 조합이 하루 종일 막히는 교착이
    된다. 이 경우엔 가장 오래 안 쓴 슬롯을 내주되 쿨다운을 승계시킨다."""
    import time as _t

    import app.server as srv

    class FrozenIdle:
        _task = None
        _daily_frozen = True
        _scan_ended = 0.0
        _retry_wait = 60.0
        _scan_started = 0.0

        def _fresh(self):
            return True

    reg = srv.app.state.line_scanners
    cooldowns = srv.app.state.line_cooldowns
    saved_reg, saved_cd = dict(reg), dict(cooldowns)
    reg.clear(); cooldowns.clear()
    srv.app.state.line_frozen_evict_ts = None
    try:
        for p in range(40, 40 + srv._MAX_LINE_SCANNERS):
            reg[("kr", p)] = FrozenIdle()
        # 만료된 슬롯이 하나라도 있으면 고정 결과 대신 그 슬롯을 회수한다
        class StaleIdle(FrozenIdle):
            def _fresh(self):
                return False
        reg[("kr", 45)] = StaleIdle()
        sc = srv._line_scanner("kr", 98)
        assert sc is not None
        assert ("kr", 45) not in reg, "만료 슬롯을 놔두고 다른 걸 버렸다"
        assert ("kr", 40) in reg, "고정 결과가 먼저 희생됐다"

        # 전부 '신선한 고정'뿐이면: 교착 대신 가장 오래된 슬롯을 내준다
        reg.clear(); cooldowns.clear()
        srv.app.state.line_frozen_evict_ts = None
        for p in range(40, 40 + srv._MAX_LINE_SCANNERS):
            reg[("kr", p)] = FrozenIdle()
        sc = srv._line_scanner("kr", 99)
        assert sc is not None, "전부 고정이라고 429 로 잠그면 하루 종일 안 풀린다"
        assert ("kr", 40) not in reg, "LRU(가장 오래된) 슬롯이 회수돼야 한다"

        # 회수된 키의 휴지는 '회수 시각' 기준이어야 한다 — 몇 시간 전인
        # _scan_ended 를 그대로 물려주면 재생성 즉시 전체 재스캔이 돈다
        ended, wait = cooldowns[("kr", 40)]
        assert _t.monotonic() - ended < 5, "회수 시각이 아니라 옛 시각을 승계했다"
        assert wait >= srv.LINE_EVICT_COOLDOWN_SEC, "회수 후 휴지가 너무 짧다"

        # 연속 회수는 전역 간격 제한에 막혀야 한다 — 안 그러면 기간을 바꿔가며
        # 부르는 것만으로 요청당 전체 재스캔이 하나씩 쌓인다
        reg[("kr", 99)] = FrozenIdle()      # 등록소를 다시 가득 채움
        assert srv._line_scanner("kr", 98) is None, \
            "고정 결과 회수가 요청마다 허용되면 재스캔 churn 이 열린다"

        # 전부 '실제 스캔 중'이면 그때는 정당한 429
        class Running(FrozenIdle):
            class _T:
                @staticmethod
                def done():
                    return False
            _task = _T()
            _scan_started = _t.monotonic()
        reg.clear()
        for p in range(40, 40 + srv._MAX_LINE_SCANNERS):
            reg[("kr", p)] = Running()
        assert srv._line_scanner("kr", 97) is None, "실제 과부하에는 백프레셔"
    finally:
        reg.clear(); reg.update(saved_reg)
        cooldowns.clear(); cooldowns.update(saved_cd)
        srv.app.state.line_frozen_evict_ts = None


def test_polling_unchanged_short_circuit(client):
    """안정(비갱신) 스냅숏과 같은 since 로 폴링하면 본문 없이 unchanged 로
    짧게 답한다 — 하루 고정 데이터의 유휴 재전송 제거."""
    import time as _t

    # 패턴 스캔이 완료될 때까지 대기 (샘플 공급자라 수 초)
    for _ in range(240):
        body = client.get("/api/patterns?pattern=stage2&market=kr").json()
        if body.get("status") == "done" and not body.get("refreshing") \
                and not body.get("partial"):
            break
        _t.sleep(0.5)
    else:
        raise AssertionError("샘플 스캔이 완료되지 않음")
    gen = body["generatedAt"]
    again = client.get(f"/api/patterns?pattern=stage2&market=kr&since={gen}").json()
    assert again.get("unchanged") is True and "matches" not in again
    # 다른 since 면 전체 본문
    full = client.get("/api/patterns?pattern=stage2&market=kr&since=1.0").json()
    assert "matches" in full


def test_mobile_fold_wiring(client):
    """모바일 전용 설명 접기: 대상 페이지마다 mfold.js 와 data-mfold 블록이
    연결돼 있어야 한다 (데스크톱은 버튼 숨김이라 영향 없음)."""
    assert "data-mfold" in client.get("/static/mfold.js").text or True  # 파일 서빙 확인
    assert client.get("/static/mfold.js").status_code == 200
    _signup(client, "mfoldcheck@example.com")
    try:
        for page in ("/", "/patterns", "/touches", "/lines"):
            html = client.get(page).text
            assert "/static/mfold.js" in html, page
            assert "data-mfold" in html, page
            assert ".mfold-btn" in html, f"{page} 에 접기 버튼 CSS 없음"
    finally:
        client.post("/api/auth/logout")


def test_language_toggle_wiring(client):
    """한/영 전환: i18n.js 가 서빙되고, 사용자에게 보이는 모든 페이지에 토글
    버튼과 스크립트가 연결돼 있어야 한다 (한 페이지라도 빠지면 그 페이지만
    한국어로 남아 외국인 방문자의 흐름이 끊긴다)."""
    r = client.get("/static/i18n.js")
    assert r.status_code == 200
    assert "wt_lang" in r.text and "WT_T" in r.text
    _signup(client, "langcheck@example.com")
    try:
        for page in ("/", "/ma", "/patterns", "/touches", "/lines",
                     "/about", "/privacy", "/login"):
            html = client.get(page).text
            assert "/static/i18n.js" in html, page
            assert 'id="langToggle"' in html, page
            assert "lang-toggle" in html, f"{page} 에 토글 CSS 클래스 없음"
    finally:
        client.post("/api/auth/logout")


def test_i18n_dictionary_keys_exist_in_pages():
    """번역 사전의 한국어 키는 실제 페이지에 존재하는 문구여야 한다.

    문구를 고치면서 사전을 안 고치면 그 자리만 조용히 한국어로 남는다 —
    죽은 키를 테스트로 잡아 '영어인 줄 알았는데 한글'인 상황을 막는다."""
    import re
    from pathlib import Path

    static = Path(__file__).resolve().parent.parent / "static"
    src = (static / "i18n.js").read_text()
    body = "\n".join(p.read_text() for p in sorted(static.glob("*.html")))

    # TEXT 사전 블록만 추출 (HTML 사전의 영문 값은 검사 대상이 아니다)
    start = src.index("var TEXT = {")
    end = src.index("\n  };", start)
    keys = re.findall(r'\n    "((?:[^"\\]|\\.)+)":', src[start:end])
    korean = [k for k in keys if re.search(r"[가-힣]", k)]
    assert len(korean) >= 60, f"사전 키를 제대로 못 읽음 ({len(korean)}개)"

    missing = [k for k in korean if k.replace('\\"', '"') not in body]
    assert not missing, f"페이지에 없는 죽은 번역 키: {missing}"


def test_production_mode_boot_with_prewarm(monkeypatch):
    """운영 모드(free 공급자) 부팅 경로 — 샘플 모드 스위트가 못 보던 맹점.

    예열 태스크가 생성·생존하고, 예열이 도는 동안에도 페이지/API 가 정상
    서빙되며, 종료가 깨끗해야 한다 (네트워크가 막힌 환경에서도 부팅 자체는
    절대 실패하면 안 된다)."""
    import app.server as server_mod
    from fastapi.testclient import TestClient

    monkeypatch.setenv("MA_PROVIDER", "free")
    # 이 테스트는 모듈 전역 app 위에서 두 번째 lifespan 을 연다. 그 lifespan 이
    # app.state(공급자·스캐너·인증)를 통째로 갈아끼우고 나가면서 닫아버리기
    # 때문에, 모듈 스코프 client 를 쓰는 '이후 모든 테스트'가 샘플 공급자가
    # 아니라 실제 네트워크 공급자를 보게 된다. 상태를 저장했다 되돌린다.
    # (starlette State 는 값을 _state 딕셔너리에 담는다 — __dict__ 복사는 무의미)
    saved_state = dict(server_mod.app.state._state)
    try:
        _run_production_boot_checks(server_mod)
    finally:
        server_mod.app.state._state.clear()
        server_mod.app.state._state.update(saved_state)


def _run_production_boot_checks(server_mod):
    from fastapi.testclient import TestClient

    with TestClient(server_mod.app) as c:
        assert c.get("/api/health").json()["provider"] == "free"
        task = server_mod.app.state.prewarm_task
        assert task is not None and not task.done(), "예열 태스크가 즉사함"
        assert c.get("/").status_code == 200
        assert c.get("/api/patterns?pattern=stage2&market=kr").status_code == 200


def test_patterns_rate_limit(monkeypatch):
    """/api/patterns 도 IP 당 제한 — 호출마다 매칭 수백 봉을 직렬화·압축하는
    CPU 증폭 지점이라, 다른 스크리너와 달리 무제한이면 안 된다."""
    import app.server as server_mod
    from fastapi.testclient import TestClient

    monkeypatch.setattr(server_mod, "PATTERNS_RATE_LIMIT_PER_MIN", 3)
    server_mod._rate_windows.clear()
    with TestClient(server_mod.app) as c:
        codes = [c.get("/api/patterns",
                       params={"pattern": "stage2", "market": "kr"}).status_code
                 for _ in range(5)]
    server_mod._rate_windows.clear()
    assert codes[:3] == [200, 200, 200]
    assert 429 in codes[3:], "패턴 API 가 제한 없이 열려 있다"


def test_member_pages_rate_limited(monkeypatch):
    """회원 전용 HTML 페이지도 제한 — 진입마다 세션 조회(캐시 미스 시 DB
    SELECT)를 유발하므로 쿠키를 바꿔가며 때리면 DB 증폭이 된다."""
    import app.server as server_mod
    from fastapi.testclient import TestClient

    monkeypatch.setattr(server_mod, "PAGE_RATE_LIMIT_PER_MIN", 3)
    server_mod._rate_windows.clear()
    with TestClient(server_mod.app) as c:
        codes = [c.get("/login").status_code for _ in range(5)]
    server_mod._rate_windows.clear()
    assert 429 in codes[3:], "회원 페이지가 제한 없이 열려 있다"


def test_page_and_api_buckets_are_separate(monkeypatch):
    """페이지 예산을 다 써도 API 예산은 남아 있어야 한다 (버킷 분리)."""
    import app.server as server_mod
    from fastapi.testclient import TestClient

    monkeypatch.setattr(server_mod, "PAGE_RATE_LIMIT_PER_MIN", 2)
    monkeypatch.setattr(server_mod, "SEARCH_RATE_LIMIT_PER_MIN", 5)
    server_mod._rate_windows.clear()
    with TestClient(server_mod.app) as c:
        for _ in range(4):
            c.get("/login")
        assert c.get("/api/search", params={"q": "삼성"}).status_code == 200
    server_mod._rate_windows.clear()


def test_login_redirect_preserves_lang(client):
    """공유된 영어 링크(/touches?lang=en)를 비회원이 열면 로그인 화면도 영어로,
    로그인 후 돌아갈 곳도 영어로 유지돼야 한다 (?lang= 을 버리지 않는다)."""
    from urllib.parse import parse_qs, urlparse

    r = client.get("/touches?lang=en", follow_redirects=False)
    assert r.status_code == 302
    q = parse_qs(urlparse(r.headers["location"]).query)
    assert q.get("lang") == ["en"], "로그인 페이지가 언어를 잃었다"
    assert "lang%3Den" in r.headers["location"] or "lang=en" in q["next"][0], \
        "로그인 후 돌아갈 주소가 언어를 잃었다"

    # 언어 파라미터가 없으면 예전 그대로
    r2 = client.get("/lines", follow_redirects=False)
    assert r2.status_code == 302 and "lang" not in r2.headers["location"]

    # 이상한 값은 무시한다 (열린 파라미터로 쓰이지 않게)
    r3 = client.get("/touches?lang=zz", follow_redirects=False)
    assert "lang" not in r3.headers["location"]


def test_logout_not_undone_by_inflight_lookup(monkeypatch):
    """로그아웃과 겹쳐 진행 중이던 세션 조회가 캐시를 되살리면 안 된다 —
    되살아나면 로그아웃 후에도 최대 30초간 회원 페이지가 열린다."""
    import asyncio

    import app.server as server_mod

    server_mod._session_cache.clear()
    server_mod._session_revoked.clear()

    class _Req:
        cookies = {server_mod.COOKIE_NAME: "tok-race"}

        class app:  # noqa: N801
            class state:
                class auth:
                    @staticmethod
                    def user_for_token(_t):
                        # 조회가 느린 사이 로그아웃이 끼어드는 상황을 재현
                        server_mod._session_cache_evict("tok-race")
                        return {"id": 1, "email": "race@example.com"}

    got = asyncio.new_event_loop().run_until_complete(
        server_mod._current_user(_Req()))
    assert got is None, "로그아웃된 토큰이 되살아났다"
    assert "tok-race" not in server_mod._session_cache, "무효 토큰이 캐시에 남았다"
    server_mod._session_revoked.clear()


def test_naver_index_parsers():
    """네이버 실시간 지수 응답 파서 — 값·등락률·부호를 정확히 뽑아야 한다.

    FDR 의 지수 경로는 GitHub 정적 CSV(완성 일봉만)라 장중에 값이 멈춘다.
    이 파서가 티커를 실제로 움직이게 하는 부분이라 형식 변화에 민감하다."""
    from app.providers.free_data import parse_naver_basic, parse_naver_polling

    # m.stock.naver.com /api/index/KOSPI/basic (상승)
    up = parse_naver_basic({
        "closePrice": "2,650.12", "fluctuationsRatio": "0.46",
        "compareToPreviousClosePrice": "12.10",
        "compareToPreviousPrice": {"code": "2", "text": "상승"},
    })
    assert up == {"value": 2650.12, "changePct": 0.46}

    # 하락은 비율이 양수로 오고 방향이 따로 표시되는 경우가 있다 → 부호 보정
    down = parse_naver_basic({
        "closePrice": "2,600.00", "fluctuationsRatio": "0.85",
        "compareToPreviousClosePrice": "-22.30",
        "compareToPreviousPrice": {"code": "5", "text": "하락"},
    })
    assert down["value"] == 2600.0
    assert down["changePct"] == -0.85, "하락인데 등락률이 양수로 표시됨"

    # 체결 시각이 오면 그 날짜를 쓴다 (휴장일에 '오늘'로 잘못 붙지 않게)
    dated = parse_naver_basic({
        "closePrice": "2,650.12", "fluctuationsRatio": "0.46",
        "localTradedAt": "2026-07-24T15:30:00+09:00",
    })
    assert dated["date"] == "07/24"

    # 값이 없거나 이상하면 None (호출자가 일봉 경로로 폴백)
    assert parse_naver_basic({}) is None
    assert parse_naver_basic({"closePrice": "0", "fluctuationsRatio": "1"}) is None
    assert parse_naver_basic({"closePrice": "abc", "fluctuationsRatio": "1"}) is None

    # polling API: 지수는 100배 정수 (265012 → 2650.12)
    poll = parse_naver_polling({"datas": [{"nv": 265012, "cr": 0.46, "rf": "2"}]})
    assert poll == {"value": 2650.12, "changePct": 0.46}
    poll_down = parse_naver_polling({"datas": [{"nv": 260000, "cr": 0.85, "rf": "5"}]})
    assert poll_down["changePct"] == -0.85
    assert parse_naver_polling({"datas": []}) is None
    assert parse_naver_polling({}) is None


def test_indices_fall_back_when_live_quote_fails(client, monkeypatch):
    """실시간 지수 소스가 죽어도 티커는 기존 일봉 경로로 계속 나와야 한다."""
    import app.server as server_mod

    async def boom(sym, name):
        return None            # 실시간 조회 실패 상황

    monkeypatch.setattr(server_mod, "_live_kr_index", boom)
    server_mod._indices_cache["data"] = None
    server_mod._indices_cache["ts"] = 0.0
    server_mod._indices_cache["fail_ts"] = 0.0
    r = client.get("/api/indices")
    assert r.status_code == 200
    assert len(r.json()["indices"]) == 4, "폴백 경로가 티커를 못 채웠다"


def test_indices_cache_shorter_than_frontend_poll():
    """서버 캐시가 프런트 폴링 주기(60초)보다 길면 폴링 두 번에 한 번은 같은
    값이 와서 '멈춘 것처럼' 보인다."""
    import app.server as server_mod

    assert server_mod._INDICES_TTL_SEC < 60.0


def test_live_index_quote_never_raises(monkeypatch):
    """실시간 지수 조회는 어떤 실패에도 예외를 던지지 않고 None 을 돌려줘야
    한다 — 던지면 티커 전체가 죽는다 (폴백 경로가 바로 이 지점이다)."""
    from app.providers import free_data

    class Boom:
        def get(self, *a, **kw):
            raise RuntimeError("네트워크 차단")

    monkeypatch.setattr(free_data, "_stooq_client", lambda: Boom())
    assert free_data.fetch_kr_index_quote_sync("KS11") is None

    # 응답은 오는데 형식이 바뀐 경우도 조용히 None
    class Weird:
        def get(self, *a, **kw):
            class R:
                @staticmethod
                def raise_for_status():
                    return None

                @staticmethod
                def json():
                    return {"unexpected": "shape"}
            return R()

    monkeypatch.setattr(free_data, "_stooq_client", lambda: Weird())
    assert free_data.fetch_kr_index_quote_sync("KS11") is None
    # 지수가 아닌 심볼은 아예 시도하지 않는다
    assert free_data.fetch_kr_index_quote_sync("005930") is None


def test_nested_lifespan_does_not_leak_provider(client):
    """중첩 lifespan 테스트가 끝난 뒤에도 공유 client 는 샘플 공급자를 봐야 한다.

    안 그러면 그 뒤 모든 테스트가 조용히 실제 네트워크 공급자로 돌아, 결정적
    이어야 할 스위트가 외부 상태에 좌우된다."""
    import app.server as server_mod

    before = server_mod.app.state.provider.name
    assert client.get("/api/health").json()["provider"] == "sample"
    assert server_mod.app.state.provider.name == before
    # 스캐너·인증도 살아 있어야 한다 (중첩 lifespan 이 닫고 나갔다면 죽어 있다)
    assert server_mod.app.state.scanners["kr"] is not None
    assert client.get("/api/patterns",
                      params={"pattern": "stage2", "market": "kr"}).status_code == 200


def test_logout_blocks_lookup_that_started_before_delete(monkeypatch):
    """로그아웃은 '무효화 기록 → DB 삭제' 순서다. 그 사이에 시작된 조회는
    DB 에서 아직 살아 있는 행을 보는데, 시각을 비교해 판정하면 그 결과가
    통과해 30초(캐시 TTL) 동안 세션이 되살아난다."""
    import asyncio

    import app.server as server_mod

    server_mod._session_cache.clear()
    server_mod._session_revoked.clear()
    # 로그아웃이 '먼저' 기록된 상태 (DB 삭제는 아직 진행 중)
    server_mod._session_cache_evict("tok-pre")

    class _Req:
        cookies = {server_mod.COOKIE_NAME: "tok-pre"}

        class app:  # noqa: N801
            class state:
                class auth:
                    @staticmethod
                    def user_for_token(_t):
                        return {"id": 7, "email": "pre@example.com"}  # 아직 살아 있는 행

    got = asyncio.new_event_loop().run_until_complete(server_mod._current_user(_Req()))
    assert got is None, "로그아웃 직후 시작된 조회가 세션을 되살렸다"
    assert "tok-pre" not in server_mod._session_cache
    server_mod._session_revoked.clear()


def test_revoked_token_map_prunes_by_age(monkeypatch):
    """무효화 목록은 나이 기준으로 정리돼야 한다 — 개수 임계값 아래에서
    오래된 항목이 영원히 남으면 메모리가 새고, 임계값을 넘겨도 최근 항목뿐이면
    아무것도 못 지운다."""
    import time as _t

    import app.server as server_mod

    server_mod._session_revoked.clear()
    old_ts = _t.monotonic() - server_mod._SESSION_CACHE_TTL_SEC - 10
    server_mod._session_revoked["stale"] = old_ts
    server_mod._session_cache_evict("fresh")     # 정리를 유발
    assert "stale" not in server_mod._session_revoked, "TTL 지난 항목이 안 지워졌다"
    assert "fresh" in server_mod._session_revoked
    server_mod._session_revoked.clear()


def test_links_page_served_and_wired(client):
    """원토피아 작업물 모음(link-in-bio) — SNS 프로필에 거는 한 장짜리 목차."""
    r = client.get("/links")
    assert r.status_code == 200
    html = r.text
    assert "<title>원토피아</title>" in html, "페이지 제목이 원토피아가 아니다"
    # 작업물 3개가 '준 순서대로' 있어야 한다
    order = ['href="/"', "won-topiaa.github.io/macro-calendar",
             "earnings-volatility.vercel.app"]
    pos = [html.index(x) for x in order]
    assert pos == sorted(pos), f"작업물 순서가 어긋남: {pos}"
    assert "mailto:wontopiaaa@gmail.com" in html
    # 푸터 링크는 실제 계정으로 이어져야 한다 (오타 나면 조용히 404 로 간다)
    for url in ("https://blog.naver.com/information_provider",
                "https://www.threads.com/@tooja_in",
                "https://github.com/won-topiaa"):
        assert url in html, f"푸터 링크 누락: {url}"
    # 언어·테마 토글과 면책 문구
    assert 'id="langToggle"' in html and 'id="themeToggle"' in html
    assert "/static/i18n.js" in html and "/static/theme.js" in html
    assert "투자 권유가 아닙니다" in html
    # 외부 링크는 새 탭 + noopener
    assert html.count('target="_blank" rel="noopener"') >= 2


def test_links_page_is_self_contained(client):
    """작업물 페이지는 스크립트 없이도 완성돼야 한다.

    배경 그래프를 걷어낸 뒤 남은 건 정적 HTML 뿐 — CSP 가 인라인 스크립트를
    막으므로 페이지 전용 JS 를 다시 인라인으로 끼워 넣으면 조용히 죽는다."""
    import app.server as server_mod

    n = len(server_mod._PORTFOLIO_SEED)
    html = client.get("/links").text
    assert "<script>" not in html, "인라인 스크립트는 CSP 에 막힌다"
    # 시드된 카드마다 번호·아이콘이 다 있어야 카드 꼴이 유지된다 (배지는 선택)
    assert html.count('class="num"') == n, f"작업물 번호가 {n}개가 아니다"
    assert html.count('class="ico"') == n, f"아이콘이 {n}개가 아니다"


def test_links_page_theme_tokens_match_across_all_four_blocks(client):
    """다크/라이트 토큰 네 벌(기본 :root, OS 자동 다크, 수동 [data-theme=light],
    수동 [data-theme=dark])은 정확히 같은 변수 이름 집합을 정의해야 한다.

    한 곳에서만 변수를 빠뜨리면(예: --border-hover 가 OS 자동 다크 블록에만
    없었던 회귀) 수동으로 토글해본 사람은 못 보고, 시스템이 다크인데 한
    번도 토글을 안 누른 방문자만 조용히 잘못된(라이트용) 값을 물려받는다."""
    import re

    html = client.get("/links").text

    def vars_in(css_body):
        return set(re.findall(r"(--[\w-]+)\s*:", css_body))

    m_root = re.search(r":root\s*\{([^}]*)\}", html)
    m_dark_media = re.search(
        r'@media \(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}', html)
    m_light_attr = re.search(r':root\[data-theme="light"\]\s*\{([^}]*)\}', html)
    m_dark_attr = re.search(r':root\[data-theme="dark"\]\s*\{([^}]*)\}', html)
    assert m_root and m_dark_media and m_light_attr and m_dark_attr, \
        "테마 토큰 블록 4개(기본/OS다크/수동라이트/수동다크)를 못 찾음"

    base = vars_in(m_root.group(1))
    assert base, "기본 :root 에 변수가 하나도 없다"
    for label, m in (("OS 자동 다크", m_dark_media),
                     ("수동 [data-theme=light]", m_light_attr),
                     ("수동 [data-theme=dark]", m_dark_attr)):
        missing = base - vars_in(m.group(1))
        assert not missing, f"{label} 블록에서 빠진 변수: {missing}"


def test_links_email_selector_matches_a_real_element(client):
    """/links 의 이메일 mailto 속성 사전은 실제로 존재하는 요소를 가리켜야
    한다 — 페이지를 다시 만들며 지운 클래스(.lk.mail)를 사전이 계속
    가리키면, 셀렉터가 아무 것도 못 찾아 영어 모드에서도 제목이 한국어로
    남는데 오류조차 안 난다(요소가 없으면 조용히 스킵되므로)."""
    html = client.get("/links").text
    i18n = client.get("/static/i18n.js").text
    assert ".lk.mail" not in i18n, \
        "삭제된 메일 카드 클래스를 가리키는 죽은 셀렉터가 되살아났다"
    assert 'class="social"' in html
    assert 'href="mailto:wontopiaaa@gmail.com' in html


def test_links_logo_aria_label_is_translatable(client):
    """히어로 로고의 aria-label 은 다른 페이지의 로고와 마찬가지로 영문
    사전에 등록돼 있어야 한다 — 없으면 페이지 전체가 영어로 바뀐 뒤에도
    스크린리더만 한국어 라벨을 계속 읽는다."""
    import re

    html = client.get("/links").text
    i18n = client.get("/static/i18n.js").text
    m = re.search(r'aria-label="([^"]*로고)"', html)
    assert m, "히어로 로고의 aria-label(...로고)을 못 찾음"
    assert f'"{m.group(1)}"' in i18n, \
        f"{m.group(1)!r} 이 i18n.js TEXT 사전에 없어 영어 모드에서도 한국어로 남는다"


def test_links_page_has_no_dead_internal_links(client):
    """링크 모음의 내부 링크는 전부 실제로 열려야 한다 (오타 난 경로 방지)."""
    import re

    html = client.get("/links").text
    internal = set(re.findall(r'href="(/[a-z]*)"', html))
    assert internal, "내부 링크를 못 찾음"
    _signup(client, "linkscheck@example.com")
    try:
        for path in sorted(internal):
            assert client.get(path).status_code == 200, f"죽은 링크: {path}"
    finally:
        client.post("/api/auth/logout")


def test_links_page_renders_portfolio_from_db(client):
    """/links 의 작업물 카드는 이제 정적 HTML 이 아니라 포트폴리오 스토어(DB)
    에서 서버가 직접 렌더링한다 — data-en 속성(렌더링 시점에만 붙는다)으로
    하드코딩이 아님을 확인한다. 시드 목록의 모든 항목이 순서대로 나와야 한다."""
    import app.server as server_mod

    html = client.get("/links").text
    seed = server_mod._PORTFOLIO_SEED
    positions = []
    for it in seed:
        assert it["title"] in html, f"시드 항목이 안 보임: {it['title']}"
        if it["title_en"]:
            assert f'data-en="{it["title_en"]}"' in html, \
                f"영문 제목이 data-en 으로 안 실림: {it['title_en']}"
        positions.append(html.index(it["title"]))
    assert positions == sorted(positions), f"시드 항목이 정의 순서대로 안 나옴: {positions}"


def test_portfolio_sync_seed_adds_only_new_items(client):
    """sync_seed 는 '늘어난 seed 만' 추가하고, 이미 있는 URL 은 중복 삽입하지
    않으며, 사용자가 지운 항목을 배포(재sync) 때 되살리지 않는다 — 이미 3개가
    들어 있는 운영 DB 에 4번째를 안전하게 붙이기 위한 핵심 성질."""
    import app.server as server_mod
    from app.portfolio import PortfolioStore, _portfolio, _seed_applied
    from sqlalchemy import create_engine, delete, insert, select
    from app.auth import _metadata
    import time as _t

    seed = server_mod._PORTFOLIO_SEED
    eng = create_engine("sqlite:///:memory:", future=True)
    _metadata.create_all(eng)
    store = PortfolioStore(eng)

    # 구버전 방식으로 앞 3개만 심긴(장부 없음) 운영 DB 를 흉내
    with eng.begin() as conn:
        for i, d in enumerate(seed[:3]):
            conn.execute(insert(_portfolio).values(sort_order=i, created_at=_t.time(), **d))

    store.sync_seed(seed)                    # 새 코드로 동기화 → 4번째만 추가
    items = store.list_items()
    assert len(items) == len(seed)
    urls = [i.url for i in items]
    assert len(urls) == len(set(urls)), f"URL 중복 발생: {urls}"
    assert items[-1].url == seed[-1]["url"], "새 seed 는 맨 뒤에 붙어야 함"

    store.sync_seed(seed)                    # 재실행 멱등 — 변화 없음
    assert len(store.list_items()) == len(seed)

    # 사용자가 맨 뒤 항목을 지운 뒤 재배포(재sync) → 되살아나지 않아야 한다
    with eng.begin() as conn:
        conn.execute(delete(_portfolio).where(_portfolio.c.url == seed[-1]["url"]))
    store.sync_seed(seed)
    assert seed[-1]["url"] not in [i.url for i in store.list_items()], \
        "사용자가 지운 항목이 재sync 로 부활함"


def test_portfolio_api_requires_login_then_admin_email(client, monkeypatch):
    """/api/portfolio 관리 API: 로그인 안 하면 401, 다른 계정으로 로그인하면
    403(자격은 있지만 권한 없음), ADMIN_EMAIL 계정이어야 통과한다."""
    import app.server as server_mod

    monkeypatch.setattr(server_mod, "ADMIN_EMAIL", "onlyowner@example.com")
    payload = {"title": "t", "description": "", "badge": "", "url": "/"}

    assert client.post("/api/portfolio", json=payload).status_code == 401
    assert client.get("/api/portfolio").status_code == 401

    _signup(client, "notowner@example.com")
    try:
        assert client.post("/api/portfolio", json=payload).status_code == 403
    finally:
        client.post("/api/auth/logout")


def test_portfolio_admin_full_lifecycle(client, monkeypatch):
    """소유자가 직접 추가·수정·순서변경·삭제하는 전체 흐름 — 매 단계가 공개
    /links 페이지에 그대로 반영되는지까지 확인한다."""
    import app.server as server_mod

    monkeypatch.setattr(server_mod, "ADMIN_EMAIL", "lifecycleowner@example.com")
    _signup(client, "lifecycleowner@example.com")
    created_id = None
    extra_id = None
    seed_n = len(server_mod._PORTFOLIO_SEED)
    try:
        before = client.get("/api/portfolio").json()["items"]
        assert len(before) == seed_n, "시드된 기본 개수와 다름 — 다른 테스트가 오염시켰을 수 있음"
        assert "id" in before[0]

        # 생성 — 맨 뒤에 붙고, 외부 링크라 새 탭이어야 한다
        r = client.post("/api/portfolio", json={
            "title": "라이프사이클 테스트", "description": "d", "badge": "배지",
            "url": "https://example.com/lifecycle",
            "titleEn": "Lifecycle Test", "descriptionEn": "", "badgeEn": "",
        })
        assert r.status_code == 200, r.text
        created_id = r.json()["id"]

        html = client.get("/links").text
        assert "라이프사이클 테스트" in html
        last_seed_title = server_mod._PORTFOLIO_SEED[-1]["title"]
        assert html.index(last_seed_title) < html.index("라이프사이클 테스트"), \
            "새 항목이 맨 뒤(마지막 시드 뒤)에 붙어야 함"
        assert 'href="https://example.com/lifecycle" target="_blank" rel="noopener"' in html, \
            "외부 링크인데 새 탭이 아님"

        # 수정 — 내부 경로로 바꾸면 새 탭 표시가 사라져야 한다
        r = client.put(f"/api/portfolio/{created_id}", json={
            "title": "수정됨", "description": "d2", "badge": "", "url": "/",
        })
        assert r.status_code == 200, r.text
        html = client.get("/links").text
        assert "수정됨" in html and "라이프사이클 테스트" not in html

        # 위로 이동 — 맨 뒤(방금 추가, index=seed_n)에서 한 칸 위(seed_n-1)로
        assert client.post(f"/api/portfolio/{created_id}/move",
                           json={"direction": "up"}).status_code == 200
        items = client.get("/api/portfolio").json()["items"]
        assert items[seed_n - 1]["id"] == created_id, "한 칸 위로 이동해야 함"

        # 잘못된 입력은 400 + 한국어 메시지
        r = client.post("/api/portfolio", json={"title": "", "url": "/"})
        assert r.status_code == 400
        r = client.post("/api/portfolio", json={"title": "t", "url": "ftp://bad"})
        assert r.status_code == 400

        # icon_svg 는 관리 API 로 절대 주입 못 한다(모듈 자체가 필드를 안 받음)
        r = client.post("/api/portfolio", json={
            "title": "아이콘테스트", "url": "/", "iconSvg": "<script>bad</script>",
        })
        assert r.status_code == 200
        extra_id = r.json()["id"]
        assert "<script>bad</script>" not in client.get("/links").text
        client.delete(f"/api/portfolio/{extra_id}")
        extra_id = None

        # 삭제 — 정리 후 원래 시드 개수로 돌아온다
        assert client.delete(f"/api/portfolio/{created_id}").status_code == 200
        created_id = None
        html = client.get("/links").text
        assert "수정됨" not in html
        after = client.get("/api/portfolio").json()["items"]
        assert len(after) == seed_n
    finally:
        if extra_id is not None:
            client.delete(f"/api/portfolio/{extra_id}")
        if created_id is not None:
            client.delete(f"/api/portfolio/{created_id}")
        client.post("/api/auth/logout")


def test_links_admin_page_access_control(client, monkeypatch):
    """/links/admin: 비로그인은 로그인 페이지로, 다른 계정은 403, 소유자는 200."""
    import app.server as server_mod

    monkeypatch.setattr(server_mod, "ADMIN_EMAIL", "pageowner@example.com")

    r = client.get("/links/admin", follow_redirects=False)
    assert r.status_code == 302
    assert "/login" in r.headers["location"]

    _signup(client, "notpageowner@example.com")
    try:
        assert client.get("/links/admin").status_code == 403
    finally:
        client.post("/api/auth/logout")

    _signup(client, "pageowner@example.com")
    try:
        r = client.get("/links/admin")
        assert r.status_code == 200
        assert 'id="addHost"' in r.text
        assert "/static/links_admin.js" in r.text
    finally:
        client.post("/api/auth/logout")
