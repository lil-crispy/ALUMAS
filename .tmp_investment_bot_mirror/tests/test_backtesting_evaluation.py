from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.database import SessionLocal
from app.db.models import Asset, BacktestRun, MarketData, PaperOrder, Indicator
from app.market_data.service import MarketDataService
from app.backtesting.service import BacktestingService


@pytest.fixture()
def db_session() -> Session:
    session = SessionLocal()
    transaction = session.begin()
    try:
        yield session
    finally:
        transaction.rollback()
        session.close()


@pytest.fixture()
def market_service() -> MarketDataService:
    return MarketDataService()


def build_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "app_name": "alumas-investment-bot",
        "app_env": "test",
        "app_port": 18000,
        "tz": "America/Bogota",
        "trading_mode": "PAPER",
        "live_trading_enabled": False,
        "trading_kill_switch": True,
        "order_execution_enabled": False,
        "database_url": "postgresql://investment_user:secret@investment_postgres:5432/alumas_investment",
        "paper_initial_cash": Decimal("10000"),
        "paper_commission_rate": Decimal("0.001"),
        "backtest_initial_cash": Decimal("10000"),
        "backtest_min_candles": 100,
    }
    values.update(overrides)
    return Settings(**values)


def create_service(**overrides: object) -> BacktestingService:
    return BacktestingService(build_settings(**overrides))


def create_asset(session: Session, market_service: MarketDataService, symbol: str | None = None) -> Asset:
    return market_service.ensure_simulated_asset(
        session,
        symbol=symbol or f"EVAL-{uuid.uuid4().hex[:8]}",
        name="Evaluation Test Asset",
        asset_type="SIMULATED",
        exchange="SIMULATED",
        currency="USD",
    )


def seed_market_and_indicators(
    session: Session,
    *,
    asset: Asset,
    base_timestamp: datetime,
    closes: list[str],
    indicator_series: list[dict[str, str] | None],
    timeframe: str = "1m",
) -> tuple[datetime, datetime]:
    for index, close in enumerate(closes):
        timestamp = base_timestamp + timedelta(minutes=index)
        price = Decimal(close)
        session.add(
            MarketData(
                asset_id=asset.id,
                timestamp=timestamp,
                open=price,
                high=price,
                low=price,
                close=price,
                volume=Decimal("1000.00000000"),
                timeframe=timeframe,
                source="simulator",
            )
        )
        indicator_map = indicator_series[index] or {}
        for name, value in indicator_map.items():
            session.add(
                Indicator(
                    asset_id=asset.id,
                    timestamp=timestamp,
                    timeframe=timeframe,
                    indicator_name=name,
                    indicator_value=Decimal(value),
                    metadata_json={"source": "internal_technical_engine", "market_data_source": "simulator", "timeframe": timeframe},
                )
            )
    session.flush()
    return base_timestamp, base_timestamp + timedelta(minutes=len(closes) - 1)


def test_analyze_backtest_counts_buy_sell_no_signal_and_insufficient(db_session: Session, market_service: MarketDataService) -> None:
    asset = create_asset(db_session, market_service)
    service = create_service(backtest_min_candles=10)
    base = datetime(2026, 8, 24, 10, 0, tzinfo=timezone.utc)
    start, end = seed_market_and_indicators(
        db_session,
        asset=asset,
        base_timestamp=base,
        closes=["100", "101", "102", "99", "110"],
        indicator_series=[
            None,
            {"EMA_20": "101", "EMA_50": "100", "RSI_14": "55", "MACD": "1", "MACD_SIGNAL": "0.5"},
            {"EMA_20": "102", "EMA_50": "100", "RSI_14": "80", "MACD": "1", "MACD_SIGNAL": "0.5"},
            {"EMA_20": "99", "EMA_50": "100", "RSI_14": "50", "MACD": "-1", "MACD_SIGNAL": "-0.5"},
            {"EMA_20": "111", "EMA_50": "100", "RSI_14": "55", "MACD": "2", "MACD_SIGNAL": "1"},
        ],
    )
    end = end - timedelta(minutes=1)
    paper_orders_before = db_session.execute(select(func.count()).select_from(PaperOrder)).scalar_one()

    result = service.analyze_backtest(
        db_session,
        asset_id=asset.id,
        timeframe="1m",
        strategy="baseline_trend_rsi",
        start_timestamp=start,
        end_timestamp=end,
    )

    paper_orders_after = db_session.execute(select(func.count()).select_from(PaperOrder)).scalar_one()
    assert result["candles_evaluated"] == 4
    assert result["buy_signals"] == 1
    assert result["sell_signals"] == 1
    assert result["no_signals"] == 1
    assert result["insufficient_indicators"] == 1
    assert result["rejected_signals"] == 0
    assert result["first_buy"]["timestamp"] == (base + timedelta(minutes=1)).isoformat()
    assert result["last_sell"]["timestamp"] == (base + timedelta(minutes=3)).isoformat()
    assert "insufficient_historical_sample" in result["warnings"]
    assert "insufficient_historical_period" in result["warnings"]
    assert paper_orders_before == paper_orders_after


