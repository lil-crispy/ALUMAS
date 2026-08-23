from __future__ import annotations

from datetime import datetime

from fastapi import FastAPI, HTTPException, Query

from app.backtesting.service import BacktestingService
from app.core.config import get_settings
from app.core.database import check_database_connection, initialize_database, session_scope
from app.core.security import validate_settings_or_raise
from app.market_data.service import MarketDataService
from app.paper_trading.service import PaperTradingService
from app.signals.service import SignalService
from app.technical.service import TechnicalIndicatorService

settings = validate_settings_or_raise(get_settings())
market_data_service = MarketDataService()
technical_indicator_service = TechnicalIndicatorService()
signal_service = SignalService()
paper_trading_service = PaperTradingService(settings)
backtesting_service = BacktestingService(settings)

app = FastAPI(title=settings.app_name)


@app.on_event("startup")
def validate_startup_configuration() -> None:
    validate_settings_or_raise(settings)
    initialize_database()


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "service": settings.app_name,
        "trading_mode": settings.trading_mode,
        "live_trading_enabled": settings.live_trading_enabled,
        "kill_switch": settings.trading_kill_switch,
    }


@app.get("/health/db")
def health_db() -> dict[str, object]:
    try:
        check_database_connection(record_status=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail="database unavailable") from exc

    return {
        "status": "ok",
        "database": "connected",
        "trading_mode": settings.trading_mode,
        "kill_switch": settings.trading_kill_switch,
    }


@app.post("/market-data/simulate")
def simulate_market_data(count: int = Query(default=100, ge=1, le=1000)) -> dict[str, object]:
    try:
        with session_scope() as session:
            summary = market_data_service.simulate(session, count=count)
            return summary.to_dict()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/market-data/historical/generate")
def generate_historical_market_data(
    asset_id: int = Query(..., ge=1),
    count: int = Query(..., ge=1, le=10000),
    timeframe: str = Query(..., min_length=2, max_length=32),
) -> dict[str, object]:
    try:
        with session_scope() as session:
            summary = market_data_service.generate_historical_dataset(
                session,
                asset_id=asset_id,
                count=count,
                timeframe=timeframe,
            )
            return summary.to_dict()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/technical/indicators/calculate")
def calculate_technical_indicators(asset_id: int = Query(..., ge=1), timeframe: str = Query(..., min_length=2, max_length=32)) -> dict[str, object]:
    try:
        with session_scope() as session:
            return technical_indicator_service.calculate_and_store(session, asset_id=asset_id, timeframe=timeframe)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/signals/evaluate")
def evaluate_signals(
    asset_id: int = Query(..., ge=1),
    timeframe: str = Query(..., min_length=2, max_length=32),
    strategy: str = Query(..., min_length=3, max_length=128),
) -> dict[str, object]:
    try:
        with session_scope() as session:
            return signal_service.evaluate(session, asset_id=asset_id, timeframe=timeframe, strategy=strategy)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/paper-trading/execute")
def execute_paper_trading(signal_id: int = Query(..., ge=1)) -> dict[str, object]:
    try:
        with session_scope() as session:
            return paper_trading_service.execute_signal(session, signal_id=signal_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/backtesting/analyze")
def analyze_backtest(
    asset_id: int = Query(..., ge=1),
    timeframe: str = Query(..., min_length=2, max_length=32),
    strategy: str = Query(..., min_length=3, max_length=128),
    start_timestamp: datetime = Query(...),
    end_timestamp: datetime = Query(...),
) -> dict[str, object]:
    try:
        with session_scope() as session:
            return backtesting_service.analyze_backtest(
                session,
                asset_id=asset_id,
                timeframe=timeframe,
                strategy=strategy,
                start_timestamp=start_timestamp,
                end_timestamp=end_timestamp,
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/backtesting/diagnostics")
def diagnose_backtest(
    asset_id: int = Query(..., ge=1),
    timeframe: str = Query(..., min_length=2, max_length=32),
    strategy: str = Query(..., min_length=3, max_length=128),
    start_timestamp: datetime = Query(...),
    end_timestamp: datetime = Query(...),
) -> dict[str, object]:
    try:
        with session_scope() as session:
            return backtesting_service.diagnose_backtest(
                session,
                asset_id=asset_id,
                timeframe=timeframe,
                strategy=strategy,
                start_timestamp=start_timestamp,
                end_timestamp=end_timestamp,
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/backtesting/robustness")
def robustness_backtest(
    asset_id: int = Query(..., ge=1),
    timeframe: str = Query(..., min_length=2, max_length=32),
    strategy: str = Query(..., min_length=3, max_length=128),
    start_timestamp: datetime = Query(...),
    end_timestamp: datetime = Query(...),
) -> dict[str, object]:
    try:
        with session_scope() as session:
            return backtesting_service.robustness_backtest(
                session,
                asset_id=asset_id,
                timeframe=timeframe,
                strategy=strategy,
                start_timestamp=start_timestamp,
                end_timestamp=end_timestamp,
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/backtesting/strategy-comparison")
def strategy_comparison_backtest(
    asset_id: int = Query(..., ge=1),
    timeframe: str = Query(..., min_length=2, max_length=32),
    start_timestamp: datetime = Query(...),
    end_timestamp: datetime = Query(...),
) -> dict[str, object]:
    try:
        with session_scope() as session:
            return backtesting_service.compare_strategies(
                session,
                asset_id=asset_id,
                timeframe=timeframe,
                start_timestamp=start_timestamp,
                end_timestamp=end_timestamp,
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/backtesting/diagnostics/trades")
def trade_diagnostics_backtest(
    asset_id: int = Query(..., ge=1),
    timeframe: str = Query(..., min_length=2, max_length=32),
    strategy: str = Query(..., min_length=3, max_length=128),
    start_timestamp: datetime = Query(...),
    end_timestamp: datetime = Query(...),
) -> dict[str, object]:
    try:
        with session_scope() as session:
            return backtesting_service.diagnose_trade_backtest(
                session,
                asset_id=asset_id,
                timeframe=timeframe,
                strategy=strategy,
                start_timestamp=start_timestamp,
                end_timestamp=end_timestamp,
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/backtesting/run")
def run_backtest(
    asset_id: int = Query(..., ge=1),
    timeframe: str = Query(..., min_length=2, max_length=32),
    strategy: str = Query(..., min_length=3, max_length=128),
    start_timestamp: datetime = Query(...),
    end_timestamp: datetime = Query(...),
) -> dict[str, object]:
    try:
        with session_scope() as session:
            return backtesting_service.run_backtest(
                session,
                asset_id=asset_id,
                timeframe=timeframe,
                strategy=strategy,
                start_timestamp=start_timestamp,
                end_timestamp=end_timestamp,
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
