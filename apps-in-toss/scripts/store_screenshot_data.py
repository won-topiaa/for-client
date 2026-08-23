"""스토어 스크린샷용 데이터 추출 — 앱이 쓰는 것과 '같은 엔진'의 실제 출력을 뽑는다.

손으로 적은 숫자는 반드시 앱과 어긋난다. 스크린샷에 들어가는 모든 수치는
이 스크립트가 뽑은 JSON(data.json)에서 나와야 한다.

사용 (저장소 루트에서):
    python apps-in-toss/scripts/store_screenshot_data.py
    node apps-in-toss/scripts/make_store_screenshots.mjs

공급자는 서버와 같은 규칙(MA_PROVIDER 환경변수)을 따른다. 개발 컨테이너처럼
외부 시세가 막힌 곳에서는 sample(합성 데이터)로 떨어지므로, **스토어 제출용은
실데이터가 되도록 본인 컴퓨터에서 재실행**할 것 (기본 auto = 무료 실시세).
data.json 의 "provider" 필드가 "sample" 이면 제출용이 아니다.
"""
from __future__ import annotations

import asyncio
import datetime
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from app.analysis import analyze_timeframe, sma  # noqa: E402
from app.config import load_settings  # noqa: E402
from app.pattern_scan import FETCH_BARS  # noqa: E402
from app.providers.base import SymbolInfo  # noqa: E402
from app.server import build_provider  # noqa: E402
from app.service import analyze_symbol  # noqa: E402
from app.touch_scan import (  # noqa: E402
    CHART_BARS,
    TOUCH_MIN_SUCCESS,
    TOUCH_MIN_SUPPORT_BOUNCES,
    WINDOW_BARS,
    TouchScanner,
    _support_success_rate,
)

# 레이더 화면 스크린샷의 분석 대상 (앱 QUICK_PICKS 첫 항목과 동일)
RADAR = SymbolInfo("005930", "삼성전자", "KOSPI")

# 스크리너 카드 후보 — 유동성 상위 대표 종목 (이 중 조건을 통과한 종목만 실린다)
SCREENER_POOL = [
    SymbolInfo("005930", "삼성전자", "KOSPI"),
    SymbolInfo("000660", "SK하이닉스", "KOSPI"),
    SymbolInfo("373220", "LG에너지솔루션", "KOSPI"),
    SymbolInfo("005380", "현대차", "KOSPI"),
    SymbolInfo("035420", "NAVER", "KOSPI"),
    SymbolInfo("035720", "카카오", "KOSPI"),
    SymbolInfo("005490", "POSCO홀딩스", "KOSPI"),
    SymbolInfo("051910", "LG화학", "KOSPI"),
    SymbolInfo("105560", "KB금융", "KOSPI"),
    SymbolInfo("068270", "셀트리온", "KOSPI"),
]

OUT = Path(__file__).parent / "store" / "data.json"


def _fallback_card(scanner: TouchScanner, info: SymbolInfo, df) -> dict | None:
    """오늘 터치가 없는 날의 대체 카드 — '오늘 터치' 조건만 뺀, 같은 엔진 수치.

    스크리너 화면의 데모용이며 todayTouch=False 로 표시된다. 카드에 실리는
    성공률·지지 성공·터치 횟수·선 값은 전부 실제 백테스트 출력이다."""
    import numpy as np

    close = df["close"].to_numpy(float)
    n = len(df)
    window_start = max(0, n - WINDOW_BARS)
    report = analyze_timeframe(df, scanner.candidates, scanner.params, "day", window_start)
    best = None
    for s in report.recommended:
        if not s.qualified or s.support_bounces < TOUCH_MIN_SUPPORT_BOUNCES:
            continue
        support_success = _support_success_rate(s)
        if support_success < TOUCH_MIN_SUCCESS:
            continue
        ma_full = sma(close, s.period)
        ma_now = float(ma_full[-1])
        if not np.isfinite(ma_now):
            continue
        cand = {
            "symbol": info.symbol, "name": info.name, "market": info.market,
            "period": s.period,
            "successRate": round(support_success, 4),
            "touches": s.touches,
            "supportBounces": s.support_bounces,
            "maScore": round(s.score, 4),
            "distPct": round((close[-1] / ma_now - 1) * 100, 2),
            "maValue": round(ma_now, 2),
            "close": round(float(close[-1]), 2),
        }
        if best is None or cand["maScore"] > best["maScore"]:
            best = cand
    if best is None:
        return None
    tail = df.tail(CHART_BARS).reset_index(drop=True)
    dates = tail["date"].dt.strftime("%Y-%m-%d")
    offset = n - len(tail)
    ma_full = sma(close, best["period"])
    best["candles"] = [
        {"time": dates.iloc[i], "open": float(tail["open"].iloc[i]),
         "high": float(tail["high"].iloc[i]), "low": float(tail["low"].iloc[i]),
         "close": float(tail["close"].iloc[i])}
        for i in range(len(tail))
    ]
    import numpy as np
    best["maLine"] = [
        {"time": dates.iloc[i], "value": round(float(ma_full[offset + i]), 2)}
        for i in range(len(tail)) if np.isfinite(ma_full[offset + i])
    ]
    best["todayTouch"] = False
    return best


async def main() -> None:
    settings = load_settings()
    provider = build_provider(settings)
    print(f"공급자: {provider.name}")

    # 1) 레이더 화면: /api/analyze 와 동일한 JSON
    radar = await analyze_symbol(provider, settings, RADAR.symbol,
                                 dict(settings.lookback_years))
    radar["name"] = RADAR.name
    radar["market"] = RADAR.market

    # 2) 스크리너 카드: 실제 터치 스캐너 판정을 종목별로 실행
    scanner = TouchScanner(provider, universe_fn=None,
                           candidates=settings.candidates["day"],
                           min_touches=settings.min_touches["day"])
    matches: list[dict] = []
    fallbacks: list[dict] = []
    for info in SCREENER_POOL:
        try:
            df = await provider.candles(info.symbol, "day", FETCH_BARS)
        except Exception as exc:  # noqa: BLE001 — 한 종목 실패는 건너뛴다
            print(f"  {info.symbol} 시세 실패: {exc}")
            continue
        m = scanner._analyze_sync(info, df)
        if m is not None:
            m["todayTouch"] = True
            matches.append(m)
        elif len(fallbacks) < 4:
            fb = _fallback_card(scanner, info, df)
            if fb is not None:
                fallbacks.append(fb)
    genuine = bool(matches)
    if len(matches) < 2:
        matches += fallbacks[: max(0, 3 - len(matches))]
    matches.sort(key=lambda m: -m["maScore"])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "generatedAt": datetime.date.today().isoformat(),
        "provider": provider.name,
        "radar": radar,
        "screener": {"market": "kr", "genuineTouch": genuine, "matches": matches[:3]},
    }, ensure_ascii=False), encoding="utf-8")
    print(f"OK: {OUT} (레이더 1종목, 스크리너 카드 {min(3, len(matches))}개, "
          f"실제 터치 {'있음' if genuine else '없음 — 대체 카드 사용'})")
    if provider.name == "sample":
        print("주의: sample(합성) 데이터입니다 — 스토어 제출 전 실데이터 환경에서 재실행하세요.")


if __name__ == "__main__":
    asyncio.run(main())
