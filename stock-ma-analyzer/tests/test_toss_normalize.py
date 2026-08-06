"""토스 응답 정규화(normalizer) 관용성 테스트."""
import pandas as pd
import pytest

from app.providers.toss import TossApiError, normalize_candles


def test_flat_list_standard_keys():
    payload = [
        {"date": "2024-01-02", "open": 100, "high": 110, "low": 95, "close": 105, "volume": 1000},
        {"date": "2024-01-03", "open": 105, "high": 112, "low": 101, "close": 108, "volume": 900},
    ]
    df = normalize_candles(payload)
    assert len(df) == 2
    assert list(df["close"]) == [105.0, 108.0]


def test_nested_result_camel_case():
    payload = {
        "result": {
            "candles": [
                {"dt": "20240102", "openPrice": "100", "highPrice": "110",
                 "lowPrice": "95", "closePrice": "105", "tradingVolume": "1000"},
            ]
        }
    }
    df = normalize_candles(payload)
    assert df["date"].iloc[0] == pd.Timestamp("2024-01-02")
    assert df["close"].iloc[0] == 105.0


def test_epoch_millis_and_descending_order():
    payload = {"data": [
        {"timestamp": 1704326400000, "o": 105, "h": 112, "l": 101, "c": 108, "v": 900},
        {"timestamp": 1704240000000, "o": 100, "h": 110, "l": 95, "c": 105, "v": 1000},
    ]}
    df = normalize_candles(payload)
    # 오름차순 정렬 보장
    assert df["date"].is_monotonic_increasing
    assert df["close"].iloc[-1] == 108.0


def test_unrecognizable_payload_raises():
    with pytest.raises(TossApiError):
        normalize_candles({"message": "ok", "result": {"score": 1}})


def test_duplicate_dates_deduped():
    payload = [
        {"date": "2024-01-02", "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 10},
        {"date": "2024-01-02", "open": 1, "high": 2, "low": 0.5, "close": 1.7, "volume": 12},
    ]
    df = normalize_candles(payload)
    assert len(df) == 1
    assert df["close"].iloc[0] == 1.7
