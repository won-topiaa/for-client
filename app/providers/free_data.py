"""무료 시세 공급자 (FinanceDataReader 우선, Yahoo Finance 보조).

키·IP 허용 목록이 필요 없어서 공개 배포에 적합하다.
- 검색: FinanceDataReader 의 KRX 상장 목록(전 종목 이름/코드)으로 이름 검색.
- 캔들: fdr.DataReader 로 일봉 전체 히스토리. 실패하면 yfinance 로 폴백.
- 주봉/월봉은 service 층에서 일봉을 리샘플링해 만든다(공급자는 일봉만 제공).

FinanceDataReader/yfinance 는 비공식·무료 소스라 간헐적으로 느리거나 스키마가
바뀔 수 있어, 컬럼명은 관용적으로 매칭하고 두 소스를 이중화했다.
"""
from __future__ import annotations

import asyncio
import functools
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pandas as pd

from .base import SymbolInfo, validate_candles

# 종목코드(6자리 숫자)/미국 티커
_SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-]{1,12}$")
_LISTING_TTL_SEC = 12 * 3600  # 상장 목록은 거의 안 바뀜

# 국내 신형 종목코드 (2024.1 개편 — normalize_listing 의 유효성 규칙과 동일)
_KR_NEW_CODE_RE = re.compile(r"^\d{4}[0-9A-HJ-NP-TV-Z][0-9KLMN]$")
_KR_INDEXES = {"KS11", "KQ11"}
# FDR 지수 표기 전체 — 개별 종목이 아니므로 Stooq(*.us) 폴백 대상이 아니다
_FDR_INDEX_NOTATIONS = {"US500", "IXIC", "DJI", "KS11", "KQ11"}


def _kr_route(symbol: str) -> bool:
    """국내 경로(네이버/KRX 소스) 여부 — 이 경로는 야후 요청 제한과 무관하다."""
    return (symbol.isdigit()
            or bool(_KR_NEW_CODE_RE.match(symbol))
            or symbol.upper() in _KR_INDEXES)


# ---- 야후 요청 전역 페이싱 ----
# 무료 야후 API 는 데이터센터 IP(Render 등)에서 초당 몇 건만 넘어도 429 로
# IP 를 잠근다. 스캐너가 동시 6개로 훑으면 순식간에 전 종목이 막히므로,
# 야후로 가는 모든 요청(FDR 미국 리더 포함)의 시작 간격에 하한을 둔다.
# (페치는 to_thread 로 도는 동기 코드라 threading 락을 쓴다)
_YAHOO_MIN_INTERVAL_SEC = 0.35
_yahoo_gate = threading.Lock()
_yahoo_next_ts = 0.0


def _yahoo_pace() -> None:
    global _yahoo_next_ts
    with _yahoo_gate:
        now = time.monotonic()
        wait = _yahoo_next_ts - now
        _yahoo_next_ts = max(now, _yahoo_next_ts) + _YAHOO_MIN_INTERVAL_SEC
    if wait > 0:
        time.sleep(wait)


def _pick_col(df: pd.DataFrame, *names: str) -> str | None:
    lower = {c.lower(): c for c in df.columns}
    for n in names:
        if n.lower() in lower:
            return lower[n.lower()]
    return None


def normalize_ohlcv(raw: pd.DataFrame) -> pd.DataFrame:
    """FDR/yfinance 의 OHLCV DataFrame -> 표준 컬럼(date,open,high,low,close,volume)."""
    if raw is None or len(raw) == 0:
        raise ValueError("빈 시세 데이터")
    df = raw.copy()
    if isinstance(df.columns, pd.MultiIndex):  # yf.download 형태 방어
        df.columns = df.columns.get_level_values(0)
    # 날짜가 인덱스인 경우 컬럼으로 꺼낸다
    if not isinstance(df.index, pd.RangeIndex):
        df = df.reset_index()
    date_col = _pick_col(df, "date", "index", "Date", "Datetime")
    # 'index' 는 무명 DatetimeIndex 전용 후보 — 정수 인덱스가 epoch 로
    # 오해석되어 쓰레기 날짜가 조용히 통과하는 것을 방지
    if (date_col and date_col.lower() == "index"
            and not pd.api.types.is_datetime64_any_dtype(df[date_col])):
        raise ValueError("날짜 컬럼을 찾지 못함 (index 가 날짜형이 아님)")
    o = _pick_col(df, "open")
    h = _pick_col(df, "high")
    low = _pick_col(df, "low")
    c = _pick_col(df, "close", "adj close", "adjclose")
    v = _pick_col(df, "volume", "vol")
    if not all([date_col, o, h, low, c]):
        raise ValueError(f"OHLCV 컬럼을 찾지 못함: {list(df.columns)}")
    out = pd.DataFrame({
        "date": df[date_col],
        "open": df[o],
        "high": df[h],
        "low": df[low],
        "close": df[c],
        "volume": df[v] if v else 0,
    })
    return validate_candles(out)


