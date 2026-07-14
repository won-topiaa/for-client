"""배포 준비 회귀 가드 — 공개 배포의 3대 불변식을 못 박는다:
① 어떤 입력에도 사용자에게 500(서버 오류)이 뜨지 않는다
② 어떤 시세 소스 상태에도 스캔이 done/error 로 반드시 정착한다 (무한 running 없음)
③ 어떤 퇴화 프레임에도 analyze 응답이 NaN/Inf 없이 직렬화된다
"""
import asyncio
import json

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.config import load_settings
from app.pattern_scan import PatternScanner
from app.providers.base import SymbolInfo, validate_candles
from app.providers.cache import CachingProvider
from app.server import app
from app.service import analyze_symbol
from app.touch_scan import TouchScanner

CAND = [5, 10, 20, 50, 60, 100, 120, 200, 240]


def _good(n=800, seed=1):
    c = np.maximum(100 + np.cumsum(np.random.default_rng(seed).normal(0.05, 1.0, n)), 5.0)
    return validate_candles(pd.DataFrame({
        "date": pd.bdate_range("2020-01-02", periods=n),
        "open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "volume": 100.0}))


# ---------- ① 엔드포인트 500 배제 ----------

@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_endpoints_never_500_on_hostile_input(client):
    """SQL 인젝션·XSS·경로순회·널바이트·유니코드·극단값 — 무엇을 넣어도 500 금지."""
    hostile = [
        "", " ", "005930'; DROP TABLE x", "<script>alert(1)</script>",
        "../../etc/passwd", "%00", "٠٠٥٩٣٠", "A" * 500, "😀",
        "005930\n000660", "NaN", "Infinity", "-1", "^GSPC", "\t",
    ]
    for s in hostile:
        assert client.get("/api/analyze", params={"symbol": s}).status_code != 500
        assert client.get("/api/search", params={"q": s}).status_code != 500
    for y in ["-1", "1e9", "abc", "NaN", "999999", "0x10", "3.14"]:
        assert client.get("/api/analyze",
                          params={"symbol": "005930", "years_day": y}).status_code != 500
    for m in ["kr", "us", "xx", "", "kr; DROP", "korea"]:
        assert client.get("/api/patterns", params={"market": m}).status_code != 500
        assert client.get("/api/touches", params={"market": m}).status_code != 500
    for pat in ["stage2", "bogus", "", "'", "../x"]:
        assert client.get("/api/patterns",
                          params={"pattern": pat, "market": "kr"}).status_code != 500
    for path in ["/", "/ma", "/patterns", "/touches", "/about",
                 "/ma?symbol=<script>", "/nope", "/api/indices", "/api/health"]:
        assert client.get(path).status_code != 500


# ---------- ② 스캔은 어떤 소스 상태에도 정착 ----------

class _AllFail:
    name = "fake"
    async def candles(self, s, tf, mb, use_fail_cache=False):
        raise RuntimeError("업스트림 다운")
    async def search(self, q):
        return []


class _Degenerate:
    """진짜 소스가 줄 법한 이상 프레임을 돌아가며 반환."""
    name = "fake"
    def __init__(self):
        self.n = 0
    async def candles(self, s, tf, mb, use_fail_cache=False):
        self.n += 1
        k = self.n % 5
        if k == 0:
            return validate_candles(pd.DataFrame(
                {c: [] for c in ["date", "open", "high", "low", "close", "volume"]}))
        if k == 1:
            return _good(1)
        if k == 2:
            df = _good(800, seed=k); df["volume"] = np.nan
            return df
        if k == 3:
            return _good(120, seed=k)
        return _good(800, seed=k)
    async def search(self, q):
        return []


def _universe(n):
    async def fn():
        return [SymbolInfo(f"S{i}", f"종목{i}", "KOSPI") for i in range(n)]
    return fn


async def _drive_to_settle(scanner, deadline=30):
    await scanner.snapshot()
    if scanner._task is not None:
        await asyncio.wait_for(asyncio.shield(scanner._task), timeout=deadline)
    return await scanner.snapshot()


@pytest.mark.parametrize("Prov", [_AllFail, _Degenerate])
@pytest.mark.parametrize("kind", ["pattern", "touch"])
def test_scan_always_settles_no_infinite_running(Prov, kind):
    async def go():
        cache = CachingProvider(Prov())
        if kind == "touch":
            sc = TouchScanner(cache, _universe(30), candidates=CAND)
        else:
            sc = PatternScanner(cache, _universe(30), index_symbol="KS11")
        snap = await _drive_to_settle(sc)
        assert snap["status"] in ("done", "error"), snap
        if snap["status"] == "error":
            assert snap.get("detail")
        else:
            for key in ("scanned", "universe", "elapsedSec", "generatedAt"):
                assert key in snap
            # 완료 결과가 NaN/Inf 없이 직렬화돼야 엔드포인트가 500 을 내지 않는다
            json.dumps(snap, allow_nan=False)
    asyncio.new_event_loop().run_until_complete(asyncio.wait_for(go(), timeout=40))


# ---------- ③ analyze 직렬화는 퇴화 프레임에도 NaN/Inf 무누수 ----------

@pytest.mark.parametrize("kind", ["pattern", "touch"])
def test_slow_source_yields_partial_not_infinite_loading(kind, monkeypatch):
    """느린 소스에서도 스캔이 소프트 시간예산 안에 '부분 결과'로 끝나야 한다 —
    워치독(900초)까지 갈아버리며 취소→재시도를 반복(=무한 로딩)하지 않게."""
    import app.pattern_scan as ps
    import app.touch_scan as ts

    monkeypatch.setattr(ps, "SCAN_SOFT_BUDGET_SEC", 2.0)
    monkeypatch.setattr(ts, "SCAN_SOFT_BUDGET_SEC", 2.0)

    class Slow:
        name = "fake"
        async def candles(self, s, tf, mb, use_fail_cache=False):
            await asyncio.sleep(0.25)
            return _good(seed=hash(s) % 9999)
        async def search(self, q):
            return []

    async def go():
        cache = CachingProvider(Slow())
        if kind == "touch":
            sc = TouchScanner(cache, _universe(300), candidates=CAND)
        else:
            sc = PatternScanner(cache, _universe(300), index_symbol="KS11")
        t0 = asyncio.get_event_loop().time()
        snap = await _drive_to_settle(sc, deadline=15)
        assert snap["status"] == "done", snap
        assert snap.get("partial") is True, "예산 초과인데 partial 로 표시 안 됨"
        assert 0 < snap["scanned"] < 300, f"부분이 아님: {snap['scanned']}"
        assert asyncio.get_event_loop().time() - t0 < 10, "예산 안에 끝나지 않음"
    asyncio.new_event_loop().run_until_complete(asyncio.wait_for(go(), timeout=20))


@pytest.mark.parametrize("kind", ["constant", "tiny", "spikes", "onebar", "normal"])
def test_analyze_serializes_without_nan_on_degenerate_frames(kind):
    settings = load_settings()

    def frame():
        if kind == "constant":
            n = 800; c = np.full(n, 7.0)
        elif kind == "tiny":
            n = 3; c = np.array([1., 2., 3.])
        elif kind == "onebar":
            n = 1; c = np.array([5.0])
        elif kind == "spikes":
            n = 900; c = np.full(n, 100.0); c[::50] = 1.0; c[25::50] = 500.0
        else:
            n = 900
            c = np.maximum(100 + np.cumsum(np.random.default_rng(3).normal(0, 3, n)), 1.0)
        return validate_candles(pd.DataFrame({
            "date": pd.bdate_range("2018-01-02", periods=n),
            "open": c, "high": c * 1.02, "low": c * 0.98, "close": c, "volume": 100.0}))

    class Prov:
        name = "fake"
        async def candles(self, s, tf, mb, use_fail_cache=False):
            return frame()
        async def search(self, q):
            return []

    out = asyncio.new_event_loop().run_until_complete(
        analyze_symbol(Prov(), settings, "005930", {"day": 3.0, "week": 7.0, "month": None}))
    # FastAPI JSONResponse 와 동일하게 allow_nan=False — NaN/Inf 있으면 여기서 터진다
    json.dumps(out, allow_nan=False)


def test_scan_publishes_partial_results_while_running(monkeypatch):
    """스캔이 도는 동안 '부분 결과'가 완료 전에 여러 번 공개돼, 사용자가 첫
    결과를 몇 초 만에 보고 점점 채워지는 것을 보게 한다 (점진 공개)."""
    import app.pattern_scan as ps

    monkeypatch.setattr(ps, "PUBLISH_INTERVAL_SEC", 0.3)

    class Net:
        name = "fake"
        async def candles(self, s, tf, mb, use_fail_cache=False):
            await asyncio.sleep(0.1)
            return _good(seed=hash(s) % 9999)
        async def search(self, q):
            return []

    async def go():
        cache = CachingProvider(Net())
        sc = PatternScanner(cache, _universe(60), index_symbol="KS11")
        task = asyncio.create_task(sc._scan())
        seen_scanned = set()
        while not task.done():
            await asyncio.sleep(0.25)
            if sc._results is not None:
                seen_scanned.add(sc._results["scanned"])
        await task
        # 완료 전 서로 다른 scanned 값의 부분 스냅샷이 2회 이상 있어야 한다
        partial_counts = [s for s in seen_scanned if s < 60]
        assert len(partial_counts) >= 2, f"점진 공개 안 됨: {sorted(seen_scanned)}"
        assert sc._results["scanned"] == 60 and sc._partial is False
    asyncio.new_event_loop().run_until_complete(asyncio.wait_for(go(), timeout=30))
