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
import re
import time
from pathlib import Path
from typing import Any

import pandas as pd

from .base import SymbolInfo, validate_candles

# 종목코드(6자리 숫자)/미국 티커
_SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-]{1,12}$")
_LISTING_TTL_SEC = 12 * 3600  # 상장 목록은 거의 안 바뀜


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
    """fdr.StockListing('KRX') -> symbol/name/market 표준 목록."""
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
    # 유효 코드만: 순수 숫자(1~6자리) 또는 2024.1 개편 이후의 영문 포함
    # 신형 코드(예: 00088K 한화3우B, 0126Z0). 빈 값이 zfill 로 000000 이
    # 되는 것은 여전히 걸러진다.
    valid = (
        codes.str.match(r"^\d{1,6}$")
        | codes.str.match(r"^\d{4}[0-9A-HJ-NP-TV-Z][0-9KLMN]$")
    )
    return out[valid].reset_index(drop=True)


def _fetch_fdr_sync(symbol: str) -> pd.DataFrame:
    import FinanceDataReader as fdr
    # 전체 히스토리 (service 가 필요한 만큼 tail). start 지정으로 장기 데이터 확보.
    return fdr.DataReader(symbol, "1990-01-01")


def _fetch_yahoo_sync(symbol: str, market: str = "") -> pd.DataFrame:
    import yfinance as yf

    candidates: list[str] = []
    if symbol.isdigit():  # 국내 종목: 시장에 따라 접미사
        if market.upper().startswith("KOSDAQ"):
            candidates = [f"{symbol}.KQ", f"{symbol}.KS"]
        else:
            candidates = [f"{symbol}.KS", f"{symbol}.KQ"]
    else:
        candidates = [symbol]  # 미국 티커 등
    for tkr in candidates:
        try:
            hist = yf.Ticker(tkr).history(period="max", interval="1d", auto_adjust=False)
        except Exception:
            hist = None
        if hist is not None and len(hist) > 0:
            return hist
    raise ValueError(f"{symbol} Yahoo 조회 실패")


_LISTING_TIMEOUT_SEC = 15.0   # 상장목록 다운로드 시간 상한
_LISTING_RETRY_SEC = 60.0     # 실패 후 재시도 억제 (실패 폭주 방지)
_CANDLES_TIMEOUT_SEC = 60.0   # 종목별 시세 조회 시간 상한


class FreeDataProvider:
    name = "free"

    def __init__(self, data_dir: Path | None = None):
        self._listing: pd.DataFrame | None = None
        self._listing_ts = 0.0
        self._listing_fail_ts = -1e9
        self._listing_lock = asyncio.Lock()
        self._market_by_symbol: dict[str, str] = {}

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
                    asyncio.to_thread(_load_listing_sync),
                    timeout=_LISTING_TIMEOUT_SEC,
                )
                listing = normalize_listing(raw)
            except Exception:
                self._listing_fail_ts = time.monotonic()
                return self._listing  # 실패 시 기존(있으면) 유지, 없으면 None
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
            df = await asyncio.wait_for(
                asyncio.to_thread(self._fetch_daily_sync, symbol),
                timeout=_CANDLES_TIMEOUT_SEC,
            )
        except (asyncio.TimeoutError, TimeoutError) as exc:
            raise RuntimeError(
                f"{symbol} 시세 조회가 {int(_CANDLES_TIMEOUT_SEC)}초를 초과했습니다 "
                "(데이터 소스 응답 지연 — 잠시 후 다시 시도해 주세요)"
            ) from exc
        return df.tail(max_bars).reset_index(drop=True)

    def _fetch_daily_sync(self, symbol: str) -> pd.DataFrame:
        errors = []
        try:
            raw = _fetch_fdr_sync(symbol)
            if raw is not None and len(raw) > 0:
                return normalize_ohlcv(raw)
            errors.append("FDR: 빈 응답")  # FDR 은 무효 종목이면 예외 없이 빈 df
        except Exception as exc:  # noqa: BLE001
            errors.append(f"FDR: {exc}")
        try:
            market = self._market_by_symbol.get(symbol, "")
            raw = _fetch_yahoo_sync(symbol, market)
            return normalize_ohlcv(raw)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"Yahoo: {exc}")
        raise RuntimeError(
            f"{symbol} 시세를 가져오지 못했습니다 ({' / '.join(errors)})"
        )

    async def aclose(self) -> None:  # 인터페이스 호환
        return None


def _load_listing_sync() -> pd.DataFrame:
    import FinanceDataReader as fdr
    return fdr.StockListing("KRX")
