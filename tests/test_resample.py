"""리샘플링 검증."""
import numpy as np
import pandas as pd

from app.resample import resample_daily


def test_weekly_aggregation():
    # 2주치 (월~금 x2)
    dates = pd.bdate_range("2024-01-01", periods=10)  # 1/1(월)~1/12(금)
    df = pd.DataFrame({
        "date": dates,
        "open": np.arange(10, 20, dtype=float),
        "high": np.arange(20, 30, dtype=float),
        "low": np.arange(1, 11, dtype=float),
        "close": np.arange(15, 25, dtype=float),
        "volume": np.full(10, 100),
    })
    wk = resample_daily(df, "week")
    assert len(wk) == 2
    first = wk.iloc[0]
    assert first["open"] == 10       # 첫 봉 시가
    assert first["high"] == 24       # 주중 최고가
    assert first["low"] == 1         # 주중 최저가
    assert first["close"] == 19      # 마지막 봉 종가
    assert first["volume"] == 500
    assert first["date"] == pd.Timestamp("2024-01-05")  # 실제 마지막 거래일


def test_monthly_aggregation():
    dates = pd.bdate_range("2024-01-01", "2024-02-29")
    n = len(dates)
    df = pd.DataFrame({
        "date": dates,
        "open": np.linspace(100, 110, n),
        "high": np.linspace(105, 115, n),
        "low": np.linspace(95, 105, n),
        "close": np.linspace(100, 110, n),
        "volume": np.full(n, 10),
    })
    mo = resample_daily(df, "month")
    assert len(mo) == 2
    jan = mo.iloc[0]
    jan_mask = df["date"].dt.month == 1
    assert jan["high"] == df.loc[jan_mask, "high"].max()
    assert jan["close"] == df.loc[jan_mask, "close"].iloc[-1]
    assert jan["date"] == df.loc[jan_mask, "date"].iloc[-1]


def test_day_passthrough():
    dates = pd.bdate_range("2024-01-01", periods=5)
    df = pd.DataFrame({
        "date": dates, "open": [1.0] * 5, "high": [2.0] * 5,
        "low": [0.5] * 5, "close": [1.5] * 5, "volume": [1] * 5,
    })
    assert resample_daily(df, "day") is df
