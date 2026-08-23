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
        symbol=symbol or f"ROB-{uuid.uuid4().hex[:8]}",
        name="Robustness Test Asset",
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


def make_indicator_row(ema20: str, ema50: str, rsi: str, macd: str, macd_signal: str, hist: str, atr: str) -> dict[str, str]:
    return {
        "EMA_20": ema20,
        "EMA_50": ema50,
        "RSI_14": rsi,
        "MACD": macd,
        "MACD_SIGNAL": macd_signal,
        "MACD_HISTOGRAM": hist,
        "ATR_14": atr,
    }


def test_audit_dataset_quality_detects_gaps_duplicates_and_invalid_ohlc() -> None:
    service = create_service()
    base = datetime(2026, 8, 27, 0, 0, tzinfo=timezone.utc)
    rows = [
        MarketData(asset_id=1, timestamp=base, open=Decimal("100"), high=Decimal("101"), low=Decimal("99"), close=Decimal("100"), volume=Decimal("1"), timeframe="1m", source="simulator"),
        MarketData(asset_id=1, timestamp=base + timedelta(minutes=1), open=Decimal("101"), high=Decimal("102"), low=Decimal("100"), close=Decimal("101"), volume=Decimal("1"), timeframe="1m", source="simulator"),
        MarketData(asset_id=1, timestamp=base + timedelta(minutes=3), open=Decimal("0"), high=Decimal("0"), low=Decimal("0"), close=Decimal("0"), volume=Decimal("1"), timeframe="1m", source="simulator"),
        MarketData(asset_id=1, timestamp=base + timedelta(minutes=3), open=Decimal("102"), high=Decimal("103"), low=Decimal("101"), close=Decimal("102"), volume=Decimal("1"), timeframe="1m", source="simulator"),
    ]

    quality = service.audit_dataset_quality(rows)

    assert quality["count"] == 4
    assert quality["duplicate_timestamps"] == 1
    assert quality["gaps"] == 1
    assert quality["invalid_ohlc"] == 1


def test_robustness_empty_range_is_rejected(db_session: Session, market_service: MarketDataService) -> None:
    asset = create_asset(db_session, market_service)
    service = create_service()
    start = datetime(2026, 8, 27, 1, 0, tzinfo=timezone.utc)
    end = start + timedelta(minutes=5)

    with pytest.raises(BacktestingValidationError, match="range_without_data"):
        service.robustness_backtest(
            db_session,
            asset_id=asset.id,
            timeframe="1m",
            strategy="baseline_trend_rsi",
            start_timestamp=start,
            end_timestamp=end,
        )


def test_robustness_builds_windows_walkforward_and_preserves_storage(db_session: Session, market_service: MarketDataService) -> None:
    asset = create_asset(db_session, market_service)
    service = create_service()
    base = datetime(2026, 8, 27, 2, 0, tzinfo=timezone.utc)
    closes = ["100", "104", "100", "96", "99", "103", "100", "95", "98", "102", "99", "94"]
    indicator_series = [
        make_indicator_row("101.0", "100.0", "45.0", "0.8", "0.4", "0.4", "1.0"),
        make_indicator_row("99.0", "100.0", "50.0", "-0.5", "0.0", "-0.5", "1.1"),
        make_indicator_row("101.0", "100.0", "60.0", "0.7", "0.3", "0.4", "1.2"),
        make_indicator_row("99.0", "100.0", "55.0", "-0.6", "-0.2", "-0.4", "1.3"),
        make_indicator_row("101.0", "100.0", "40.0", "0.6", "0.2", "0.4", "1.4"),
        make_indicator_row("99.0", "100.0", "52.0", "-0.7", "-0.1", "-0.6", "1.5"),
        make_indicator_row("101.0", "100.0", "62.0", "0.9", "0.4", "0.5", "1.6"),
        make_indicator_row("99.0", "100.0", "54.0", "-0.8", "-0.2", "-0.6", "1.7"),
        make_indicator_row("101.0", "100.0", "58.0", "0.5", "0.1", "0.4", "1.5"),
        make_indicator_row("99.0", "100.0", "53.0", "-0.6", "-0.1", "-0.5", "1.4"),
        make_indicator_row("101.0", "100.0", "61.0", "0.7", "0.2", "0.5", "1.3"),
        make_indicator_row("99.0", "100.0", "51.0", "-0.7", "-0.2", "-0.5", "1.2"),
    ]
    start, end = seed_market_and_indicators(db_session, asset=asset, base_timestamp=base, closes=closes, indicator_series=indicator_series)
    before_counts = count_isolated_tables(db_session)

    result = service.robustness_backtest(
        db_session,
        asset_id=asset.id,
        timeframe="1m",
        strategy="baseline_trend_rsi",
        start_timestamp=start,
        end_timestamp=end,
    )

    after_counts = count_isolated_tables(db_session)
    assert before_counts == after_counts
    assert set(result["window_analysis"]["windows"].keys()) == {"25%", "50%", "75%", "100%"}
    assert set(result["walk_forward"].keys()) == {"60/40", "70/30", "80/20"}
    assert result["dataset_quality"]["count"] == 12
    assert result["dataset_quality"]["duplicate_timestamps"] == 0
    assert result["dataset_quality"]["invalid_ohlc"] == 0
    assert result["reproducibility"]["identical_trades"] is True
    assert result["reproducibility"]["identical_net_profit"] is True