def normalize_listing(raw: pd.DataFrame) -> pd.DataFrame:
    """fdr.StockListing('KRX') -> symbol/name/market (+선택: amount/marcap) 목록."""
    code = _pick_col(raw, "code", "symbol", "종목코드")
    name = _pick_col(raw, "name", "종목명")
    market = _pick_col(raw, "market", "시장구분")
    if not code or not name:
        raise ValueError(f"상장목록 컬럼을 찾지 못함: {list(raw.columns)}")
    codes = raw[code].astype(str).str.strip()
    out = pd.DataFrame({
        "symbol": codes.str.zfill(6),
        "name": raw[name].astype(str).str.strip(),
        "market": (raw[market].astype(str).str.strip() if market else ""),
    })
    # 스크리너 유니버스 선정용 부가 컬럼 (있을 때만)
    amount = _pick_col(raw, "amount", "거래대금")
    marcap = _pick_col(raw, "marcap", "시가총액")
    if amount:
        out["amount"] = pd.to_numeric(raw[amount], errors="coerce")
    if marcap:
        out["marcap"] = pd.to_numeric(raw[marcap], errors="coerce")
    # 유효 코드만: 순수 숫자(1~6자리) 또는 2024.1 개편 이후의 영문 포함
    # 신형 코드(예: 00088K 한화3우B, 0126Z0). 빈 값이 zfill 로 000000 이
    # 되는 것은 여전히 걸러진다.
    valid = (
        codes.str.match(r"^\d{1,6}$")
        | codes.str.match(r"^\d{4}[0-9A-HJ-NP-TV-Z][0-9KLMN]$")
    )
    return out[valid].reset_index(drop=True)


def _start_for(max_bars: int | None) -> str:
    """필요 봉 수에 맞는 시작일 — 스크리너가 수백 종목을 훑을 때
    전체 히스토리 다운로드를 피한다 (거래일 보정 1.7배 + 여유)."""
    if not max_bars or max_bars > 2000:
        return "1990-01-01"
    days = int(max_bars * 1.7) + 40
    return (pd.Timestamp.today() - pd.Timedelta(days=days)).strftime("%Y-%m-%d")


def _fetch_fdr_sync(symbol: str, start: str = "1990-01-01") -> pd.DataFrame:
    import FinanceDataReader as fdr
    return fdr.DataReader(symbol, start)


def _fetch_yahoo_sync(symbol: str, market: str = "", period: str = "max") -> pd.DataFrame:
    import yfinance as yf

    candidates: list[str] = []
    if symbol.isdigit():  # 국내 종목: 시장에 따라 접미사
        if market.upper().startswith("KOSDAQ"):
            candidates = [f"{symbol}.KQ", f"{symbol}.KS"]
        else:
            candidates = [f"{symbol}.KS", f"{symbol}.KQ"]
    else:
        candidates = [symbol]  # 미국 티커 등
        # 지수 심볼(FDR 표기) -> Yahoo 표기
        idx_map = {"US500": "^GSPC", "KS11": "^KS11", "KQ11": "^KQ11",
                   "IXIC": "^IXIC", "DJI": "^DJI"}
        if symbol.upper() in idx_map:
            candidates.append(idx_map[symbol.upper()])
        # 클래스주 점 표기(BRK.B) -> Yahoo 대시 표기(BRK-B)
        if "." in symbol:
            candidates.append(symbol.replace(".", "-"))
    for tkr in candidates:
        try:
            _yahoo_pace()
            hist = yf.Ticker(tkr).history(period=period, interval="1d", auto_adjust=False)
        except Exception:
            hist = None
        if hist is not None and len(hist) > 0:
            return hist
    raise ValueError(f"{symbol} Yahoo 조회 실패")


