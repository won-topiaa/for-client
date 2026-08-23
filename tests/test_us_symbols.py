"""해외(미국) 종목 이름사전과 검색 통합 테스트.

한글/영문 이름으로 미국 티커를 찾는 기능(us_symbols) + free/sample 공급자
검색에 병합되는지, 그리고 이름 매칭 시 가짜 직입력 티커가 새지 않는지 검증.
"""
import asyncio

from app.providers.base import SymbolInfo
from app.providers.us_symbols import (
    _CSV_PATH,
    _entries,
    is_known_ticker,
    matches_name_exactly,
    search_us,
)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# --- 사전 로딩 ---

def test_dictionary_loads_and_has_no_duplicate_tickers():
    entries = _entries()
    assert len(entries) >= 200, "사전이 비었거나 너무 적게 로드됨"
    tickers = [e.ticker for e in entries]
    assert len(tickers) == len(set(tickers)), "중복 티커 존재"
    # 모든 항목이 티커와 표기명을 갖는다
    for e in entries:
        assert e.ticker and e.name and e.terms


def test_csv_file_exists():
    assert _CSV_PATH.exists(), "us_stocks.csv 가 배포 경로에 없음"


# --- 이름/별칭/티커 검색 ---

def test_korean_name_resolves_to_ticker():
    for query, expected in [
        ("애플", "AAPL"),
        ("엔비디아", "NVDA"),
        ("테슬라", "TSLA"),
        ("팔란티어", "PLTR"),
        ("버크셔", "BRK-B"),
    ]:
        results = search_us(query)
        assert results, f"{query!r} 검색 결과 없음"
        assert results[0].symbol == expected, f"{query!r} -> {results[0].symbol} (기대 {expected})"


def test_english_name_resolves_to_ticker():
    assert search_us("apple")[0].symbol == "AAPL"
    assert search_us("nvidia")[0].symbol == "NVDA"


def test_alias_resolves_to_ticker():
    # '테무' 는 PDD 의 별칭, 'tsmc' 는 TSM 의 별칭
    assert search_us("테무")[0].symbol == "PDD"
    assert search_us("tsmc")[0].symbol == "TSM"


def test_exact_ticker_ranks_first():
    results = search_us("AAPL")
    assert results and results[0].symbol == "AAPL"


def test_etf_searchable_by_korean_and_ticker():
    assert search_us("슈드")[0].symbol == "SCHD"
    assert search_us("SPY")[0].symbol == "SPY"
    # 레버리지 ETF 도 이름으로 찾힌다
    assert any(r.symbol == "TQQQ" for r in search_us("나스닥100 3배"))


def test_unknown_query_returns_empty():
    assert search_us("ZZZZ") == []
    assert search_us("존재하지않는종목명") == []
    assert search_us("") == []


def test_result_carries_display_name_and_exchange():
    r = search_us("엔비디아")[0]
    assert r.symbol == "NVDA"
    assert r.name == "엔비디아"
    assert r.market in ("NASDAQ", "NYSE", "AMEX", "OTC")


def test_is_known_ticker():
    assert is_known_ticker("AAPL")
    assert is_known_ticker("aapl")  # 대소문자 무관
    assert not is_known_ticker("APPLE")  # 가짜 티커
    assert not is_known_ticker("005930")  # 국내 코드


def test_matches_name_exactly():
    # 이름/별칭을 '통째로' 친 경우만 True
    assert matches_name_exactly("Apple")
    assert matches_name_exactly("nvidia")
    assert matches_name_exactly("구글")  # 별칭
    # 부분 일치·티커·미등재는 False
    assert not matches_name_exactly("KR")  # 'kraft heinz' 의 부분일 뿐
    assert not matches_name_exactly("AI")
    assert not matches_name_exactly("AAPL")  # 티커 자신과의 일치는 제외
    assert not matches_name_exactly("ZZZZ")
    assert not matches_name_exactly("")


# --- SampleProvider 검색 병합 (네트워크 불필요) ---

def test_sample_provider_merges_us_dictionary():
    from app.providers.sample import SampleProvider

    p = SampleProvider(data_dir=None)
    # '엔비디아' 는 샘플 국내 UNIVERSE 에 없지만 사전으로 찾혀야 한다
    results = _run(p.search("엔비디아"))
    assert any(r.symbol == "NVDA" for r in results)
    # 국내 검색은 그대로 동작
    kr = _run(p.search("삼성"))
    assert any(r.symbol == "005930" for r in kr)


# --- FreeDataProvider 검색: 직접 입력 티커 처리 (상장목록 없이) ---

def _free_provider_without_listing():
    from app.providers.free_data import FreeDataProvider

    p = FreeDataProvider(data_dir=None)

    async def no_listing():
        return None

    p._get_listing = no_listing  # 국내 상장목록 조회를 네트워크 없이 무력화
    return p


def test_free_search_korean_name_returns_us_ticker():
    p = _free_provider_without_listing()
    results = _run(p.search("애플"))
    assert any(r.symbol == "AAPL" for r in results)


def test_free_search_english_name_does_not_leak_fake_ticker():
    # 'Apple' 은 _SYMBOL_RE 에 걸려 가짜 티커 'APPLE' 이 될 수 있다.
    # 이름 매칭(AAPL)이 있으면 가짜 직입력은 버려야 한다.
    p = _free_provider_without_listing()
    results = _run(p.search("Apple"))
    symbols = [r.symbol for r in results]
    assert "AAPL" in symbols
    assert "APPLE" not in symbols


def test_free_search_unknown_ticker_still_works_directly():
    # 사전에 없는 진짜 티커는 직접 입력 경로로 그대로 살아 있어야 한다
    p = _free_provider_without_listing()
    results = _run(p.search("ZZZZ"))
    assert results and results[0].symbol == "ZZZZ"


def test_free_search_known_ticker_not_duplicated():
    p = _free_provider_without_listing()
    results = _run(p.search("AAPL"))
    aapl = [r for r in results if r.symbol == "AAPL"]
    assert len(aapl) == 1, "AAPL 이 직입력+사전으로 중복 노출됨"


def test_free_search_real_ticker_survives_substring_noise():
    # 회귀: 사전에 없는 진짜 티커(KR=크로거, AI=C3.ai, DD=듀폰, ALL=올스테이트)가
    # 사전의 부분 일치 노이즈('kraft'⊃kr 등) 때문에 버려지면 안 된다 —
    # 직입력 후보는 맨 앞에 반드시 남아야 한다.
    p = _free_provider_without_listing()
    for ticker in ("KR", "AI", "DD", "ALL", "ED"):
        results = _run(p.search(ticker))
        assert results and results[0].symbol == ticker, (
            f"{ticker} 직입력이 사전 노이즈에 밀려 사라짐: "
            f"{[r.symbol for r in results][:4]}"
        )
