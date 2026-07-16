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
    r = client.get("/touches")
    assert r.status_code == 200 and 'id="scanStatus"' in r.text
    api = client.get("/api/touches", params={"market": "kr"})
    assert api.status_code == 200
    assert api.json()["status"] in ("running", "done")


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
    for page in ("/patterns", "/touches"):
        assert "/static/tips.js" in client.get(page).text


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
