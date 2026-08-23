"""해외(미국) 주요 종목 이름사전 — 한글/영문 이름으로 티커를 찾게 한다.

토스/무료 시세 소스에는 '미국 종목을 한글 이름으로 검색'하는 길이 없다. 그래서
data/us_stocks.csv (컬럼: ticker,exchange,name_ko,name_en,aliases) 를 내장 사전으로
두고, 이름·별칭·티커로 매칭해 티커를 찾아 준다. 여기 없는 종목은 티커를 직접
입력하면 시세 조회가 그대로 동작한다(사전은 '이름→티커' 편의 기능일 뿐이다).

- '#' 로 시작하는 줄과 빈 줄은 무시한다.
- CSV 는 mtime 이 바뀌면 자동 재로딩한다(서버 재시작 없이 목록 갱신 가능).
"""
from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

from .base import SymbolInfo

_CSV_PATH = Path(__file__).resolve().parent.parent / "data" / "us_stocks.csv"
_EXPECTED_HEADER = ("ticker", "exchange", "name_ko", "name_en", "aliases")


@dataclass(frozen=True)
class _Entry:
    ticker: str
    exchange: str
    name: str  # 화면 표기용 (한글 우선, 없으면 영문, 없으면 티커)
    terms: tuple[str, ...]  # 소문자 검색 키(티커/한글/영문/별칭)


_cache: tuple[float, list[_Entry]] | None = None


def _parse_rows(rows: list[list[str]]) -> list[_Entry]:
    entries: list[_Entry] = []
    seen: set[str] = set()
    for row in rows:
        if not row:
            continue
        first = row[0].strip()
        if not first or first.startswith("#"):
            continue
        # 헤더 줄은 건너뛴다
        if tuple(c.strip().lower() for c in row[:5]) == _EXPECTED_HEADER:
            continue
        ticker = first.upper()
        if not ticker or ticker in seen:
            continue  # 중복 티커는 첫 항목만
        exchange = row[1].strip() if len(row) > 1 else ""
        name_ko = row[2].strip() if len(row) > 2 else ""
        name_en = row[3].strip() if len(row) > 3 else ""
        aliases = row[4].strip() if len(row) > 4 else ""
        display = name_ko or name_en or ticker
        terms = {ticker.lower()}
        for part in (name_ko, name_en):
            if part:
                terms.add(part.lower())
        for alias in aliases.split("|"):
            alias = alias.strip().lower()
            if alias:
                terms.add(alias)
        seen.add(ticker)
        entries.append(_Entry(ticker, exchange, display, tuple(terms)))
    return entries


def _load() -> list[_Entry]:
    try:
        with _CSV_PATH.open(encoding="utf-8") as fh:
            return _parse_rows(list(csv.reader(fh)))
    except FileNotFoundError:
        return []
    except Exception:  # noqa: BLE001 — 사전이 깨져도 검색 전체를 죽이지 않는다
        return []


def _entries() -> list[_Entry]:
    global _cache
    try:
        mtime = _CSV_PATH.stat().st_mtime
    except OSError:
        return _cache[1] if _cache else []
    if _cache is None or _cache[0] != mtime:
        _cache = (mtime, _load())
    return _cache[1]


def is_known_ticker(symbol: str) -> bool:
    """CSV 사전에 있는 티커인지 (검색의 중복/오탐 정리에 쓴다)."""
    s = symbol.strip().lower()
    return any(e.ticker.lower() == s for e in _entries())


def search_us(query: str, limit: int = 20) -> list[SymbolInfo]:
    """한글/영문 이름·별칭·티커로 미국 종목을 찾는다. 관련도 순으로 정렬.

    순위: 티커 완전일치 > 이름/별칭 완전일치 > 접두 일치 > 부분 포함.
    """
    q = query.strip().lower()
    if not q:
        return []
    scored: list[tuple[int, int, _Entry]] = []
    for idx, e in enumerate(_entries()):
        best = 99
        for term in e.terms:
            if term == q:
                best = min(best, 0 if term == e.ticker.lower() else 1)
            elif term.startswith(q):
                best = min(best, 2)
            elif q in term:
                best = min(best, 3)
        if best < 99:
            scored.append((best, idx, e))  # idx: 동점이면 CSV 등재 순서 유지
    scored.sort(key=lambda t: (t[0], t[1]))
    return [SymbolInfo(e.ticker, e.name, e.exchange) for _, _, e in scored[:limit]]
