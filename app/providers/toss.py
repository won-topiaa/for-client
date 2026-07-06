"""토스증권 Open API 클라이언트 (공식 openapi.json v1.1.5 기준).

확인된 스펙:
- POST /oauth2/token (form, client_credentials) -> access_token / expires_in
- GET  /api/v1/candles?symbol=&interval=1d&count<=200&before=<ISO8601, exclusive>
  응답: {result: {candles: [{timestamp, openPrice, ..., volume}], nextBefore}}
  interval 은 '1m'/'1d' 만 지원 -> 주봉/월봉은 일봉 리샘플링으로 폴백.
- GET  /api/v1/stocks?symbols=005930,AAPL (코드 전용, 이름 검색 API 없음)
  -> 이름 검색은 내장 사전(kr_symbols)으로 코드 후보를 찾고 이 API 로 확정.

응답 파싱은 필드명 별칭 기반의 관용(normalizer) 방식이라 스키마가 조금
바뀌어도 동작하고, 경로/파라미터명은 config.json 으로 재정의할 수 있다.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from pathlib import Path
from typing import Any

import httpx
import pandas as pd

logger = logging.getLogger("ma-analyzer")

from ..config import TossConfig
from .base import SymbolInfo, validate_candles
from .kr_symbols import SymbolDictionary

# 응답 JSON 에서 캔들 리스트를 찾을 때 시도하는 키 (중첩 지원)
_LIST_KEYS = ("result", "data", "candles", "body", "output", "items", "list", "prices")

# OHLCV 필드명 별칭
_FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "date": ("date", "dt", "time", "datetime", "dateTime", "baseDate", "base_date",
             "tradeDate", "trade_date", "localDate", "timestamp", "candleTime"),
    "open": ("open", "openPrice", "open_price", "o", "openingPrice"),
    "high": ("high", "highPrice", "high_price", "h", "maxPrice"),
    "low": ("low", "lowPrice", "low_price", "l", "minPrice"),
    "close": ("close", "closePrice", "close_price", "c", "price", "tradePrice",
              "currentPrice", "closingPrice"),
    "volume": ("volume", "vol", "v", "tradingVolume", "trading_volume",
               "accVolume", "candleAccTradeVolume"),
}

_SYMBOL_ALIASES = ("symbol", "code", "productCode", "product_code", "ticker",
                   "isin", "shortCode", "stockCode")
_NAME_ALIASES = ("name", "productName", "product_name", "companyName",
                 "company_name", "koreanName", "stockName", "displayName")
_MARKET_ALIASES = ("market", "marketCode", "exchange", "marketType")


class TossApiError(RuntimeError):
    pass


def _find_candle_list(payload: Any) -> list[dict] | None:
    """응답 어디에 캔들 배열이 있든 재귀적으로 찾는다."""
    if isinstance(payload, list):
        if payload and isinstance(payload[0], dict):
            keys = {k.lower() for k in payload[0]}
            if any(a.lower() in keys for a in _FIELD_ALIASES["close"]):
                return payload
        return None
    if isinstance(payload, dict):
        for key in _LIST_KEYS:
            if key in payload:
                found = _find_candle_list(payload[key])
                if found is not None:
                    return found
        # 알려진 키에 없으면 모든 값을 훑는다
        for val in payload.values():
            found = _find_candle_list(val)
            if found is not None:
                return found
    return None


def _pick(row: dict, aliases: tuple[str, ...]) -> Any:
    lower = {k.lower(): v for k, v in row.items()}
    for a in aliases:
        if a.lower() in lower:
            return lower[a.lower()]
    return None


def _parse_date(val: Any) -> pd.Timestamp | None:
    if val is None:
        return None
    if isinstance(val, (int, float)):
        if isinstance(val, float) and not val.is_integer():
            return None
        iv = int(val)
        # epoch 초(1990~2100년: ~6.3e8..4.1e9)와 밀리초(~6.3e11..4.1e12)는
        # 크기 범위가 겹치지 않는다. 1e11 을 경계로 두면 두 범위 모두 안전.
        if iv >= 1e11:
            return pd.Timestamp(iv, unit="ms")
        if iv >= 1e8:
            return pd.Timestamp(iv, unit="s")
        # 그 외 정수는 YYYYMMDD 형태일 수 있으므로 문자열 경로로
        val = str(iv)
    s = str(val).strip()
    if len(s) == 8 and s.isdigit():  # YYYYMMDD
        s = f"{s[:4]}-{s[4:6]}-{s[6:]}"
    try:
        return pd.Timestamp(s)
    except ValueError:
        return None


class EmptyCandles(TossApiError):
    """캔들 배열은 있으나 비어 있음 (히스토리 끝 또는 잘못된 종목코드)."""


def normalize_candles(payload: Any) -> pd.DataFrame:
    """토스 응답 JSON -> 표준 OHLCV DataFrame."""
    rows = _find_candle_list(payload)
    if not rows:
        # 구조는 맞는데 candles 가 빈 배열인 정상 응답과, 아예 구조가 다른
        # 응답(설정 문제)을 구분해 사용자에게 올바른 메시지를 준다.
        explicit = _find_key(payload, "candles", _MISSING)
        if isinstance(explicit, list) and not explicit:
            raise EmptyCandles(
                "캔들 데이터가 비어 있습니다 — 종목코드가 맞는지 확인해 주세요."
            )
        raise TossApiError(
            "응답에서 캔들 배열을 찾지 못했습니다. config.json 의 candles_path 와 "
            "파라미터명을 공식 openapi.json 과 대조해 주세요."
        )
    records = []
    for row in rows:
        date = _parse_date(_pick(row, _FIELD_ALIASES["date"]))
        if date is None:
            continue
        records.append({
            "date": date,
            "open": _pick(row, _FIELD_ALIASES["open"]),
            "high": _pick(row, _FIELD_ALIASES["high"]),
            "low": _pick(row, _FIELD_ALIASES["low"]),
            "close": _pick(row, _FIELD_ALIASES["close"]),
            "volume": _pick(row, _FIELD_ALIASES["volume"]) or 0,
        })
    if not records:
        raise TossApiError("캔들 배열은 찾았지만 날짜/가격 필드를 해석하지 못했습니다.")
    return validate_candles(pd.DataFrame(records))


# 종목코드/티커로 볼 수 있는 입력 (KRX 6자리 숫자, 미국 티커 등)
_SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-]{1,12}$")


def _find_key(payload: Any, key: str, _missing=object()) -> Any:
    """중첩 JSON 어디에 있든 key 의 값을 찾는다. 없으면 sentinel."""
    if isinstance(payload, dict):
        if key in payload:
            return payload[key]
        for val in payload.values():
            found = _find_key(val, key, _missing)
            if found is not _missing:
                return found
    elif isinstance(payload, list):
        for item in payload:
            found = _find_key(item, key, _missing)
            if found is not _missing:
                return found
    return _missing


_MISSING = object()


class TossProvider:
    name = "toss"

    def __init__(self, cfg: TossConfig, data_dir: Path | None = None):
        self.cfg = cfg
        self._token: str | None = None
        self._token_expiry: float = 0.0
        # 동시 요청이 토큰을 중복 발급하지 않도록 (콜드 스타트/만료 시점 보호)
        self._token_lock = asyncio.Lock()
        self._symbols = SymbolDictionary(data_dir)
        self._client = httpx.AsyncClient(
            base_url=cfg.base_url, timeout=cfg.timeout_sec
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def _token_valid(self) -> bool:
        return bool(self._token) and time.monotonic() < self._token_expiry - 60

    async def _ensure_token(self) -> str:
        if self._token_valid():
            return self._token  # type: ignore[return-value]
        async with self._token_lock:
            # 락을 기다리는 동안 다른 코루틴이 발급했을 수 있음 (double-check)
            if self._token_valid():
                return self._token  # type: ignore[return-value]
            return await self._issue_token()

    async def _issue_token(self) -> str:
        data = {"grant_type": "client_credentials"}
        auth = None
        if self.cfg.auth_style == "basic":
            auth = (self.cfg.client_id, self.cfg.client_secret)
        else:
            data.update({
                "client_id": self.cfg.client_id,
                "client_secret": self.cfg.client_secret,
            })
        resp = await self._client.post(self.cfg.token_path, data=data, auth=auth)
        for attempt in range(4):  # 토큰 발급도 429 면 잠깐 기다렸다 재시도
            if resp.status_code != 429:
                break
            await asyncio.sleep(self._retry_delay(resp, attempt))
            resp = await self._client.post(self.cfg.token_path, data=data, auth=auth)
        if resp.status_code != 200:
            raise TossApiError(
                f"토큰 발급 실패 ({resp.status_code}): {resp.text[:300]}"
            )
        body = resp.json()
        token = body.get("access_token") or body.get("accessToken")
        if not token:
            raise TossApiError(f"토큰 응답에 access_token 이 없습니다: {body}")
        self._token = token
        expires_in = float(body.get("expires_in") or body.get("expiresIn") or 3600)
        self._token_expiry = time.monotonic() + expires_in
        return token

    @staticmethod
    def _retry_delay(resp: httpx.Response, attempt: int) -> float:
        """429 재시도 대기 시간. Retry-After 헤더 우선, 없으면 지수 백오프."""
        ra = resp.headers.get("Retry-After")
        if ra:
            try:
                return min(float(ra), 30.0)
            except ValueError:
                pass
        return min(1.0 * (2 ** attempt), 16.0)

    # _get 한 번이 재시도 대기에 쓸 수 있는 누적 시간 상한(초).
    # 호스팅 게이트웨이 타임아웃(~100초)보다 훨씬 짧아야 사용자가 에러라도 받는다.
    MAX_RETRY_WAIT_SEC = 40.0

    async def _get(self, path: str, params: dict) -> Any:
        token = await self._ensure_token()
        resp: httpx.Response | None = None
        refreshed = False
        waited = 0.0
        # 최대 6회: 401(토큰 만료) 재발급 1회, 429(요청 한도) 백오프 재시도
        for attempt in range(6):
            resp = await self._client.get(
                path, params=params, headers={"Authorization": f"Bearer {token}"}
            )
            if resp.status_code == 401:
                if refreshed:
                    break  # 재발급으로 해결 안 되는 401(권한 등) — 즉시 실패
                refreshed = True
                # 다른 코루틴이 이미 새 토큰을 발급했다면 그것을 쓰고,
                # 아니면(내가 쓰던 토큰이 아직 공유 상태면) 무효화 후 재발급
                if self._token == token:
                    self._token = None
                token = await self._ensure_token()
                continue
            if resp.status_code == 429:
                if attempt == 5:
                    break  # 마지막 시도 실패 후에는 기다릴 이유가 없음
                delay = self._retry_delay(resp, attempt)
                if waited + delay > self.MAX_RETRY_WAIT_SEC:
                    break  # 누적 대기 상한 초과 — 빨리 실패해서 사용자에게 알림
                waited += delay
                await asyncio.sleep(delay)
                continue
            break
        assert resp is not None
        if resp.status_code != 200:
            raise TossApiError(
                f"API 호출 실패 {path} ({resp.status_code}): {resp.text[:300]}"
            )
        return resp.json()

    async def search(self, query: str) -> list[SymbolInfo]:
        """이름/코드 검색.

        공식 API 에 이름 검색이 없으므로: (1) 입력이 코드/티커 형태면 그대로,
        (2) 이름이면 내장 사전 + data/symbols.csv 에서 코드 후보를 찾은 뒤,
        /api/v1/stocks 로 실제 종목명·시장을 확정해 반환한다.
        """
        q = query.strip()
        if not q:
            return []
        candidates: list[str] = []
        if _SYMBOL_RE.match(q):
            candidates.append(q if q.isdigit() else q.upper())
        local = self._symbols.match_names(q)
        for sym, _name, _market in local:
            if sym not in candidates:
                candidates.append(sym)
        if not candidates:
            return []
        candidates = candidates[:30]

        try:
            payload = await self._get(
                self.cfg.stocks_path,
                {self.cfg.stocks_symbols_param: ",".join(candidates)},
            )
            rows = _find_symbol_list(payload) or []
        except TossApiError:
            # 배치 거부/한도 초과 등 -> 사전 정보로 응답하되,
            # 사용자가 직접 입력한 코드/티커는 잃지 않고 맨 앞에 유지한다
            fallback: list[SymbolInfo] = []
            if _SYMBOL_RE.match(q):
                code = q if q.isdigit() else q.upper()
                fallback.append(SymbolInfo(code, code, ""))
            fallback += [
                SymbolInfo(s, n, m) for s, n, m in local
                if not fallback or s != fallback[0].symbol
            ]
            return fallback[:20]

        by_symbol: dict[str, SymbolInfo] = {}
        for row in rows:
            symbol = _pick(row, _SYMBOL_ALIASES)
            if not symbol:
                continue
            status = row.get("status")
            if status and str(status).upper() == "DELISTED":
                continue
            name = _pick(row, _NAME_ALIASES)
            by_symbol[str(symbol)] = SymbolInfo(
                symbol=str(symbol),
                name=str(name or symbol),
                market=str(_pick(row, _MARKET_ALIASES) or ""),
            )
        # 후보 순서 유지 (직접 입력한 코드 -> 사전 일치 순)
        results = [by_symbol[c] for c in candidates if c in by_symbol]
        return results[:20]

    async def candles(self, symbol: str, timeframe: str, max_bars: int) -> pd.DataFrame:
        cfg = self.cfg
        interval = cfg.interval_values.get(timeframe)
        if interval is None:
            # 공식 API 는 '1m'/'1d' 만 지원 -> 주/월봉은 service 층에서
            # 일봉 리샘플링으로 폴백된다.
            raise TossApiError(
                f"토스 API 가 {timeframe} 봉을 직접 지원하지 않습니다 (일봉 리샘플링 사용)."
            )
        merged: pd.DataFrame | None = None
        before: str | None = None
        deadline = time.monotonic() + 75.0  # 전체 페이지네이션 시간 예산
        # 한 번에 max_count_per_request 씩, before(exclusive)로 과거 페이지네이션.
        # 다음 페이지 커서는 응답의 nextBefore 를 그대로 사용 (공식 스펙).
        for _ in range(80):  # 안전 상한
            if merged is not None and time.monotonic() > deadline:
                logger.warning(
                    "%s 캔들 페이지네이션 시간 예산 초과 — %d봉까지만 사용합니다.",
                    symbol, len(merged),
                )
                break
            remaining = max_bars - (0 if merged is None else len(merged))
            params: dict[str, Any] = {
                cfg.candles_symbol_param: symbol,
                cfg.candles_interval_param: interval,
                cfg.candles_count_param: min(remaining, cfg.max_count_per_request),
            }
            if before and cfg.candles_before_param:
                params[cfg.candles_before_param] = before
            payload = await self._get(cfg.candles_path, params)
            try:
                df = normalize_candles(payload)
            except TossApiError:
                if merged is not None:
                    break  # 히스토리 소진 (빈 페이지) — 지금까지 모은 것 사용
                raise
            new_merged = validate_candles(
                df if merged is None else pd.concat([merged, df], ignore_index=True)
            )
            if merged is not None and len(new_merged) <= len(merged):
                break  # 새 캔들이 없음 — 데이터 끝
            merged = new_merged
            if len(merged) >= max_bars or not cfg.candles_before_param:
                break
            next_before = _find_key(payload, "nextBefore", _MISSING)
            if next_before is _MISSING:
                # 응답에 커서가 없으면 가장 오래된 봉 시각을 exclusive 커서로 사용
                oldest = df["date"].min()
                fallback = oldest.isoformat()
                if fallback == before:
                    break
                before = fallback
            elif next_before:
                before = str(next_before)
            else:
                break  # nextBefore == null -> 마지막 페이지
            # 페이지 사이 짧은 간격 — 요청 한도(rate limit)에 몰리는 것 방지
            await asyncio.sleep(0.06)
        if merged is None or merged.empty:
            raise TossApiError(f"{symbol} 캔들 데이터를 받지 못했습니다.")
        return merged.tail(max_bars).reset_index(drop=True)


def _find_symbol_list(payload: Any) -> list[dict] | None:
    if isinstance(payload, list):
        if payload and isinstance(payload[0], dict):
            keys = {k.lower() for k in payload[0]}
            if any(a.lower() in keys for a in _SYMBOL_ALIASES):
                return payload
        return None
    if isinstance(payload, dict):
        for val in payload.values():
            found = _find_symbol_list(val)
            if found is not None:
                return found
    return None