# Stooq(미국) 조회는 같은 호스트(stooq.com)에 종목마다 한 번씩, 스캔당 수백 번
# 연결한다. 매 요청을 httpx.get 으로 새로 열면 TCP+TLS 핸드셰이크가 매번
# 반복돼(종목당 수백 ms) 스캔 전체가 느려진다. 공유 Client 로 커넥션을
# 재사용(keep-alive)해 그 비용을 없앤다 — 요청 '수'는 그대로라 소스 부담은
# 늘지 않고, httpx.Client 는 스레드 세이프라 _fetch_pool 스레드가 함께 써도 안전.
_stooq_http = None                      # 지연 생성되는 공유 httpx.Client
_stooq_http_lock = threading.Lock()


def _stooq_client():
    global _stooq_http
    if _stooq_http is None:
        with _stooq_http_lock:
            if _stooq_http is None:
                import httpx
                _stooq_http = httpx.Client(
                    timeout=8.0, follow_redirects=True,
                    limits=httpx.Limits(max_keepalive_connections=16,
                                        max_connections=32,
                                        keepalive_expiry=30.0))
    return _stooq_http


def close_stooq_client() -> None:
    """공유 Stooq 클라이언트 정리 (셧다운 시). 없거나 두 번 불러도 안전."""
    global _stooq_http
    client, _stooq_http = _stooq_http, None
    if client is not None:
        try:
            client.close()
        except Exception:  # noqa: BLE001 — 종료 정리는 실패해도 무시
            pass


def _fetch_stooq_sync(symbol: str, start: str) -> pd.DataFrame:
    """Stooq 일봉 CSV — 미국 티커의 1순위 소스 (무키·데이터센터 친화적).

    무료·무키 소스로, 형식은 Date,Open,High,Low,Close,Volume CSV.
    클래스주는 대시 표기(brk-b.us)를 쓴다. 타임아웃을 짧게(8초) 잡아,
    혹시 막혔더라도 슬롯을 빨리 반납해 야후 폴백으로 넘어가게 한다.
    커넥션은 공유 풀에서 재사용한다(_stooq_client).
    """
    import io

    t = symbol.lower().replace(".", "-")
    d1 = start.replace("-", "")
    d2 = pd.Timestamp.today().strftime("%Y%m%d")
    url = f"https://stooq.com/q/d/l/?s={t}.us&d1={d1}&d2={d2}&i=d"
    r = _stooq_client().get(url)
    r.raise_for_status()
    text = r.text.strip()
    first = text.splitlines()[0] if text else ""
    if not text or "," not in first:  # 실패 시 "No data" 등 단문이 온다
        raise ValueError("Stooq: 데이터 없음")
    return pd.read_csv(io.StringIO(text))


_LISTING_TIMEOUT_SEC = 15.0   # 상장목록 다운로드 시간 상한
_LISTING_RETRY_SEC = 60.0     # 실패 후 재시도 억제 (실패 폭주 방지)
# 종목별 시세 조회 시간 상한 — 정상 조회는 1~3초라 넉넉하다. 짧게 잡을수록
# hang 걸린 종목이 동시성 슬롯을 빨리 반납해, 수백 종목 스캔이 소프트 예산 안에
# 더 많은 종목을 훑는다 (lifespan 의 socket 기본 타임아웃 20초가 더 깊은 방어선).
_CANDLES_TIMEOUT_SEC = 25.0