def test_get_available_range_returns_real_history_bounds(db_session: Session, market_service: MarketDataService) -> None:
    asset = create_asset(db_session, market_service)
    service = create_service()
    base = datetime(2026, 8, 24, 11, 0, tzinfo=timezone.utc)
    seed_market_and_indicators(
        db_session,
        asset=asset,
        base_timestamp=base,
        closes=["100", "101", "102"],
        indicator_series=[None, None, None],
    )

    result = service.get_available_range(db_session, asset_id=asset.id, timeframe="1m")

    assert result["candles"] == 3
    assert result["start_timestamp"] == base.isoformat()
    assert result["end_timestamp"] == (base + timedelta(minutes=2)).isoformat()


def test_run_backtest_returns_structured_metrics_and_benchmark(db_session: Session, market_service: MarketDataService) -> None:
    asset = create_asset(db_session, market_service)
    service = create_service(backtest_min_candles=3)
    base = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)
    start, end = seed_market_and_indicators(
        db_session,
        asset=asset,
        base_timestamp=base,
        closes=["100", "101", "102", "101", "103", "105", "104", "106"],
        indicator_series=[
            None,
            {"EMA_20": "101.5", "EMA_50": "100.0", "RSI_14": "55.0", "MACD": "0.8", "MACD_SIGNAL": "0.5"},
            {"EMA_20": "102.0", "EMA_50": "100.0", "RSI_14": "56.0", "MACD": "0.9", "MACD_SIGNAL": "0.5"},
            {"EMA_20": "101.0", "EMA_50": "100.0", "RSI_14": "80.0", "MACD": "0.2", "MACD_SIGNAL": "0.1"},
            {"EMA_20": "102.0", "EMA_50": "101.0", "RSI_14": "60.0", "MACD": "0.3", "MACD_SIGNAL": "0.1"},
            {"EMA_20": "100.0", "EMA_50": "101.0", "RSI_14": "50.0", "MACD": "-0.4", "MACD_SIGNAL": "-0.1"},
            {"EMA_20": "99.0", "EMA_50": "101.0", "RSI_14": "45.0", "MACD": "-0.5", "MACD_SIGNAL": "-0.1"},
            {"EMA_20": "100.0", "EMA_50": "100.0", "RSI_14": "50.0", "MACD": "0.0", "MACD_SIGNAL": "0.0"},
        ],
    )

    result = service.run_backtest(
        db_session,
        asset_id=asset.id,
        timeframe="1m",
        strategy="baseline_trend_rsi",
        start_timestamp=start,
        end_timestamp=end,
    )

    assert result["summary"]["total_trades"] == 1
    assert result["trades"]["median_trade"] == result["trades"]["average_trade"]
    assert result["trades"]["expectancy"] == result["trades"]["average_trade"]
    assert result["risk"]["exposure_time_percent"] is not None
    assert result["benchmark"]["buy_and_hold_return"] == "0.06000000"
    assert result["benchmark"]["strategy_minus_buy_hold"] is not None
    assert "insufficient_historical_sample" in result["warnings"]
    assert "low_trade_count" in result["warnings"]
    assert db_session.execute(select(func.count()).select_from(BacktestRun)).scalar_one() == 1


