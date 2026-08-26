from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.backtesting.service import BacktestingService
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
        symbol=symbol or f"TRADE-DIAG-{uuid.uuid4().hex[:8]}",
        name="Trade Diagnostics Test Asset",
        asset_type="SIMULATED",
        exchange="SIMULATED",
        currency="USD",
    )


def seed_candles_and_indicators(
    session: Session,
    *,
    asset: Asset,
    base_timestamp: datetime,
    candles: list[dict[str, str]],
    indicator_series: list[dict[str, str] | None],
    timeframe: str = "1m",
) -> tuple[datetime, datetime]:
    for index, candle in enumerate(candles):
        timestamp = base_timestamp + timedelta(minutes=index)
        close = Decimal(candle["close"])
        session.add(
            MarketData(
                asset_id=asset.id,
                timestamp=timestamp,
                open=Decimal(candle.get("open", candle["close"])),
                high=Decimal(candle.get("high", candle["close"])),
                low=Decimal(candle.get("low", candle["close"])),
                close=close,
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
    return base_timestamp, base_timestamp + timedelta(minutes=len(candles) - 1)


def count_isolated_tables(session: Session) -> dict[str, int]:
    return {
        "backtest_runs": session.execute(select(func.count()).select_from(BacktestRun)).scalar_one(),
        "paper_orders": session.execute(select(func.count()).select_from(PaperOrder)).scalar_one(),
        "paper_fills": session.execute(select(func.count()).select_from(PaperFill)).scalar_one(),
        "paper_positions": session.execute(select(func.count()).select_from(PaperPosition)).scalar_one(),
        "portfolio_snapshots": session.execute(select(func.count()).select_from(PortfolioSnapshot)).scalar_one(),
    }


def build_two_trade_dataset(session: Session, *, asset: Asset, base_timestamp: datetime) -> tuple[datetime, datetime]:
    candles = [
        {"close": "100", "high": "101", "low": "99"},
        {"close": "103", "high": "104", "low": "100"},
        {"close": "99", "high": "104", "low": "98"},
        {"close": "102", "high": "103", "low": "101"},
        {"close": "103.2", "high": "104", "low": "102"},
        {"close": "103.4", "high": "103.8", "low": "103.0"},
        {"close": "103.2", "high": "103.5", "low": "102.8"},
    ]
    indicator_series = [
        {"EMA_20": "101.0", "EMA_50": "100.0", "RSI_14": "45.0", "MACD": "0.8", "MACD_SIGNAL": "0.4", "MACD_HISTOGRAM": "0.4", "ATR_14": "1.0"},
        {"EMA_20": "102.0", "EMA_50": "100.5", "RSI_14": "55.0", "MACD": "1.0", "MACD_SIGNAL": "0.5", "MACD_HISTOGRAM": "0.5", "ATR_14": "1.1"},
        {"EMA_20": "99.0", "EMA_50": "100.0", "RSI_14": "52.0", "MACD": "-0.3", "MACD_SIGNAL": "0.1", "MACD_HISTOGRAM": "-0.4", "ATR_14": "1.2"},
        {"EMA_20": "101.0", "EMA_50": "100.0", "RSI_14": "48.0", "MACD": "0.7", "MACD_SIGNAL": "0.3", "MACD_HISTOGRAM": "0.4", "ATR_14": "1.3"},
        {"EMA_20": "101.6", "EMA_50": "100.6", "RSI_14": "58.0", "MACD": "0.5", "MACD_SIGNAL": "0.2", "MACD_HISTOGRAM": "0.3", "ATR_14": "1.4"},
        {"EMA_20": "101.8", "EMA_50": "100.8", "RSI_14": "59.0", "MACD": "0.4", "MACD_SIGNAL": "0.2", "MACD_HISTOGRAM": "0.2", "ATR_14": "1.45"},
        {"EMA_20": "99.5", "EMA_50": "100.4", "RSI_14": "54.0", "MACD": "-0.4", "MACD_SIGNAL": "-0.1", "MACD_HISTOGRAM": "-0.3", "ATR_14": "1.5"},
    ]
    return seed_candles_and_indicators(
        session,
        asset=asset,
        base_timestamp=base_timestamp,
        candles=candles,
        indicator_series=indicator_series,
    )


def test_trade_diagnostics_reports_mae_mfe_exit_costs_and_preserves_storage(db_session: Session, market_service: MarketDataService) -> None:
    asset = create_asset(db_session, market_service)
    service = create_service()
    base = datetime(2026, 8, 27, 1, 0, tzinfo=timezone.utc)
    start, end = build_two_trade_dataset(db_session, asset=asset, base_timestamp=base)
    before_counts = count_isolated_tables(db_session)

    result = service.diagnose_trade_backtest(
        db_session,
        asset_id=asset.id,
        timeframe="1m",
        strategy="baseline_trend_rsi",
        start_timestamp=start,
        end_timestamp=end,
    )

    after_counts = count_isolated_tables(db_session)
    first_trade = result["trade_analysis"]["trades"][0]
    second_trade = result["trade_analysis"]["trades"][1]

    assert before_counts == after_counts
    assert result["summary"]["closed_trades"] == 2
    assert result["summary"]["winning_trades"] == 1
    assert result["summary"]["losing_trades"] == 1
    assert first_trade["outcome"] == "LOSS"
    assert first_trade["exit_reason"] == "signal_contraria"
    assert first_trade["mfe_return_percent"] == "0.04000000"
    assert first_trade["mae_return_percent"] == "-0.02000000"
    assert second_trade["entry_indicators"]["EMA20_EMA50_DISTANCE"] == "1.00000000"
    assert second_trade["entry_indicators"]["EMA20_SLOPE"] == "2.00000000"
    assert result["loser_analysis"]["classification"]["immediate_losses"] == 0
    assert result["loser_analysis"]["classification"]["previously_profitable_losses"] == 1
    assert result["exit_analysis"]["reason_distribution"]["signal_contraria"] == 2
    assert result["cost_analysis"]["trade_counts"]["profitable_without_commission"] == 1
    assert result["cost_analysis"]["trade_counts"]["profitable_after_commission"] == 1
    assert result["break_even_analysis"]["trade_count_reduction_for_break_even"]["status"] == "not_sufficient_under_current_average_trade_profile"


def test_trade_diagnostics_is_reproducible_and_no_lookahead_for_volatility_context(db_session: Session, market_service: MarketDataService) -> None:
    service = create_service()
    base = datetime(2026, 8, 27, 2, 0, tzinfo=timezone.utc)

    asset_a = create_asset(db_session, market_service, symbol=f"TRADE-DIAG-A-{uuid.uuid4().hex[:6]}")
    start_a, end_a = seed_candles_and_indicators(
        db_session,
        asset=asset_a,
        base_timestamp=base,
        candles=[
            {"close": "100", "high": "101", "low": "99"},
            {"close": "99", "high": "100", "low": "98"},
            {"close": "102", "high": "103", "low": "101"},
            {"close": "101", "high": "102", "low": "100"},
        ],
        indicator_series=[
            {"EMA_20": "101.0", "EMA_50": "100.0", "RSI_14": "45.0", "MACD": "0.8", "MACD_SIGNAL": "0.4", "MACD_HISTOGRAM": "0.4", "ATR_14": "1.0"},
            {"EMA_20": "99.0", "EMA_50": "100.0", "RSI_14": "50.0", "MACD": "-0.4", "MACD_SIGNAL": "0.0", "MACD_HISTOGRAM": "-0.4", "ATR_14": "1.1"},
            {"EMA_20": "101.0", "EMA_50": "100.0", "RSI_14": "46.0", "MACD": "0.7", "MACD_SIGNAL": "0.3", "MACD_HISTOGRAM": "0.4", "ATR_14": "1.2"},
            {"EMA_20": "99.0", "EMA_50": "100.0", "RSI_14": "51.0", "MACD": "-0.5", "MACD_SIGNAL": "-0.1", "MACD_HISTOGRAM": "-0.4", "ATR_14": "2.0"},
        ],
    )
    asset_b = create_asset(db_session, market_service, symbol=f"TRADE-DIAG-B-{uuid.uuid4().hex[:6]}")
    start_b, end_b = seed_candles_and_indicators(
        db_session,
        asset=asset_b,
        base_timestamp=base,
        candles=[
            {"close": "100", "high": "101", "low": "99"},
            {"close": "99", "high": "100", "low": "98"},
            {"close": "102", "high": "103", "low": "101"},
            {"close": "101", "high": "102", "low": "100"},
        ],
        indicator_series=[
            {"EMA_20": "101.0", "EMA_50": "100.0", "RSI_14": "45.0", "MACD": "0.8", "MACD_SIGNAL": "0.4", "MACD_HISTOGRAM": "0.4", "ATR_14": "1.0"},
            {"EMA_20": "99.0", "EMA_50": "100.0", "RSI_14": "50.0", "MACD": "-0.4", "MACD_SIGNAL": "0.0", "MACD_HISTOGRAM": "-0.4", "ATR_14": "1.1"},
            {"EMA_20": "101.0", "EMA_50": "100.0", "RSI_14": "46.0", "MACD": "0.7", "MACD_SIGNAL": "0.3", "MACD_HISTOGRAM": "0.4", "ATR_14": "1.2"},
            {"EMA_20": "99.0", "EMA_50": "100.0", "RSI_14": "51.0", "MACD": "-0.5", "MACD_SIGNAL": "-0.1", "MACD_HISTOGRAM": "-0.4", "ATR_14": "50.0"},
        ],
    )

    first = service.diagnose_trade_backtest(
        db_session,
        asset_id=asset_a.id,
        timeframe="1m",
        strategy="baseline_trend_rsi",
        start_timestamp=start_a,
        end_timestamp=end_a,
    )
    second = service.diagnose_trade_backtest(
        db_session,
        asset_id=asset_a.id,
        timeframe="1m",
        strategy="baseline_trend_rsi",
        start_timestamp=start_a,
        end_timestamp=end_a,
    )
    third = service.diagnose_trade_backtest(
        db_session,
        asset_id=asset_b.id,
        timeframe="1m",
        strategy="baseline_trend_rsi",
        start_timestamp=start_b,
        end_timestamp=end_b,
    )

    assert first["summary"] == second["summary"]
    assert first["trade_analysis"]["trades"][0]["entry_market_context"]["volatility"] == "low"
    assert first["trade_analysis"]["trades"][0]["entry_market_context"]["volatility"] == third["trade_analysis"]["trades"][0]["entry_market_context"]["volatility"]


def test_trade_diagnostics_holding_time_and_cost_warnings(db_session: Session, market_service: MarketDataService) -> None:
    asset = create_asset(db_session, market_service)
    service = create_service()
    base = datetime(2026, 8, 27, 3, 0, tzinfo=timezone.utc)
    start, end = build_two_trade_dataset(db_session, asset=asset, base_timestamp=base)

    result = service.diagnose_trade_backtest(
        db_session,
        asset_id=asset.id,
        timeframe="1m",
        strategy="baseline_trend_rsi",
        start_timestamp=start,
        end_timestamp=end,
    )

    assert result["holding_time_analysis"]["comparison"]["winners_hold_longer_than_losers"] is True
    assert result["holding_time_analysis"]["comparison"]["losers_with_positive_mfe"] == 1
    assert "cost_dominance" in result["warnings"]
    assert "aggregate_net_result_explained_by_costs" in result["warnings"]
    assert "large_mae_threshold_not_defined_objectively" in result["warnings"]