def test_monte_carlo_is_seed_reproducible(db_session: Session, market_service: MarketDataService) -> None:
    asset = create_asset(db_session, market_service)
    service = create_service()
    base = datetime(2026, 8, 27, 3, 0, tzinfo=timezone.utc)
    closes = ["100", "104", "100", "96", "99", "103", "100", "95"]
    indicator_series = [
        make_indicator_row("101.0", "100.0", "45.0", "0.8", "0.4", "0.4", "1.0"),
        make_indicator_row("99.0", "100.0", "50.0", "-0.5", "0.0", "-0.5", "1.1"),
        make_indicator_row("101.0", "100.0", "60.0", "0.7", "0.3", "0.4", "1.2"),
        make_indicator_row("99.0", "100.0", "55.0", "-0.6", "-0.2", "-0.4", "1.3"),
        make_indicator_row("101.0", "100.0", "40.0", "0.6", "0.2", "0.4", "1.4"),
        make_indicator_row("99.0", "100.0", "52.0", "-0.7", "-0.1", "-0.6", "1.5"),
        make_indicator_row("101.0", "100.0", "62.0", "0.9", "0.4", "0.5", "1.6"),
        make_indicator_row("99.0", "100.0", "54.0", "-0.8", "-0.2", "-0.6", "1.7"),
    ]
    start, end = seed_market_and_indicators(db_session, asset=asset, base_timestamp=base, closes=closes, indicator_series=indicator_series)
    _, snapshots = service.prepare_range_inputs(
        db_session,
        asset_id=asset.id,
        timeframe="1m",
        strategy="baseline_trend_rsi",
        start_timestamp=start,
        end_timestamp=end,
        indicator_names=service.DIAGNOSTIC_INDICATORS,
    )
    result = service.engine.run(
        snapshots=snapshots,
        strategy="baseline_trend_rsi",
        initial_cash=service.settings.backtest_initial_cash,
        commission_rate=service.settings.paper_commission_rate,
    )

    first = service.run_monte_carlo(result, simulations=100, seed=7)
    second = service.run_monte_carlo(result, simulations=100, seed=7)

    assert first == second


def test_macd_stability_marks_small_samples_insufficient(db_session: Session, market_service: MarketDataService) -> None:
    asset = create_asset(db_session, market_service)
    service = create_service()
    base = datetime(2026, 8, 27, 4, 0, tzinfo=timezone.utc)
    closes = ["100", "104", "100", "96", "99", "103"]
    indicator_series = [
        make_indicator_row("101.0", "100.0", "45.0", "0.8", "0.4", "0.4", "1.0"),
        make_indicator_row("99.0", "100.0", "50.0", "-0.5", "0.0", "-0.5", "1.1"),
        make_indicator_row("101.0", "100.0", "60.0", "0.7", "0.3", "0.4", "1.2"),
        make_indicator_row("99.0", "100.0", "55.0", "-0.6", "-0.2", "-0.4", "1.3"),
        make_indicator_row("101.0", "100.0", "40.0", "0.6", "0.2", "0.4", "1.4"),
        make_indicator_row("99.0", "100.0", "52.0", "-0.7", "-0.1", "-0.6", "1.5"),
    ]
    start, end = seed_market_and_indicators(db_session, asset=asset, base_timestamp=base, closes=closes, indicator_series=indicator_series)
    _, snapshots = service.prepare_range_inputs(
        db_session,
        asset_id=asset.id,
        timeframe="1m",
        strategy="baseline_trend_rsi",
        start_timestamp=start,
        end_timestamp=end,
        indicator_names=service.DIAGNOSTIC_INDICATORS,
    )

    macd_stability = service.build_macd_stability({}, snapshots, strategy="baseline_trend_rsi")

    assert macd_stability["100%"]["positive"] == "INSUFFICIENT_SAMPLE"
    assert macd_stability["100%"]["negative"] == "INSUFFICIENT_SAMPLE"