def test_periods_and_walk_forward_do_not_overlap(db_session: Session, market_service: MarketDataService) -> None:
    asset = create_asset(db_session, market_service)
    service = create_service(backtest_min_candles=2)
    base = datetime(2026, 8, 24, 13, 0, tzinfo=timezone.utc)
    start, end = seed_market_and_indicators(
        db_session,
        asset=asset,
        base_timestamp=base,
        closes=["100", "101", "102", "103", "104", "105", "106", "107", "108", "109"],
        indicator_series=[
            None,
            {"EMA_20": "101", "EMA_50": "100", "RSI_14": "55", "MACD": "1", "MACD_SIGNAL": "0.5"},
            {"EMA_20": "102", "EMA_50": "100", "RSI_14": "55", "MACD": "1", "MACD_SIGNAL": "0.5"},
            {"EMA_20": "99", "EMA_50": "100", "RSI_14": "50", "MACD": "-1", "MACD_SIGNAL": "-0.5"},
            {"EMA_20": "101", "EMA_50": "100", "RSI_14": "55", "MACD": "1", "MACD_SIGNAL": "0.5"},
            {"EMA_20": "102", "EMA_50": "100", "RSI_14": "55", "MACD": "1", "MACD_SIGNAL": "0.5"},
            {"EMA_20": "99", "EMA_50": "100", "RSI_14": "50", "MACD": "-1", "MACD_SIGNAL": "-0.5"},
            {"EMA_20": "101", "EMA_50": "100", "RSI_14": "55", "MACD": "1", "MACD_SIGNAL": "0.5"},
            {"EMA_20": "102", "EMA_50": "100", "RSI_14": "55", "MACD": "1", "MACD_SIGNAL": "0.5"},
            {"EMA_20": "99", "EMA_50": "100", "RSI_14": "50", "MACD": "-1", "MACD_SIGNAL": "-0.5"},
        ],
    )

    result = service.run_backtest(
        db_session,
        asset_id=asset.id,
        timeframe="1m",
        strategy="baseline_trend_rsi",
        start_timestamp=start,
        end_timestamp=end,
    )

    assert set(result["periods"].keys()) == {"Q1", "Q2", "Q3", "Q4"}
    total_period_candles = sum(period["range"]["candles"] for period in result["periods"].values())
    assert total_period_candles == result["range"]["candles"]

    train = result["walk_forward"]["train"]["range"]
    test = result["walk_forward"]["test"]["range"]
    assert train["candles"] + test["candles"] == result["range"]["candles"]
    assert train["end_timestamp"] < test["start_timestamp"]


def test_run_backtest_warns_when_strategy_has_no_closed_trades(db_session: Session, market_service: MarketDataService) -> None:
    asset = create_asset(db_session, market_service)
    service = create_service(backtest_min_candles=2)
    base = datetime(2026, 8, 24, 14, 0, tzinfo=timezone.utc)
    start, end = seed_market_and_indicators(
        db_session,
        asset=asset,
        base_timestamp=base,
        closes=["100", "101", "106"],
        indicator_series=[
            None,
            {"EMA_20": "101.5", "EMA_50": "100.0", "RSI_14": "55.0", "MACD": "0.8", "MACD_SIGNAL": "0.5"},
            {"EMA_20": "102.0", "EMA_50": "100.0", "RSI_14": "55.0", "MACD": "0.8", "MACD_SIGNAL": "0.5"},
        ],
    )

    result = service.run_backtest(
        db_session,
        asset_id=asset.id,
        timeframe="1m",
        strategy="baseline_trend_rsi",
        start_timestamp=start,
        end_timestamp=end,
    )

    assert result["total_trades"] == 0
    assert result["total_trade_records"] == 1
    assert result["trades"]["expectancy"] is None
    assert "no_trades" in result["warnings"]
    assert "low_statistical_sample" in result["warnings"]
