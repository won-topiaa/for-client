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