class FreeDataProvider:
    name = "free"

    def __init__(self, data_dir: Path | None = None):
        self._listing: pd.DataFrame | None = None
        self._listing_ts = 0.0
        self._listing_fail_ts = -1e9
        self._listing_lock = asyncio.Lock()
        self._market_by_symbol: dict[str, str] = {}
        self._us_listing: list[tuple[str, str, str]] | None = None
        self._us_ts = 0.0
        self._us_fail_ts = -1e9
        # KR/US 목록은 상태를 공유하지 않으므로 락도 분리 (KR 갱신 15초가
        # US 스캔 시작을 막지 않게)
        self._us_lock = asyncio.Lock()
        # 네트워크 페치 전용 스레드풀 — wait_for 에 버려진 행 스레드가 기본
        # 실행기(작은 인스턴스에선 5칸)를 잠식해 분석 연산·상장목록까지 굶기는
        # 것을 막는다. 여기서 새면 다른 '페치'만 느려질 뿐이다. 동시 페치
        # 상한(CONCURRENCY=10)보다 넉넉히 잡아 큐잉으로 병목되지 않게 한다.
        self._fetch_pool = ThreadPoolExecutor(
            max_workers=14, thread_name_prefix="candle-fetch")

    def _listing_fresh(self) -> bool:
        return (self._listing is not None
                and time.monotonic() - self._listing_ts < _LISTING_TTL_SEC)

    async def _get_listing(self) -> pd.DataFrame | None:
        if self._listing_fresh():
            return self._listing
        # 최근 실패했으면 잠시 재시도하지 않는다 (요청마다 다운로드 재시도 방지)
        if time.monotonic() - self._listing_fail_ts < _LISTING_RETRY_SEC:
            return self._listing
        async with self._listing_lock:
            if self._listing_fresh():
                return self._listing
            if time.monotonic() - self._listing_fail_ts < _LISTING_RETRY_SEC:
                return self._listing
            try:
                # 데이터 소스가 응답을 안 주면 검색 전체가 영구 블록되므로
                # 시간 상한 필수 (락과 API 는 풀리고, 스레드는 알아서 끝남)
                raw = await asyncio.wait_for(
                    asyncio.get_running_loop().run_in_executor(
                        self._fetch_pool, _load_listing_sync),
                    timeout=_LISTING_TIMEOUT_SEC,
                )
                listing = normalize_listing(raw)
            except Exception:
                self._listing_fail_ts = time.monotonic()
                return self._listing  # 실패 시 기존(있으면) 유지, 없으면 None
            if listing is None or listing.empty:
                # 컬럼은 있으나 행이 0개인 응답(스크레이프 드리프트 등)을 12시간
                # '정상'으로 캐시하면 검색·유니버스가 통째로 비어버린다 — 실패로 취급해
                # 짧은 백오프 뒤 재시도한다 (기존 값이 있으면 유지)
                self._listing_fail_ts = time.monotonic()
                return self._listing
            self._listing = listing
            self._listing_ts = time.monotonic()
            self._market_by_symbol = dict(zip(listing["symbol"], listing["market"]))
            return listing

    async def search(self, query: str) -> list[SymbolInfo]:
        q = query.strip()
        if not q:
            return []
        results: list[SymbolInfo] = []
        seen: set[str] = set()
        # 직접 입력한 코드/티커 경로는 상장목록과 무관하게 항상 동작해야 한다
        direct: SymbolInfo | None = None
        if _SYMBOL_RE.match(q):
            code = q if q.isdigit() else q.upper()
            direct = SymbolInfo(code, code, "")
        listing = await self._get_listing()
        if listing is not None:
            ql = q.lower()
            mask = (
                listing["name"].str.lower().str.contains(ql, regex=False, na=False)
                | listing["symbol"].str.contains(q, regex=False, na=False)
            )
            for _, row in listing[mask].head(20).iterrows():
                if row["symbol"] in seen:
                    continue
                seen.add(row["symbol"])
                results.append(SymbolInfo(row["symbol"], row["name"], row["market"]))
        if direct is not None and direct.symbol not in seen:
            results.insert(0, direct)
        return results[:20]

    async def candles(self, symbol: str, timeframe: str, max_bars: int) -> pd.DataFrame:
        # 이 공급자는 일봉 전용 — 주/월봉은 service 층에서 리샘플링한다.
        # 조용히 일봉을 돌려주면 잘못 라벨된 데이터가 캐시에 박히므로 방어.
        if timeframe != "day":
            raise ValueError(
                f"FreeDataProvider 는 일봉만 제공합니다 (요청: {timeframe})"
            )
        try:
            loop = asyncio.get_running_loop()
            df = await asyncio.wait_for(
                loop.run_in_executor(
                    self._fetch_pool,
                    functools.partial(self._fetch_daily_sync, symbol, max_bars),
                ),
                timeout=_CANDLES_TIMEOUT_SEC,
            )
        except (asyncio.TimeoutError, TimeoutError) as exc:
            raise RuntimeError(
                f"{symbol} 시세 조회가 {int(_CANDLES_TIMEOUT_SEC)}초를 초과했습니다 "
                "(데이터 소스 응답 지연 — 잠시 후 다시 시도해 주세요)"
            ) from exc
        return df.tail(max_bars).reset_index(drop=True)

    def _fetch_daily_sync(self, symbol: str, max_bars: int | None = None) -> pd.DataFrame:
        errors: list[str] = []
        start = _start_for(max_bars)
        windowed = start != "1990-01-01"

        def mark_window_bound(df: pd.DataFrame) -> pd.DataFrame:
            # 창 제한 조회가 요청량보다 적게 돌아오면 (장기 거래정지 등)
            # '히스토리 소진'이 아니라 '창이 짧았던 것'일 수 있다 —
            # 캐시가 잘린 데이터를 전체 기간으로 오인하지 않게 표시.
            # 단, 첫 봉이 요청 시작일보다 한참 뒤라면 상장이 늦어 히스토리
            # 자체가 짧은 것(진짜 소진)이므로 표시하지 않는다 — 아니면
            # 신생 종목이 캐시 불가가 되어 매 요청 재조회하게 된다.
            # ('truncated' 와 달리 창이 자른 경우 같은 크기 요청은 같은
            # 결과이므로 캐시가 같은/작은 요청을 그대로 응답해도 된다.)
            if windowed and max_bars and len(df) < max_bars:
                if df["date"].iloc[0] <= pd.Timestamp(start) + pd.Timedelta(days=10):
                    df.attrs["window_bound"] = True
            return df

        def via_fdr() -> pd.DataFrame | None:
            try:
                if not _kr_route(symbol):
                    _yahoo_pace()  # FDR 의 미국 리더도 야후를 때린다
                raw = _fetch_fdr_sync(symbol, start)
                if raw is None or len(raw) == 0:
                    errors.append("FDR: 빈 응답")  # 무효 종목이면 예외 없이 빈 df
                    return None
                return mark_window_bound(normalize_ohlcv(raw))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"FDR: {exc}")
                return None

        def via_yahoo() -> pd.DataFrame | None:
            try:
                market = self._market_by_symbol.get(symbol, "")
                period = ("max" if not max_bars or max_bars > 2000
                          else "3y" if max_bars <= 520 else "10y")
                df = normalize_ohlcv(_fetch_yahoo_sync(symbol, market, period))
                if period != "max" and max_bars and len(df) < max_bars:
                    # mark_window_bound 와 같은 이유 — 기간(period)이 실제로
                    # 데이터를 자른 경우에만 표시.
                    years = 3 if period == "3y" else 10
                    expected_start = (pd.Timestamp.today().normalize()
                                      - pd.DateOffset(years=years))
                    if df["date"].iloc[0] <= expected_start + pd.Timedelta(days=10):
                        df.attrs["window_bound"] = True
                return df
            except Exception as exc:  # noqa: BLE001
                errors.append(f"Yahoo: {exc}")
                return None

        def via_stooq() -> pd.DataFrame | None:
            # 미국 일반 티커 전용 — 지수 표기(문자만인 IXIC/DJI 포함)·국내
            # 코드는 제외 (Stooq 의 *.us 네임스페이스는 개별 종목 전용)
            if (symbol.upper() in _FDR_INDEX_NOTATIONS
                    or not re.match(r"^[A-Za-z][A-Za-z.\-]*$", symbol)):
                return None
            try:
                return mark_window_bound(
                    normalize_ohlcv(_fetch_stooq_sync(symbol, start)))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"Stooq: {exc}")
                return None

        # 국내(네이버/KRX 소스)는 FDR 우선 — 빠르고 제한이 없다.
        # 미국 일반 티커는 Stooq 우선: 야후(yfinance/FDR)는 쿠키 없는 요청이
        # 데이터센터 IP(Render 등)에서 자주 막히거나(429)·행에 걸려 미국 스캔
        # 전체를 느리게 만든다. Stooq(*.us CSV)는 무키·데이터센터 친화적이라
        # 미국을 안정적으로 채운다. Stooq 가 못 주는 티커만 야후로 폴백한다.
        # (지수 표기는 via_stooq 가 스스로 걸러 내므로 야후→FDR 로 간다.)
        if _kr_route(symbol):
            chain = (via_fdr, via_yahoo)
        else:
            chain = (via_stooq, via_yahoo, via_fdr)
        for fetch in chain:
            df = fetch()
            if df is not None and len(df) > 0:
                return df
        raise RuntimeError(
            f"{symbol} 시세를 가져오지 못했습니다 ({' / '.join(errors)})"
        )

    async def listing_frame(self) -> pd.DataFrame | None:
        """정규화된 KRX 상장목록 (amount/marcap 포함 가능). 스크리너 유니버스용."""
        return await self._get_listing()

    # FDR 의 위키피디아 리더는 클래스주 티커의 점을 제거한다 (BRK.B -> BRKB).
    # Yahoo 는 대시 형식(BRK-B)만 인식하므로 알려진 것들을 복원한다.
    _US_TICKER_FIX = {"BRKB": "BRK-B", "BFB": "BF-B"}

    async def us_listing(self) -> list[tuple[str, str, str]] | None:
        """S&P500 구성종목 [(symbol, name, sector)]. 12시간 캐시 + 백오프."""
        def fresh() -> bool:
            return (self._us_listing is not None
                    and time.monotonic() - self._us_ts < _LISTING_TTL_SEC)

        def backing_off() -> bool:
            return time.monotonic() - self._us_fail_ts < _LISTING_RETRY_SEC

        if fresh() or backing_off():
            return self._us_listing
        async with self._us_lock:
            if fresh() or backing_off():  # 락 대기 중 갱신/실패됐을 수 있음
                return self._us_listing
            try:
                raw = await asyncio.wait_for(
                    asyncio.get_running_loop().run_in_executor(
                        self._fetch_pool, _load_us_listing_sync),
                    timeout=_LISTING_TIMEOUT_SEC,
                )
                sym = _pick_col(raw, "symbol", "code", "ticker")
                name = _pick_col(raw, "name")
                sector = _pick_col(raw, "sector", "industry")
                if not sym or not name:
                    raise ValueError(f"S&P500 목록 컬럼 불명: {list(raw.columns)}")
                out = []
                for _, r in raw.iterrows():
                    ticker = str(r[sym]).strip()
                    if not ticker:
                        continue
                    ticker = self._US_TICKER_FIX.get(ticker, ticker)
                    out.append((ticker, str(r[name]).strip(),
                                str(r[sector]).strip() if sector else ""))
            except Exception:
                self._us_fail_ts = time.monotonic()
                return self._us_listing
            if not out:
                # 컬럼은 있으나 행 0개인 응답을 12시간 '정상'으로 캐시하면 미국
                # 유니버스가 통째로 비어(폴백조차 못 타고) 버린다 — 실패로 취급
                self._us_fail_ts = time.monotonic()
                return self._us_listing
            self._us_listing = out
            self._us_ts = time.monotonic()
            return out

    async def aclose(self) -> None:
        # 대기 중인 페치는 버리고 즉시 종료 — 행 스레드가 셧다운을 붙잡지 않게
        self._fetch_pool.shutdown(wait=False, cancel_futures=True)
        close_stooq_client()  # 공유 커넥션 풀 정리


def _load_listing_sync() -> pd.DataFrame:
    import FinanceDataReader as fdr
    return fdr.StockListing("KRX")


def _load_us_listing_sync() -> pd.DataFrame:
    import FinanceDataReader as fdr
    return fdr.StockListing("S&P500")
