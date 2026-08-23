from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.backtesting.service import BacktestingService
from app.backtesting.validator import BacktestingValidationError
from app.core.config import Settings
from app.core.database import SessionLocal
from app.db.models import (
    Asset,
    BacktestRun,
    Indicator,
    MarketData,
    PaperFill,
    PaperOrder,
    PaperPosition,
    PortfolioSnapshot,
)
from app.market_data.service import MarketDataService


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
        "backtest_min_candles": 2,
    }
    values.update(overrides)
    return Settings(**values)


def create_service(**overrides: object) -> BacktestingService:
    return BacktestingService(build_settings(**overrides))


def create_asset(session: Session, market_service: MarketDataService, symbol: str | None = None) -> Asset:
    return market_service.ensure_simulated_asset(
        session,
        symbol=symbol or f"DIAG-{uuid.uuid4().hex[:8]}",
        name="Diagnostics Test Asset",
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


def count_isolated_tables(session: Session) -> dict[str, int]:
    return {
        "backtest_runs": session.execute(select(func.count()).select_from(BacktestRun)).scalar_one(),
        "paper_orders": session.execute(select(func.count()).select_from(PaperOrder)).scalar_one(),
        "paper_fills": session.execute(select(func.count()).select_from(PaperFill)).scalar_one(),
        "paper_positions": session.execute(select(func.count()).select_from(PaperPosition)).scalar_one(),
        "portfolio_snapshots": session.execute(select(func.count()).select_from(PortfolioSnapshot)).scalar_one(),
    }


def test_diagnostics_empty_range_is_rejected(db_session: Session, market_service: MarketDataService) -> None:
    asset = create_asset(db_session, market_service)
    service = create_service()
    start = datetime(2026, 8, 26, 0, 0, tzinfo=timezone.utc)
    end = start + timedelta(minutes=5)

    with pytest.raises(BacktestingValidationError, match="range_without_data"):
        service.diagnose_backtest(
            db_session,
            asset_id=asset.id,
            timeframe="1m",
            strategy="baseline_trend_rsi",
            start_timestamp=start,
            end_timestamp=end,
        )


def test_diagnostics_single_trade_reports_entry_exit_and_preserves_storage(db_session: Session, market_service: MarketDataService) -> None:
    asset = create_asset(db_session, market_service)
    service = create_service()
    base = datetime(2026, 8, 26, 1, 0, tzinfo=timezone.utc)
    start, end = seed_market_and_indicators(
        db_session,
        asset=asset,
        base_timestamp=base,
        closes=["100", "101", "103", "105", "104"],
        indicator_series=[
            None,
            {
                "EMA_20": "101.5",
                "EMA_50": "100.0",
                "RSI_14": "45.0",
                "MACD": "0.8",
                "MACD_SIGNAL": "0.5",
                "MACD_HISTOGRAM": "0.3",
                "ATR_14": "1.2",
            },
            {
                "EMA_20": "102.0",
                "EMA_50": "100.5",
                "RSI_14": "75.0",
                "MACD": "1.2",
                "MACD_SIGNAL": "0.8",
                "MACD_HISTOGRAM": "0.4",
                "ATR_14": "1.1",
            },
            {
                "EMA_20": "99.0",
                "EMA_50": "100.0",
                "RSI_14": "52.0",
                "MACD": "-0.3",
                "MACD_SIGNAL": "0.0",
                "MACD_HISTOGRAM": "-0.3",
                "ATR_14": "1.4",
            },
            {
                "EMA_20": "120.0",
                "EMA_50": "90.0",
                "RSI_14": "65.0",
                "MACD": "2.0",
                "MACD_SIGNAL": "1.0",
                "MACD_HISTOGRAM": "1.0",
                "ATR_14": "2.0",
            },
        ],
    )
    before_counts = count_isolated_tables(db_session)

    result = service.diagnose_backtest(
        db_session,
        asset_id=asset.id,
        timeframe="1m",
        strategy="baseline_trend_rsi",
        start_timestamp=start,
        end_timestamp=end,
    )

    after_counts = count_isolated_tables(db_session)
    trade = result["trade_statistics"]["closed_trades"][0]

    assert before_counts == after_counts
    assert result["summary"]["total_trades"] == 1
    assert trade["entry_timestamp"] == (base + timedelta(minutes=1)).isoformat()
    assert trade["exit_timestamp"] == (base + timedelta(minutes=3)).isoformat()
    assert trade["holding_time_minutes"] == 2
    assert trade["entry_indicators"]["EMA20"] == "101.50000000"
    assert trade["entry_indicators"]["ATR14"] == "1.20000000"
    assert trade["exit_indicators"]["MACD_HISTOGRAM"] == "-0.30000000"
    assert trade["entry_context"]["rsi_band"] == "30-50"
    assert trade["exit_context"]["macd_sign"] == "negative"
    assert result["entry_analysis"]["winning_trades"]["indicators"]["EMA20"]["average"] == "101.50000000"
    assert result["holding_time"]["overall"]["average"] == "2.00000000"
    assert result["trade_statistics"]["distribution"]["2% a 5%"] == 1


def test_diagnostics_multiple_trades_report_streaks_context_costs_and_warnings(db_session: Session, market_service: MarketDataService) -> None:
    asset = create_asset(db_session, market_service)
    service = create_service()
    base = datetime(2026, 8, 26, 2, 0, tzinfo=timezone.utc)
    start, end = seed_market_and_indicators(
        db_session,
        asset=asset,
        base_timestamp=base,
        closes=["100", "104", "100", "97", "99", "95"],
        indicator_series=[
            {
                "EMA_20": "101.0",
                "EMA_50": "100.0",
                "RSI_14": "45.0",
                "MACD": "0.8",
                "MACD_SIGNAL": "0.4",
                "MACD_HISTOGRAM": "0.4",
                "ATR_14": "1.0",
            },
            {
                "EMA_20": "99.0",
                "EMA_50": "100.0",
                "RSI_14": "50.0",
                "MACD": "-0.5",
                "MACD_SIGNAL": "0.0",
                "MACD_HISTOGRAM": "-0.5",
                "ATR_14": "1.1",
            },
            {
                "EMA_20": "101.0",
                "EMA_50": "100.0",
                "RSI_14": "60.0",
                "MACD": "0.7",
                "MACD_SIGNAL": "0.3",
                "MACD_HISTOGRAM": "0.4",
                "ATR_14": "1.2",
            },
            {
                "EMA_20": "99.0",
                "EMA_50": "100.0",
                "RSI_14": "55.0",
                "MACD": "-0.6",
                "MACD_SIGNAL": "-0.2",
                "MACD_HISTOGRAM": "-0.4",
                "ATR_14": "1.3",
            },
            {
                "EMA_20": "101.0",
                "EMA_50": "100.0",
                "RSI_14": "58.0",
                "MACD": "0.6",
                "MACD_SIGNAL": "0.2",
                "MACD_HISTOGRAM": "0.4",
                "ATR_14": "1.4",
            },
            {
                "EMA_20": "99.0",
                "EMA_50": "100.0",
                "RSI_14": "54.0",
                "MACD": "-0.7",
                "MACD_SIGNAL": "-0.1",
                "MACD_HISTOGRAM": "-0.6",
                "ATR_14": "1.5",
            },
        ],
    )
    before_counts = count_isolated_tables(db_session)

    result = service.diagnose_backtest(
        db_session,
        asset_id=asset.id,
        timeframe="1m",
        strategy="baseline_trend_rsi",
        start_timestamp=start,
        end_timestamp=end,
    )

    after_counts = count_isolated_tables(db_session)
    assert before_counts == after_counts
    assert result["summary"]["total_trades"] == 3
    assert result["streaks"]["max_consecutive_wins"] == 1
    assert result["streaks"]["max_consecutive_losses"] == 2
    assert result["market_context"]["entry_context"]["ema_relation"]["EMA20_GT_EMA50"]["trades"] == 3
    assert result["market_context"]["entry_context"]["rsi_band"]["30-50"]["trades"] == 1
    assert result["market_context"]["entry_context"]["rsi_band"]["50-70"]["trades"] == 2
    assert Decimal(result["cost_analysis"]["commissions"]) > 0
    assert "low_win_rate" in result["warnings"]
    assert "negative_expectancy" in result["warnings"]


def test_diagnostics_is_reproducible_and_exposes_periods_and_walk_forward(db_session: Session, market_service: MarketDataService) -> None:
    asset = create_asset(db_session, market_service)
    service = create_service()
    base = datetime(2026, 8, 26, 3, 0, tzinfo=timezone.utc)
    start, end = seed_market_and_indicators(
        db_session,
        asset=asset,
        base_timestamp=base,
        closes=["100", "104", "100", "96", "99", "103", "100", "95"],
        indicator_series=[
            {"EMA_20": "101.0", "EMA_50": "100.0", "RSI_14": "45.0", "MACD": "0.8", "MACD_SIGNAL": "0.4", "MACD_HISTOGRAM": "0.4", "ATR_14": "1.0"},
            {"EMA_20": "99.0", "EMA_50": "100.0", "RSI_14": "50.0", "MACD": "-0.5", "MACD_SIGNAL": "0.0", "MACD_HISTOGRAM": "-0.5", "ATR_14": "1.1"},
            {"EMA_20": "101.0", "EMA_50": "100.0", "RSI_14": "60.0", "MACD": "0.7", "MACD_SIGNAL": "0.3", "MACD_HISTOGRAM": "0.4", "ATR_14": "1.2"},
            {"EMA_20": "99.0", "EMA_50": "100.0", "RSI_14": "55.0", "MACD": "-0.6", "MACD_SIGNAL": "-0.2", "MACD_HISTOGRAM": "-0.4", "ATR_14": "1.3"},
            {"EMA_20": "101.0", "EMA_50": "100.0", "RSI_14": "40.0", "MACD": "0.6", "MACD_SIGNAL": "0.2", "MACD_HISTOGRAM": "0.4", "ATR_14": "1.4"},
            {"EMA_20": "99.0", "EMA_50": "100.0", "RSI_14": "52.0", "MACD": "-0.7", "MACD_SIGNAL": "-0.1", "MACD_HISTOGRAM": "-0.6", "ATR_14": "1.5"},
            {"EMA_20": "101.0", "EMA_50": "100.0", "RSI_14": "62.0", "MACD": "0.9", "MACD_SIGNAL": "0.4", "MACD_HISTOGRAM": "0.5", "ATR_14": "1.6"},
            {"EMA_20": "99.0", "EMA_50": "100.0", "RSI_14": "54.0", "MACD": "-0.8", "MACD_SIGNAL": "-0.2", "MACD_HISTOGRAM": "-0.6", "ATR_14": "1.7"},
        ],
    )

    first = service.diagnose_backtest(
        db_session,
        asset_id=asset.id,
        timeframe="1m",
        strategy="baseline_trend_rsi",
        start_timestamp=start,
        end_timestamp=end,
    )
    second = service.diagnose_backtest(
        db_session,
        asset_id=asset.id,
        timeframe="1m",
        strategy="baseline_trend_rsi",
        start_timestamp=start,
        end_timestamp=end,
    )

    assert first["summary"] == second["summary"]
    assert first["trade_statistics"]["distribution"] == second["trade_statistics"]["distribution"]
    assert set(first["period_analysis"].keys()) == {"Q1", "Q2", "Q3", "Q4"}
    assert first["walk_forward"]["split"] == {"train_percent": 70, "test_percent": 30}
    assert "strategy_return" in first["walk_forward"]["train"]
    assert "strategy_return" in first["walk_forward"]["test"]
