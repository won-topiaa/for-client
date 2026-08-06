"""국내 주요 종목 이름사전.

토스증권 Open API 에는 '이름으로 검색'하는 엔드포인트가 없다 (/api/v1/stocks 는
종목코드 전용). 그래서 이름 검색은 이 내장 사전 + (선택) data/symbols.csv 로
코드 후보를 찾고, 실제 종목명/시장은 /api/v1/stocks 응답으로 확정한다.

- 내장 사전에 없는 종목은 6자리 코드(또는 미국 티커)를 직접 입력하면 된다.
- 전 종목 검색을 원하면 KRX 정보데이터시스템(data.krx.co.kr)에서 상장종목
  목록을 내려받아 data/symbols.csv (컬럼: symbol,name[,market])로 저장.
"""
from __future__ import annotations

from pathlib import Path

# (코드, 이름, 시장) — 시가총액 상위 및 거래 활발 종목 위주
BUILTIN_KR_SYMBOLS: list[tuple[str, str, str]] = [
    ("005930", "삼성전자", "KOSPI"),
    ("005935", "삼성전자우", "KOSPI"),
    ("000660", "SK하이닉스", "KOSPI"),
    ("373220", "LG에너지솔루션", "KOSPI"),
    ("207940", "삼성바이오로직스", "KOSPI"),
    ("005380", "현대차", "KOSPI"),
    ("000270", "기아", "KOSPI"),
    ("068270", "셀트리온", "KOSPI"),
    ("035420", "NAVER", "KOSPI"),
    ("035720", "카카오", "KOSPI"),
    ("005490", "POSCO홀딩스", "KOSPI"),
    ("051910", "LG화학", "KOSPI"),
    ("006400", "삼성SDI", "KOSPI"),
    ("028260", "삼성물산", "KOSPI"),
    ("012330", "현대모비스", "KOSPI"),
    ("066570", "LG전자", "KOSPI"),
    ("105560", "KB금융", "KOSPI"),
    ("055550", "신한지주", "KOSPI"),
    ("086790", "하나금융지주", "KOSPI"),
    ("316140", "우리금융지주", "KOSPI"),
    ("024110", "기업은행", "KOSPI"),
    ("323410", "카카오뱅크", "KOSPI"),
    ("377300", "카카오페이", "KOSPI"),
    ("015760", "한국전력", "KOSPI"),
    ("096770", "SK이노베이션", "KOSPI"),
    ("034730", "SK", "KOSPI"),
    ("003550", "LG", "KOSPI"),
    ("032830", "삼성생명", "KOSPI"),
    ("000810", "삼성화재", "KOSPI"),
    ("017670", "SK텔레콤", "KOSPI"),
    ("030200", "KT", "KOSPI"),
    ("259960", "크래프톤", "KOSPI"),
    ("036570", "엔씨소프트", "KOSPI"),
    ("251270", "넷마블", "KOSPI"),
    ("352820", "하이브", "KOSPI"),
    ("011200", "HMM", "KOSPI"),
    ("034020", "두산에너빌리티", "KOSPI"),
    ("012450", "한화에어로스페이스", "KOSPI"),
    ("042660", "한화오션", "KOSPI"),
    ("009540", "HD한국조선해양", "KOSPI"),
    ("329180", "HD현대중공업", "KOSPI"),
    ("010140", "삼성중공업", "KOSPI"),
    ("064350", "현대로템", "KOSPI"),
    ("047810", "한국항공우주", "KOSPI"),
    ("003670", "포스코퓨처엠", "KOSPI"),
    ("010130", "고려아연", "KOSPI"),
    ("011170", "롯데케미칼", "KOSPI"),
    ("010950", "S-Oil", "KOSPI"),
    ("033780", "KT&G", "KOSPI"),
    ("097950", "CJ제일제당", "KOSPI"),
    ("090430", "아모레퍼시픽", "KOSPI"),
    ("051900", "LG생활건강", "KOSPI"),
    ("000100", "유한양행", "KOSPI"),
    ("128940", "한미약품", "KOSPI"),
    ("009150", "삼성전기", "KOSPI"),
    ("034220", "LG디스플레이", "KOSPI"),
    ("018260", "삼성에스디에스", "KOSPI"),
    ("042700", "한미반도체", "KOSPI"),
    ("086280", "현대글로비스", "KOSPI"),
    ("003490", "대한항공", "KOSPI"),
    ("006800", "미래에셋증권", "KOSPI"),
    ("005940", "NH투자증권", "KOSPI"),
    ("016360", "삼성증권", "KOSPI"),
    ("071050", "한국금융지주", "KOSPI"),
    ("000720", "현대건설", "KOSPI"),
    ("006360", "GS건설", "KOSPI"),
    ("375500", "DL이앤씨", "KOSPI"),
    ("161390", "한국타이어앤테크놀로지", "KOSPI"),
    ("021240", "코웨이", "KOSPI"),
    ("139480", "이마트", "KOSPI"),
    ("004370", "농심", "KOSPI"),
    # KOSDAQ
    ("247540", "에코프로비엠", "KOSDAQ"),
    ("086520", "에코프로", "KOSDAQ"),
    ("196170", "알테오젠", "KOSDAQ"),
    ("068760", "셀트리온제약", "KOSDAQ"),
    ("028300", "HLB", "KOSDAQ"),
    ("293490", "카카오게임즈", "KOSDAQ"),
    ("263750", "펄어비스", "KOSDAQ"),
    ("112040", "위메이드", "KOSDAQ"),
    ("035900", "JYP Ent.", "KOSDAQ"),
    ("041510", "에스엠", "KOSDAQ"),
    ("122870", "와이지엔터테인먼트", "KOSDAQ"),
    ("058470", "리노공업", "KOSDAQ"),
    ("277810", "레인보우로보틱스", "KOSDAQ"),
    ("403870", "HPSP", "KOSDAQ"),
    ("039030", "이오테크닉스", "KOSDAQ"),
]


