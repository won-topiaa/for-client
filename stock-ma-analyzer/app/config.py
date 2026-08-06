"""전역 설정.

우선순위: 환경변수 > config.json > 기본값.
토스증권 Open API의 정확한 경로/파라미터명은 developers.tossinvest.com 의
openapi.json 스펙에 맞춰 config.json 에서 조정할 수 있게 전부 설정으로 뺐다.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 타임프레임별 후보 이동평균선 (국내 관례 5/10/20/60/120/240 + 미국식 50/100/200)
DEFAULT_CANDIDATES: dict[str, list[int]] = {
    "day": [5, 10, 20, 50, 60, 100, 120, 200, 240],
    "week": [5, 10, 20, 30, 52, 60, 104],
    "month": [3, 6, 12, 24, 36, 60],
}

# 백테스트 기본 기간(년). None = 전체 기간
DEFAULT_LOOKBACK_YEARS: dict[str, float | None] = {
    "day": 3.0,
    "week": 7.0,
    "month": None,
}

# 추천 자격을 얻기 위한 최소 터치(에피소드) 수
DEFAULT_MIN_TOUCHES: dict[str, int] = {"day": 5, "week": 4, "month": 3}

TIMEFRAMES = ("day", "week", "month")

# 타임프레임별 대략적 연간 봉 수 (기간(년) -> 봉 수 환산용)
BARS_PER_YEAR = {"day": 248, "week": 52, "month": 12}


@dataclass
class TossConfig:
    """토스증권 Open API 연결 설정 (공식 openapi.json v1.1.5 기준 기본값)."""

    base_url: str = "https://openapi.tossinvest.com"
    token_path: str = "/oauth2/token"
    # "body": client_id/secret 을 form body 로, "basic": HTTP Basic 헤더로
    auth_style: str = "body"
    client_id: str = ""
    client_secret: str = ""

    # GET /api/v1/candles?symbol=&interval=1d&count=&before=
    candles_path: str = "/api/v1/candles"
    candles_symbol_param: str = "symbol"
    candles_interval_param: str = "interval"
    # 토스 API 가 기대하는 interval 값. 공식 API 는 '1m'/'1d' 만 지원하므로
    # week/month 는 매핑에 없음 -> 일봉 리샘플링으로 자동 폴백된다.
    interval_values: dict[str, str] = field(
        default_factory=lambda: {"day": "1d"}
    )
    candles_count_param: str = "count"
    max_count_per_request: int = 200  # 공식 최대 200
    # 과거 페이지네이션 파라미터 (exclusive, ISO 8601). 응답의 nextBefore 를 그대로 전달.
    candles_before_param: str = "before"

    # GET /api/v1/stocks?symbols=005930,AAPL — 종목 기본 정보 (코드 조회 전용,
    # 이름 검색 API 는 공식 스펙에 없음 -> 내장 이름사전 + 이 API 로 검증)
    stocks_path: str = "/api/v1/stocks"
    stocks_symbols_param: str = "symbols"

    timeout_sec: float = 15.0

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_secret)


# 예전 기본값을 그대로 들고 있는 config.json 을 위한 자동 이관.
# (사용자가 직접 바꾼 값은 건드리지 않고, '예전 기본값 그대로'인 경우에만 갱신)
_TOSS_DEFAULT_MIGRATIONS: dict[str, list[tuple[object, object]]] = {
    "candles_path": [("/api/v1/market/candles", "/api/v1/candles")],
    "max_count_per_request": [(300, 200)],
    "interval_values": [
        ({"day": "day", "week": "week", "month": "month"}, {"day": "1d"}),
    ],
}


def _migrate_old_defaults(toss: TossConfig) -> None:
    for attr, pairs in _TOSS_DEFAULT_MIGRATIONS.items():
        current = getattr(toss, attr)
        for old, new in pairs:
            if current == old:
                setattr(toss, attr, new)


@dataclass
class Settings:
    toss: TossConfig = field(default_factory=TossConfig)
    candidates: dict[str, list[int]] = field(
        default_factory=lambda: {k: list(v) for k, v in DEFAULT_CANDIDATES.items()}
    )
    lookback_years: dict[str, float | None] = field(
        default_factory=lambda: dict(DEFAULT_LOOKBACK_YEARS)
    )
    min_touches: dict[str, int] = field(default_factory=lambda: dict(DEFAULT_MIN_TOUCHES))
    provider: str = "auto"  # "auto" | "toss" | "sample"
    data_dir: Path = PROJECT_ROOT / "data"


def _apply_env(toss: TossConfig) -> None:
    env_map = {
        "TOSS_BASE_URL": "base_url",
        "TOSS_TOKEN_PATH": "token_path",
        "TOSS_AUTH_STYLE": "auth_style",
        "TOSS_CLIENT_ID": "client_id",
        "TOSS_CLIENT_SECRET": "client_secret",
        "TOSS_CANDLES_PATH": "candles_path",
        "TOSS_STOCKS_PATH": "stocks_path",
    }
    for env, attr in env_map.items():
        val = os.environ.get(env)
        if val:
            setattr(toss, attr, val)


def load_settings(config_path: Path | None = None) -> Settings:
    settings = Settings()
    path = config_path or PROJECT_ROOT / "config.json"
    if path.exists():
        raw = json.loads(path.read_text(encoding="utf-8"))
        toss_raw = raw.get("toss", {})
        for key, val in toss_raw.items():
            if hasattr(settings.toss, key):
                setattr(settings.toss, key, val)
        if "candidates" in raw:
            for tf, lst in raw["candidates"].items():
                if tf in TIMEFRAMES:
                    if not isinstance(lst, (list, tuple)):
                        raise ValueError(
                            f"config.json: candidates.{tf} 는 숫자 배열이어야 합니다 "
                            f"(현재: {lst!r})"
                        )
                    periods = [int(x) for x in lst]
                    if any(p < 2 for p in periods):
                        raise ValueError(
                            f"config.json: candidates.{tf} 에 2 미만 기간이 있습니다: {periods}"
                        )
                    settings.candidates[tf] = periods
        if "lookback_years" in raw:
            for tf, years in raw["lookback_years"].items():
                if tf in TIMEFRAMES:
                    settings.lookback_years[tf] = None if years in (None, 0, "all") else float(years)
        if "min_touches" in raw:
            for tf, n in raw["min_touches"].items():
                if tf in TIMEFRAMES:
                    settings.min_touches[tf] = int(n)
        if "provider" in raw:
            settings.provider = raw["provider"]
    _migrate_old_defaults(settings.toss)
    _apply_env(settings.toss)
    env_provider = os.environ.get("MA_PROVIDER")
    if env_provider:
        settings.provider = env_provider
    return settings
