"""토스증권 Open API 클라이언트.

이 환경에서는 공식 문서(developers.tossinvest.com)의 세부 스키마를 검증할 수
없어서, 확인된 사실(베이스 URL, OAuth2 client-credentials 토큰, /candles 계열
OHLCV 엔드포인트, Bearer 인증)만 하드코딩하고 나머지 경로/파라미터명은 전부
config.json 으로 조정 가능하게 했다. 응답 파싱도 필드명 별칭 기반의
관용(normalizer) 방식이라 스키마가 예상과 조금 달라도 동작한다.

실제 키를 넣고 처음 실행할 때 404/400 이 나면 README 의 "토스 API 경로 맞추기"
절차대로 openapi.json 을 확인해 config.json 만 고치면 된다.
"""
from __future__ import annotations

import time
from typing import Any

import httpx
import pandas as pd

from ..config import TossConfig
from .base import SymbolInfo, validate_candles

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


def normalize_candles(payload: Any) -> pd.DataFrame:
    """토스 응답 JSON -> 표준 OHLCV DataFrame."""
    rows = _find_candle_list(payload)
    if not rows:
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


class TossProvider:
    name = "toss"

    def __init__(self, cfg: TossConfig):
        self.cfg = cfg
        self._token: str | None = None
        self._token_expiry: float = 0.0
        self._client = httpx.AsyncClient(
            base_url=cfg.base_url, timeout=cfg.timeout_sec
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _ensure_token(self) -> str:
        if self._token and time.monotonic() < self._token_expiry - 60:
            return self._token
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

    async def _get(self, path: str, params: dict) -> Any:
        token = await self._ensure_token()
        resp = await self._client.get(
            path, params=params, headers={"Authorization": f"Bearer {token}"}
        )
        if resp.status_code == 401:
            # 토큰 만료 등 -> 1회 재발급 후 재시도
            self._token = None
            token = await self._ensure_token()
            resp = await self._client.get(
                path, params=params, headers={"Authorization": f"Bearer {token}"}
            )
        if resp.status_code != 200:
            raise TossApiError(
                f"API 호출 실패 {path} ({resp.status_code}): {resp.text[:300]}"
            )
        return resp.json()

    async def search(self, query: str) -> list[SymbolInfo]:
        payload = await self._get(
            self.cfg.search_path, {self.cfg.search_query_param: query}
        )
        rows = _find_symbol_list(payload)
        results = []
        for row in rows or []:
            symbol = _pick(row, _SYMBOL_ALIASES)
            name = _pick(row, _NAME_ALIASES)
            if not symbol:
                continue
            results.append(SymbolInfo(
                symbol=str(symbol),
                name=str(name or symbol),
                market=str(_pick(row, _MARKET_ALIASES) or ""),
            ))
        return results[:20]

    async def candles(self, symbol: str, timeframe: str, max_bars: int) -> pd.DataFrame:
        cfg = self.cfg
        interval = cfg.interval_values.get(timeframe, timeframe)
        merged: pd.DataFrame | None = None
        to_value: str | None = None
        prev_oldest: pd.Timestamp | None = None
        # 한 번에 max_count_per_request 씩, to 파라미터로 과거로 페이지네이션
        for _ in range(40):  # 안전 상한
            remaining = max_bars - (0 if merged is None else len(merged))
            params: dict[str, Any] = {
                cfg.candles_symbol_param: symbol,
                cfg.candles_interval_param: interval,
                cfg.candles_count_param: min(remaining, cfg.max_count_per_request),
            }
            if to_value and cfg.candles_to_param:
                params[cfg.candles_to_param] = to_value
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
            if len(merged) >= max_bars or not cfg.candles_to_param:
                break
            oldest = merged["date"].min()
            if prev_oldest is not None and oldest >= prev_oldest:
                break  # 과거로 진전 없음
            prev_oldest = oldest
            # to 는 가장 오래된 캔들 날짜 그대로 사용: exclusive 세만틱스면
            # 그 전 거래일부터, inclusive 면 중복 1개가 오지만 위에서 dedup 됨.
            # (oldest - 1일 방식은 exclusive API 에서 거래일 누락을 만든다)
            to_value = oldest.strftime(cfg.to_date_format)
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