class SymbolDictionary:
    """내장 사전 + data/symbols.csv 병합. CSV 는 mtime 변경 시 재로딩."""

    def __init__(self, data_dir: Path | None = None):
        self.data_dir = data_dir
        self._csv_cache: tuple[float, list[tuple[str, str, str]]] | None = None

    def _csv_entries(self) -> list[tuple[str, str, str]]:
        path = (self.data_dir / "symbols.csv") if self.data_dir else None
        if not path or not path.exists():
            return []
        mtime = path.stat().st_mtime
        if self._csv_cache and self._csv_cache[0] == mtime:
            return self._csv_cache[1]
        entries: list[tuple[str, str, str]] = []
        import csv

        with path.open(encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            cols = {c.strip().lower(): c for c in (reader.fieldnames or [])}
            sym_col, name_col = cols.get("symbol"), cols.get("name")
            market_col = cols.get("market")
            if sym_col and name_col:
                for row in reader:
                    sym = (row.get(sym_col) or "").strip()
                    name = (row.get(name_col) or "").strip()
                    if sym and name:
                        market = (row.get(market_col) or "").strip() if market_col else ""
                        entries.append((sym, name, market))
        self._csv_cache = (mtime, entries)
        return entries

    def match_names(self, query: str, limit: int = 20) -> list[tuple[str, str, str]]:
        """이름 부분일치 검색. CSV 항목이 내장 사전보다 우선."""
        q = query.strip().lower()
        if not q:
            return []
        seen: set[str] = set()
        out: list[tuple[str, str, str]] = []
        for sym, name, market in self._csv_entries() + BUILTIN_KR_SYMBOLS:
            if sym in seen:
                continue
            if q in name.lower() or q in sym.lower():
                seen.add(sym)
                out.append((sym, name, market))
                if len(out) >= limit:
                    break
        return out
