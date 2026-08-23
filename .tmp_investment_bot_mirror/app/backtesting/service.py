from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
import random
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.backtesting.engine import BacktestingEngine
from app.backtesting.metrics import BacktestingMetrics
from app.backtesting.models import BacktestResult, BacktestSignalSnapshot, BacktestTradeRecord, format_decimal, quantize_value
from app.backtesting.validator import BacktestingValidationError, BacktestingValidator
from app.core.config import Settings, get_settings
from app.core.database import SessionLocal
from app.db.models import Asset, AuditEvent, BacktestEquity, BacktestRun, BacktestTrade, Indicator, MarketData
from app.signals.engine import SignalEngine
from app.signals.models import (
    BASELINE_TREND_RSI,
    BASELINE_TREND_RSI_ATR_FILTER,
    BASELINE_TREND_RSI_MACD_POSITIVE,
    BASELINE_TREND_RSI_STRICT_TREND,
    SIGNAL_BUY,
    SIGNAL_SELL,
    SignalEvaluationInput,
    SignalEvaluationResult,
    VALID_STRATEGIES,
)


class BacktestingService:
    REQUIRED_INDICATORS = ("EMA_20", "EMA_50", "RSI_14", "MACD", "MACD_SIGNAL")
    DIAGNOSTIC_INDICATORS = ("EMA_20", "EMA_50", "RSI_14", "MACD", "MACD_SIGNAL", "MACD_HISTOGRAM", "ATR_14")
    STATISTICAL_SAMPLE_TARGET = 1000
    STRATEGY_COMPARISON_VARIANTS = (
        BASELINE_TREND_RSI_MACD_POSITIVE,
        BASELINE_TREND_RSI_ATR_FILTER,
        BASELINE_TREND_RSI_STRICT_TREND,
    )
    NOT_IMPLEMENTED_VARIANTS = {
        "baseline_trend_rsi_selective": (
            "No se pudo definir una regla adicional objetiva sin introducir umbrales arbitrarios "
            "o solapar las hipotesis de MACD positivo y tendencia estricta."
        )
    }

    def __init__(
        self,
        settings: Settings | None = None,
        engine: BacktestingEngine | None = None,
        signal_engine: SignalEngine | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.signal_engine = signal_engine or SignalEngine()
        self.engine = engine or BacktestingEngine(self.signal_engine)

    def get_required_indicator_names(self, strategy: str) -> tuple[str, ...]:
        return self.signal_engine.required_indicator_names(strategy)

    def build_signal_input_from_snapshot(
        self,
        snapshot: BacktestSignalSnapshot,
        *,
        strategy: str,
        atr_history: list[Decimal] | None = None,
    ) -> SignalEvaluationInput:
        atr_14 = snapshot.indicator_values.get("ATR_14")
        atr_expanding_median = None
        if atr_history is not None and atr_14 is not None:
            atr_expanding_median = BacktestingMetrics.median([*atr_history, atr_14])
        return SignalEvaluationInput(
            asset_id=snapshot.asset_id,
            asset_symbol=snapshot.asset_symbol,
            timeframe=snapshot.timeframe,
            strategy=strategy,
            timestamp=snapshot.timestamp,
            close=snapshot.close,
            ema_20=snapshot.indicator_values["EMA_20"],
            ema_50=snapshot.indicator_values["EMA_50"],
            rsi_14=snapshot.indicator_values["RSI_14"],
            macd=snapshot.indicator_values["MACD"],
            macd_signal=snapshot.indicator_values["MACD_SIGNAL"],
            atr_14=atr_14,
            atr_expanding_median=atr_expanding_median,
        )

    @staticmethod
    def append_atr_history(snapshot: BacktestSignalSnapshot, atr_history: list[Decimal]) -> None:
        atr_14 = snapshot.indicator_values.get("ATR_14")
        if atr_14 is not None:
            atr_history.append(atr_14)

    def record_audit_event(self, session: Session, *, event_type: str, severity: str, message: str, metadata: dict[str, object] | None = None) -> AuditEvent:
        event = AuditEvent(
            timestamp=datetime.now(timezone.utc),
            event_type=event_type,
            component="backtesting",
            severity=severity,
            message=message,
            metadata_json=metadata,
        )
        session.add(event)
        session.flush()
        return event

    def record_error_event(self, *, asset_id: int | None, strategy: str | None, error: str) -> None:
        error_session = SessionLocal()
        try:
            event = AuditEvent(
                timestamp=datetime.now(timezone.utc),
                event_type="backtesting.error",
                component="backtesting",
                severity="error",
                message="Backtesting failed",
                metadata_json={"asset_id": asset_id, "strategy": strategy, "error": error},
            )
            error_session.add(event)
            error_session.commit()
        finally:
            error_session.close()

    def get_asset(self, session: Session, *, asset_id: int) -> Asset | None:
        return session.get(Asset, asset_id)

    def get_available_range(self, session: Session, *, asset_id: int, timeframe: str) -> dict[str, object]:
        stmt = select(
            func.min(MarketData.timestamp),
            func.max(MarketData.timestamp),
            func.count(MarketData.id),
        ).where(MarketData.asset_id == asset_id, MarketData.timeframe == timeframe)
        start_timestamp, end_timestamp, candles = session.execute(stmt).one()
        return {
            "start_timestamp": start_timestamp.isoformat() if start_timestamp else None,
            "end_timestamp": end_timestamp.isoformat() if end_timestamp else None,
            "candles": int(candles or 0),
        }

    def load_market_rows(self, session: Session, *, asset_id: int, timeframe: str, start_timestamp: datetime, end_timestamp: datetime) -> list[MarketData]:
        stmt = (
            select(MarketData)
            .where(
                MarketData.asset_id == asset_id,
                MarketData.timeframe == timeframe,
                MarketData.timestamp >= start_timestamp,
                MarketData.timestamp <= end_timestamp,
            )
            .order_by(MarketData.timestamp.asc())
        )
        return list(session.execute(stmt).scalars())

    def load_indicator_rows(
        self,
        session: Session,
        *,
        asset_id: int,
        timeframe: str,
        start_timestamp: datetime,
        end_timestamp: datetime,
        indicator_names: tuple[str, ...] | None = None,
    ) -> list[Indicator]:
        selected_indicator_names = indicator_names or self.REQUIRED_INDICATORS
        stmt = (
            select(Indicator)
            .where(
                Indicator.asset_id == asset_id,
                Indicator.timeframe == timeframe,
                Indicator.timestamp >= start_timestamp,
                Indicator.timestamp <= end_timestamp,
                Indicator.indicator_name.in_(selected_indicator_names),
            )
            .order_by(Indicator.timestamp.asc())
        )
        return list(session.execute(stmt).scalars())

    def build_snapshots(self, *, asset: Asset, timeframe: str, market_rows: list[MarketData], indicator_rows: list[Indicator]) -> list[BacktestSignalSnapshot]:
        indicators_by_timestamp: dict[datetime, dict[str, Decimal]] = {}
        for row in indicator_rows:
            indicators_by_timestamp.setdefault(row.timestamp, {})[row.indicator_name] = row.indicator_value

        snapshots: list[BacktestSignalSnapshot] = []
        for row in market_rows:
            snapshots.append(
                BacktestSignalSnapshot(
                    asset_id=asset.id,
                    asset_symbol=asset.symbol,
                    timeframe=timeframe,
                    timestamp=row.timestamp,
                    open=row.open,
                    high=row.high,
                    low=row.low,
                    close=row.close,
                    indicator_values=indicators_by_timestamp.get(row.timestamp, {}),
                )
            )
        return snapshots

    def evaluate_snapshot_signal(
        self,
        snapshot: BacktestSignalSnapshot,
        strategy: str,
        *,
        atr_history: list[Decimal] | None = None,
    ) -> SignalEvaluationResult:
        signal_input = self.build_signal_input_from_snapshot(snapshot, strategy=strategy, atr_history=atr_history)
        return self.signal_engine.evaluate(signal_input, strategy)

    def format_signal_marker(self, result: SignalEvaluationResult) -> dict[str, object]:
        return {
            "timestamp": result.timestamp.isoformat(),
            "price": format_decimal(result.price),
            "confidence": format_decimal(result.confidence),
            "reason": result.reason,
        }

    def analyze_snapshots(self, snapshots: list[BacktestSignalSnapshot], *, strategy: str) -> dict[str, object]:
        buy_events: list[dict[str, object]] = []
        sell_events: list[dict[str, object]] = []
        no_signals = 0
        rejected_signals = 0
        insufficient_indicators = 0
        atr_history: list[Decimal] = []

        for snapshot in snapshots:
            if not snapshot.has_required_indicators:
                insufficient_indicators += 1
                self.append_atr_history(snapshot, atr_history)
                continue
            try:
                signal_result = self.evaluate_snapshot_signal(snapshot, strategy, atr_history=atr_history)
            except Exception:  # noqa: BLE001
                rejected_signals += 1
                self.append_atr_history(snapshot, atr_history)
                continue

            if signal_result.signal_type == SIGNAL_BUY:
                buy_events.append(self.format_signal_marker(signal_result))
            elif signal_result.signal_type == SIGNAL_SELL:
                sell_events.append(self.format_signal_marker(signal_result))
            else:
                no_signals += 1
            self.append_atr_history(snapshot, atr_history)

        return {
            "candles_evaluated": len(snapshots),
            "buy_signals": len(buy_events),
            "sell_signals": len(sell_events),
            "no_signals": no_signals,
            "rejected_signals": rejected_signals,
            "insufficient_indicators": insufficient_indicators,
            "first_buy": buy_events[0] if buy_events else None,
            "last_buy": buy_events[-1] if buy_events else None,
            "first_sell": sell_events[0] if sell_events else None,
            "last_sell": sell_events[-1] if sell_events else None,
        }

    def build_range_payload(self, snapshots: list[BacktestSignalSnapshot]) -> dict[str, object]:
        if not snapshots:
            return {"start_timestamp": None, "end_timestamp": None, "candles": 0}
        return {
            "start_timestamp": snapshots[0].timestamp.isoformat(),
            "end_timestamp": snapshots[-1].timestamp.isoformat(),
            "candles": len(snapshots),
        }

    def build_warnings(
        self,
        *,
        candles_evaluated: int,
        signal_analysis: dict[str, object],
        total_trades: int | None = None,
    ) -> list[str]:
        warnings: list[str] = []
        tradable_signals = int(signal_analysis["buy_signals"]) + int(signal_analysis["sell_signals"])

        if candles_evaluated < self.STATISTICAL_SAMPLE_TARGET:
            warnings.append("insufficient_historical_sample")
        if candles_evaluated < self.settings.backtest_min_candles:
            warnings.append("insufficient_historical_period")
        if tradable_signals == 0:
            warnings.append("no_tradable_signal_sample")
        if total_trades is not None:
            if total_trades == 0:
                warnings.append("no_trades")
            if total_trades < 5:
                warnings.append("low_trade_count")
                warnings.append("low_statistical_sample")

        seen: set[str] = set()
        ordered: list[str] = []
        for warning in warnings:
            if warning not in seen:
                ordered.append(warning)
                seen.add(warning)
        return ordered

    def build_sectioned_response(
        self,
        *,
        result: BacktestResult,
        signal_analysis: dict[str, object],
        snapshots: list[BacktestSignalSnapshot],
        warnings: list[str],
        run_id: int | None = None,
    ) -> dict[str, object]:
        payload = result.to_dict(run_id=run_id)
        payload.update(
            {
                "range": self.build_range_payload(snapshots),
                "summary": {
                    "initial_cash": format_decimal(result.initial_cash),
                    "final_cash": format_decimal(result.final_cash),
                    "final_equity": format_decimal(result.final_equity),
                    "strategy_return": format_decimal(result.strategy_return),
                    "total_trades": result.total_trades,
                    "winning_trades": result.winning_trades,
                    "losing_trades": result.losing_trades,
                    "win_rate": format_decimal(result.win_rate),
                    "net_profit": format_decimal(result.net_profit),
                },
                "signals": signal_analysis,
                "trades": {
                    "total_trades": result.total_trades,
                    "total_trade_records": len(result.trades),
                    "closed_trade_records": result.closed_trade_records,
                    "open_trade_records": result.open_trade_records,
                    "profit_factor": format_decimal(result.profit_factor),
                    "average_trade": format_decimal(result.average_trade),
                    "median_trade": format_decimal(result.median_trade),
                    "best_trade": format_decimal(result.best_trade),
                    "worst_trade": format_decimal(result.worst_trade),
                    "average_winner": format_decimal(result.average_winner),
                    "average_loser": format_decimal(result.average_loser),
                    "expectancy": format_decimal(result.expectancy),
                },
                "risk": {
                    "max_drawdown": format_decimal(result.max_drawdown),
                    "max_drawdown_percent": format_decimal(result.max_drawdown_percent),
                    "total_commissions": format_decimal(result.total_commissions),
                    "exposure_time_percent": format_decimal(result.exposure_time_percent),
                },
                "benchmark": {
                    "buy_and_hold_return": format_decimal(result.buy_and_hold_return),
                    "strategy_return": format_decimal(result.strategy_return),
                    "strategy_minus_buy_hold": format_decimal(result.strategy_minus_buy_hold),
                },
                "warnings": warnings,
            }
        )
        return payload

    def build_segment_report(
        self,
        *,
        label: str,
        snapshots: list[BacktestSignalSnapshot],
        strategy: str,
        initial_cash: Decimal,
    ) -> dict[str, object]:
        signal_analysis = self.analyze_snapshots(snapshots, strategy=strategy)
        payload: dict[str, object] = {
            "label": label,
            "range": self.build_range_payload(snapshots),
            "signals": signal_analysis,
        }

        if not snapshots or not any(snapshot.has_required_indicators for snapshot in snapshots):
            payload.update(
                {
                    "summary": None,
                    "trades": None,
                    "risk": None,
                    "benchmark": None,
                    "warnings": self.build_warnings(candles_evaluated=len(snapshots), signal_analysis=signal_analysis, total_trades=0),
                }
            )
            return payload

        result = self.engine.run(
            snapshots=snapshots,
            strategy=strategy,
            initial_cash=initial_cash,
            commission_rate=self.settings.paper_commission_rate,
        )
        warnings = self.build_warnings(candles_evaluated=len(snapshots), signal_analysis=signal_analysis, total_trades=result.total_trades)
        payload.update(
            {
                "summary": {
                    "initial_cash": format_decimal(result.initial_cash),
                    "final_equity": format_decimal(result.final_equity),
                    "strategy_return": format_decimal(result.strategy_return),
                    "total_trades": result.total_trades,
                    "winning_trades": result.winning_trades,
                    "losing_trades": result.losing_trades,
                    "win_rate": format_decimal(result.win_rate),
                    "net_profit": format_decimal(result.net_profit),
                },
                "trades": {
                    "profit_factor": format_decimal(result.profit_factor),
                    "average_trade": format_decimal(result.average_trade),
                    "median_trade": format_decimal(result.median_trade),
                    "best_trade": format_decimal(result.best_trade),
                    "worst_trade": format_decimal(result.worst_trade),
                    "average_winner": format_decimal(result.average_winner),
                    "average_loser": format_decimal(result.average_loser),
                    "expectancy": format_decimal(result.expectancy),
                },
                "risk": {
                    "max_drawdown": format_decimal(result.max_drawdown),
                    "max_drawdown_percent": format_decimal(result.max_drawdown_percent),
                    "exposure_time_percent": format_decimal(result.exposure_time_percent),
                },
                "benchmark": {
                    "buy_and_hold_return": format_decimal(result.buy_and_hold_return),
                    "strategy_return": format_decimal(result.strategy_return),
                    "strategy_minus_buy_hold": format_decimal(result.strategy_minus_buy_hold),
                },
                "warnings": warnings,
            }
        )
        return payload

    def split_snapshots_into_periods(self, snapshots: list[BacktestSignalSnapshot], *, parts: int) -> list[list[BacktestSignalSnapshot]]:
        if parts <= 0:
            raise ValueError("parts must be greater than 0")
        if not snapshots:
            return [[] for _ in range(parts)]

        base_size, remainder = divmod(len(snapshots), parts)
        segments: list[list[BacktestSignalSnapshot]] = []
        index = 0
        for segment_index in range(parts):
            size = base_size + (1 if segment_index < remainder else 0)
            segments.append(snapshots[index:index + size])
            index += size
        return segments

    def build_period_reports(self, snapshots: list[BacktestSignalSnapshot], *, strategy: str) -> dict[str, object]:
        labels = ("Q1", "Q2", "Q3", "Q4")
        segments = self.split_snapshots_into_periods(snapshots, parts=4)
        return {
            label: self.build_segment_report(label=label, snapshots=segment, strategy=strategy, initial_cash=self.settings.backtest_initial_cash)
            for label, segment in zip(labels, segments, strict=True)
        }

    def build_walk_forward_report(self, snapshots: list[BacktestSignalSnapshot], *, strategy: str) -> dict[str, object]:
        if not snapshots:
            return {
                "split": {"train_percent": 70, "test_percent": 30},
                "train": self.build_segment_report(label="TRAIN", snapshots=[], strategy=strategy, initial_cash=self.settings.backtest_initial_cash),
                "test": self.build_segment_report(label="TEST", snapshots=[], strategy=strategy, initial_cash=self.settings.backtest_initial_cash),
            }

        split_index = max(1, int(len(snapshots) * Decimal("0.70")))
        if split_index >= len(snapshots):
            split_index = len(snapshots) - 1
        train_snapshots = snapshots[:split_index]
        test_snapshots = snapshots[split_index:]
        return {
            "split": {"train_percent": 70, "test_percent": 30},
            "train": self.build_segment_report(label="TRAIN", snapshots=train_snapshots, strategy=strategy, initial_cash=self.settings.backtest_initial_cash),
            "test": self.build_segment_report(label="TEST", snapshots=test_snapshots, strategy=strategy, initial_cash=self.settings.backtest_initial_cash),
        }

    def build_walk_forward_report_for_ratio(self, snapshots: list[BacktestSignalSnapshot], *, strategy: str, train_percent: int) -> dict[str, object]:
        if train_percent <= 0 or train_percent >= 100:
            raise ValueError("train_percent must be between 1 and 99")
        test_percent = 100 - train_percent
        if not snapshots:
            return {
                "split": {"train_percent": train_percent, "test_percent": test_percent},
                "train": self.build_segment_report(label="TRAIN", snapshots=[], strategy=strategy, initial_cash=self.settings.backtest_initial_cash),
                "test": self.build_segment_report(label="TEST", snapshots=[], strategy=strategy, initial_cash=self.settings.backtest_initial_cash),
            }

        split_index = max(1, int(len(snapshots) * Decimal(train_percent) / Decimal("100")))
        if split_index >= len(snapshots):
            split_index = len(snapshots) - 1
        train_snapshots = snapshots[:split_index]
        test_snapshots = snapshots[split_index:]
        return {
            "split": {"train_percent": train_percent, "test_percent": test_percent},
            "train": self.build_segment_report(label="TRAIN", snapshots=train_snapshots, strategy=strategy, initial_cash=self.settings.backtest_initial_cash),
            "test": self.build_segment_report(label="TEST", snapshots=test_snapshots, strategy=strategy, initial_cash=self.settings.backtest_initial_cash),
        }

    def persist_result(
        self,
        session: Session,
        *,
        asset_id: int,
        timeframe: str,
        strategy: str,
        start_timestamp: datetime,
        end_timestamp: datetime,
        result: BacktestResult,
    ) -> BacktestRun:
        run = BacktestRun(
            asset_id=asset_id,
            timeframe=timeframe,
            strategy=strategy,
            start_timestamp=start_timestamp,
            end_timestamp=end_timestamp,
            initial_cash=result.initial_cash,
            final_cash=result.final_cash,
            final_equity=result.final_equity,
            total_return=result.total_return,
            total_trades=result.total_trades,
            winning_trades=result.winning_trades,
            losing_trades=result.losing_trades,
            win_rate=result.win_rate,
            gross_profit=result.gross_profit,
            gross_loss=result.gross_loss,
            net_profit=result.net_profit,
            total_commissions=result.total_commissions,
            max_drawdown=result.max_drawdown,
            max_drawdown_percent=result.max_drawdown_percent,
            average_trade=result.average_trade,
            profit_factor=result.profit_factor,
            buy_and_hold_return=result.buy_and_hold_return,
            configuration=result.configuration,
        )
        session.add(run)
        session.flush()

        for trade in result.trades:
            session.add(
                BacktestTrade(
                    backtest_run_id=run.id,
                    asset_id=trade.asset_id,
                    entry_timestamp=trade.entry_timestamp,
                    entry_price=trade.entry_price,
                    exit_timestamp=trade.exit_timestamp,
                    exit_price=trade.exit_price,
                    quantity=trade.quantity,
                    commission_entry=trade.commission_entry,
                    commission_exit=trade.commission_exit,
                    commission_total=trade.commission_total,
                    gross_pnl=trade.gross_pnl,
                    net_pnl=trade.net_pnl,
                    return_percent=trade.return_percent,
                    status=trade.status,
                )
            )

        for point in result.equity_curve:
            session.add(
                BacktestEquity(
                    backtest_run_id=run.id,
                    timestamp=point.timestamp,
                    cash=point.cash,
                    market_value=point.market_value,
                    equity=point.equity,
                    unrealized_pnl=point.unrealized_pnl,
                    drawdown=point.drawdown,
                    drawdown_percent=point.drawdown_percent,
                )
            )

        session.flush()
        return run

    def prepare_range_inputs(
        self,
        session: Session,
        *,
        asset_id: int,
        timeframe: str,
        strategy: str,
        start_timestamp: datetime,
        end_timestamp: datetime,
        indicator_names: tuple[str, ...] | None = None,
    ) -> tuple[Asset, list[BacktestSignalSnapshot]]:
        BacktestingValidator.validate_request(start_timestamp=start_timestamp, end_timestamp=end_timestamp)
        asset = self.get_asset(session, asset_id=asset_id)
        if asset is None:
            raise BacktestingValidationError("asset_not_found")
        if strategy not in VALID_STRATEGIES:
            raise BacktestingValidationError("strategy_not_found")

        market_rows = self.load_market_rows(session, asset_id=asset_id, timeframe=timeframe, start_timestamp=start_timestamp, end_timestamp=end_timestamp)
        if not market_rows:
            raise BacktestingValidationError("range_without_data")

        indicator_rows = self.load_indicator_rows(
            session,
            asset_id=asset_id,
            timeframe=timeframe,
            start_timestamp=start_timestamp,
            end_timestamp=end_timestamp,
            indicator_names=indicator_names or self.get_required_indicator_names(strategy),
        )
        snapshots = self.build_snapshots(asset=asset, timeframe=timeframe, market_rows=market_rows, indicator_rows=indicator_rows)
        BacktestingValidator.validate_market_snapshots(snapshots)
        return asset, snapshots

    def analyze_backtest(
        self,
        session: Session,
        *,
        asset_id: int,
        timeframe: str,
        strategy: str,
        start_timestamp: datetime,
        end_timestamp: datetime,
    ) -> dict[str, object]:
        _, snapshots = self.prepare_range_inputs(
            session,
            asset_id=asset_id,
            timeframe=timeframe,
            strategy=strategy,
            start_timestamp=start_timestamp,
            end_timestamp=end_timestamp,
        )
        signal_analysis = self.analyze_snapshots(snapshots, strategy=strategy)
        warnings = self.build_warnings(candles_evaluated=len(snapshots), signal_analysis=signal_analysis, total_trades=None)
        payload = dict(signal_analysis)
        payload["warnings"] = warnings
        payload["range"] = self.build_range_payload(snapshots)
        return payload

    @staticmethod
    def calculate_holding_minutes(trade: BacktestTradeRecord) -> int | None:
        if trade.exit_timestamp is None:
            return None
        return int((trade.exit_timestamp - trade.entry_timestamp).total_seconds() // 60)

    @staticmethod
    def classify_rsi_band(rsi_value: Decimal | None) -> str | None:
        if rsi_value is None:
            return None
        if rsi_value < Decimal("30"):
            return "<30"
        if rsi_value < Decimal("50"):
            return "30-50"
        if rsi_value <= Decimal("70"):
            return "50-70"
        return ">70"

    @staticmethod
    def classify_macd_sign(macd_value: Decimal | None) -> str | None:
        if macd_value is None:
            return None
        if macd_value > 0:
            return "positive"
        if macd_value < 0:
            return "negative"
        return "zero"

    @staticmethod
    def classify_ema_relation(ema20: Decimal | None, ema50: Decimal | None) -> str | None:
        if ema20 is None or ema50 is None:
            return None
        if ema20 > ema50:
            return "EMA20_GT_EMA50"
        if ema20 < ema50:
            return "EMA20_LT_EMA50"
        return "EMA20_EQ_EMA50"

    def build_indicator_bundle(self, snapshot: BacktestSignalSnapshot | None) -> dict[str, str | None]:
        indicator_values = snapshot.indicator_values if snapshot is not None else {}
        return {
            "EMA20": format_decimal(indicator_values.get("EMA_20")),
            "EMA50": format_decimal(indicator_values.get("EMA_50")),
            "RSI14": format_decimal(indicator_values.get("RSI_14")),
            "MACD": format_decimal(indicator_values.get("MACD")),
            "MACD_SIGNAL": format_decimal(indicator_values.get("MACD_SIGNAL")),
            "MACD_HISTOGRAM": format_decimal(indicator_values.get("MACD_HISTOGRAM")),
            "ATR14": format_decimal(indicator_values.get("ATR_14")),
        }

    def build_market_context_snapshot(self, snapshot: BacktestSignalSnapshot | None) -> dict[str, str | None]:
        indicator_values = snapshot.indicator_values if snapshot is not None else {}
        ema20 = indicator_values.get("EMA_20")
        ema50 = indicator_values.get("EMA_50")
        rsi14 = indicator_values.get("RSI_14")
        macd = indicator_values.get("MACD")
        return {
            "ema_relation": self.classify_ema_relation(ema20, ema50),
            "rsi_band": self.classify_rsi_band(rsi14),
            "macd_sign": self.classify_macd_sign(macd),
        }

    def build_trade_details(self, *, result: BacktestResult, snapshots: list[BacktestSignalSnapshot]) -> list[dict[str, Any]]:
        snapshots_by_timestamp = {snapshot.timestamp: snapshot for snapshot in snapshots}
        details: list[dict[str, Any]] = []

        for trade in result.trades:
            if trade.status != "CLOSED" or trade.exit_timestamp is None:
                continue

            entry_snapshot = snapshots_by_timestamp.get(trade.entry_timestamp)
            exit_snapshot = snapshots_by_timestamp.get(trade.exit_timestamp)
            holding_minutes = self.calculate_holding_minutes(trade)
            details.append(
                {
                    "trade": trade,
                    "entry_snapshot": entry_snapshot,
                    "exit_snapshot": exit_snapshot,
                    "holding_minutes": holding_minutes,
                    "entry_indicators": self.build_indicator_bundle(entry_snapshot),
                    "exit_indicators": self.build_indicator_bundle(exit_snapshot),
                    "entry_context": self.build_market_context_snapshot(entry_snapshot),
                    "exit_context": self.build_market_context_snapshot(exit_snapshot),
                }
            )

        return details

    def serialize_trade_details(self, details: list[dict[str, Any]]) -> list[dict[str, object]]:
        payload: list[dict[str, object]] = []
        for detail in details:
            trade: BacktestTradeRecord = detail["trade"]
            payload.append(
                {
                    "entry_timestamp": trade.entry_timestamp.isoformat(),
                    "entry_price": format_decimal(trade.entry_price),
                    "exit_timestamp": trade.exit_timestamp.isoformat() if trade.exit_timestamp else None,
                    "exit_price": format_decimal(trade.exit_price),
                    "quantity": format_decimal(trade.quantity),
                    "gross_pnl": format_decimal(trade.gross_pnl),
                    "commission": format_decimal(trade.commission_total),
                    "net_pnl": format_decimal(trade.net_pnl),
                    "return_percent": format_decimal(trade.return_percent),
                    "holding_time_minutes": detail["holding_minutes"],
                    "entry_indicators": detail["entry_indicators"],
                    "exit_indicators": detail["exit_indicators"],
                    "entry_context": detail["entry_context"],
                    "exit_context": detail["exit_context"],
                }
            )
        return payload

    def summarize_decimal_series(self, values: list[Decimal]) -> dict[str, str | None]:
        if not values:
            return {"min": None, "max": None, "average": None, "median": None}
        return {
            "min": format_decimal(min(values)),
            "max": format_decimal(max(values)),
            "average": format_decimal(BacktestingMetrics.average(values)),
            "median": format_decimal(BacktestingMetrics.median(values)),
        }

    def summarize_holding_minutes(self, details: list[dict[str, Any]]) -> dict[str, str | None]:
        values = [Decimal(detail["holding_minutes"]) for detail in details if detail["holding_minutes"] is not None]
        return self.summarize_decimal_series(values)

    def build_indicator_statistics(self, details: list[dict[str, Any]], *, snapshot_key: str) -> dict[str, dict[str, str | None]]:
        indicator_names = {
            "EMA20": "EMA_20",
            "EMA50": "EMA_50",
            "RSI14": "RSI_14",
            "MACD": "MACD",
            "MACD_SIGNAL": "MACD_SIGNAL",
            "MACD_HISTOGRAM": "MACD_HISTOGRAM",
            "ATR14": "ATR_14",
        }
        output: dict[str, dict[str, str | None]] = {}
        for label, internal_name in indicator_names.items():
            values = [
                snapshot.indicator_values[internal_name]
                for detail in details
                for snapshot in [detail[snapshot_key]]
                if snapshot is not None and internal_name in snapshot.indicator_values
            ]
            output[label] = {
                "average": format_decimal(BacktestingMetrics.average(values)),
                "median": format_decimal(BacktestingMetrics.median(values)),
            }
        return output

    def build_trade_distribution(self, details: list[dict[str, Any]]) -> dict[str, int]:
        buckets: dict[str, int] = {
            "<-5%": 0,
            "-5% a -2%": 0,
            "-2% a -1%": 0,
            "-1% a 0%": 0,
            "0% a 1%": 0,
            "1% a 2%": 0,
            "2% a 5%": 0,
            ">5%": 0,
        }
        for detail in details:
            trade: BacktestTradeRecord = detail["trade"]
            if trade.return_percent is None:
                continue
            value = trade.return_percent
            if value < Decimal("-0.05"):
                buckets["<-5%"] += 1
            elif value < Decimal("-0.02"):
                buckets["-5% a -2%"] += 1
            elif value < Decimal("-0.01"):
                buckets["-2% a -1%"] += 1
            elif value < Decimal("0"):
                buckets["-1% a 0%"] += 1
            elif value < Decimal("0.01"):
                buckets["0% a 1%"] += 1
            elif value < Decimal("0.02"):
                buckets["1% a 2%"] += 1
            elif value <= Decimal("0.05"):
                buckets["2% a 5%"] += 1
            else:
                buckets[">5%"] += 1
        return buckets

    def build_streaks(self, details: list[dict[str, Any]]) -> dict[str, object]:
        ordered_details = sorted(details, key=lambda detail: detail["trade"].entry_timestamp)
        winning_streaks: list[int] = []
        losing_streaks: list[int] = []
        current_outcome: str | None = None
        current_length = 0

        for detail in ordered_details:
            trade: BacktestTradeRecord = detail["trade"]
            if trade.net_pnl > 0:
                outcome = "win"
            elif trade.net_pnl < 0:
                outcome = "loss"
            else:
                outcome = "flat"

            if outcome == current_outcome:
                current_length += 1
                continue

            if current_outcome == "win" and current_length > 0:
                winning_streaks.append(current_length)
            elif current_outcome == "loss" and current_length > 0:
                losing_streaks.append(current_length)

            current_outcome = outcome
            current_length = 1 if outcome in {"win", "loss"} else 0

        if current_outcome == "win" and current_length > 0:
            winning_streaks.append(current_length)
        elif current_outcome == "loss" and current_length > 0:
            losing_streaks.append(current_length)

        return {
            "max_consecutive_wins": max(winning_streaks, default=0),
            "max_consecutive_losses": max(losing_streaks, default=0),
            "winning_streaks": winning_streaks,
            "losing_streaks": losing_streaks,
        }

    def build_context_bucket_summary(self, details: list[dict[str, Any]]) -> dict[str, object]:
        if not details:
            return {
                "trades": 0,
                "winning_trades": 0,
                "losing_trades": 0,
                "win_rate": None,
                "net_profit": None,
                "average_return": None,
                "median_return": None,
            }

        trade_returns = [trade.return_percent for detail in details for trade in [detail["trade"]] if trade.return_percent is not None]
        winning_trades = sum(1 for detail in details if detail["trade"].net_pnl > 0)
        losing_trades = sum(1 for detail in details if detail["trade"].net_pnl < 0)
        return {
            "trades": len(details),
            "winning_trades": winning_trades,
            "losing_trades": losing_trades,
            "win_rate": format_decimal(quantize_value(Decimal(winning_trades) / Decimal(len(details)))),
            "net_profit": format_decimal(sum((detail["trade"].net_pnl for detail in details), Decimal("0"))),
            "average_return": format_decimal(BacktestingMetrics.average(trade_returns)),
            "median_return": format_decimal(BacktestingMetrics.median(trade_returns)),
        }

    def build_market_context(self, details: list[dict[str, Any]]) -> dict[str, object]:
        ema_buckets = {
            "EMA20_GT_EMA50": [],
            "EMA20_LT_EMA50": [],
            "EMA20_EQ_EMA50": [],
        }
        rsi_buckets = {
            "<30": [],
            "30-50": [],
            "50-70": [],
            ">70": [],
        }
        macd_buckets = {
            "positive": [],
            "negative": [],
            "zero": [],
        }

        for detail in details:
            context = detail["entry_context"]
            ema_relation = context["ema_relation"]
            rsi_band = context["rsi_band"]
            macd_sign = context["macd_sign"]
            if ema_relation in ema_buckets:
                ema_buckets[ema_relation].append(detail)
            if rsi_band in rsi_buckets:
                rsi_buckets[rsi_band].append(detail)
            if macd_sign in macd_buckets:
                macd_buckets[macd_sign].append(detail)

        return {
            "entry_context": {
                "ema_relation": {label: self.build_context_bucket_summary(bucket_details) for label, bucket_details in ema_buckets.items()},
                "rsi_band": {label: self.build_context_bucket_summary(bucket_details) for label, bucket_details in rsi_buckets.items()},
                "macd_sign": {label: self.build_context_bucket_summary(bucket_details) for label, bucket_details in macd_buckets.items()},
            }
        }

    def build_cost_analysis(self, result: BacktestResult) -> dict[str, object]:
        gross_edge_before_commissions = result.gross_profit + result.gross_loss
        cost_to_gross_edge = None
        if gross_edge_before_commissions != 0:
            cost_to_gross_edge = format_decimal(result.total_commissions / abs(gross_edge_before_commissions))
        return {
            "gross_profit": format_decimal(result.gross_profit),
            "gross_loss": format_decimal(result.gross_loss),
            "gross_edge_before_commissions": format_decimal(gross_edge_before_commissions),
            "commissions": format_decimal(result.total_commissions),
            "net_profit": format_decimal(result.net_profit),
            "commissions_to_gross_edge_ratio": cost_to_gross_edge,
            "commissions_exceed_gross_edge": result.total_commissions > abs(gross_edge_before_commissions),
        }

    def build_strategy_definitions(self) -> dict[str, dict[str, object]]:
        return {
            BASELINE_TREND_RSI: {
                "hypothesis": "Control sin cambios.",
                "changes_from_baseline": 0,
                "parameters_introduced": [],
                "defined_pre_backtest": True,
                "control": True,
            },
            BASELINE_TREND_RSI_MACD_POSITIVE: {
                "hypothesis": "Reducir compras en contexto MACD negativo manteniendo el resto del baseline intacto.",
                "changes_from_baseline": 1,
                "parameters_introduced": [],
                "defined_pre_backtest": True,
                "control": False,
            },
            BASELINE_TREND_RSI_ATR_FILTER: {
                "hypothesis": "Evitar nuevas entradas cuando la volatilidad actual supere la mediana expansiva de ATR14 observada hasta el timestamp evaluado.",
                "changes_from_baseline": 1,
                "parameters_introduced": [],
                "defined_pre_backtest": True,
                "control": False,
            },
            BASELINE_TREND_RSI_STRICT_TREND: {
                "hypothesis": "Exigir confirmacion adicional de tendencia con el cierre alineado por encima/debajo de EMA20.",
                "changes_from_baseline": 1,
                "parameters_introduced": [],
                "defined_pre_backtest": True,
                "control": False,
            },
        }

    def build_strategy_metrics(self, *, result: BacktestResult, snapshots: list[BacktestSignalSnapshot]) -> dict[str, object]:
        details = self.build_trade_details(result=result, snapshots=snapshots)
        winning_details = [detail for detail in details if detail["trade"].net_pnl > 0]
        losing_details = [detail for detail in details if detail["trade"].net_pnl < 0]
        return {
            "trades": result.total_trades,
            "win_rate": format_decimal(result.win_rate),
            "net_profit": format_decimal(result.net_profit),
            "return": format_decimal(result.strategy_return),
            "profit_factor": format_decimal(result.profit_factor),
            "expectancy": format_decimal(result.expectancy),
            "max_drawdown": format_decimal(result.max_drawdown),
            "max_drawdown_percent": format_decimal(result.max_drawdown_percent),
            "gross_profit": format_decimal(result.gross_profit),
            "gross_loss": format_decimal(result.gross_loss),
            "commissions": format_decimal(result.total_commissions),
            "buy_and_hold_return": format_decimal(result.buy_and_hold_return),
            "strategy_minus_buy_hold": format_decimal(result.strategy_minus_buy_hold),
            "average_winner": format_decimal(result.average_winner),
            "average_loser": format_decimal(result.average_loser),
            "median_winner": format_decimal(BacktestingMetrics.median([detail["trade"].net_pnl for detail in winning_details])),
            "median_loser": format_decimal(BacktestingMetrics.median([detail["trade"].net_pnl for detail in losing_details])),
            "average_winner_holding": self.summarize_holding_minutes(winning_details)["average"],
            "average_loser_holding": self.summarize_holding_minutes(losing_details)["average"],
        }

    def build_strategy_report(
        self,
        *,
        strategy: str,
        snapshots: list[BacktestSignalSnapshot],
        dataset_quality: dict[str, object],
    ) -> dict[str, object]:
        definitions = self.build_strategy_definitions()
        definition = definitions[strategy]
        result = self.engine.run(
            snapshots=snapshots,
            strategy=strategy,
            initial_cash=self.settings.backtest_initial_cash,
            commission_rate=self.settings.paper_commission_rate,
        )
        period_analysis = self.build_period_analysis(snapshots, strategy=strategy)
        walk_forward = self.build_walk_forward_matrix(snapshots, strategy=strategy)
        window_analysis = self.build_window_analysis(snapshots, strategy=strategy)
        cost_analysis = self.build_cost_analysis(result)
        reproducibility = self.build_reproducibility_report(snapshots, strategy=strategy)
        profit_concentration = self.build_profit_concentration(result)
        warnings = self.build_robustness_warnings(
            dataset_quality=dataset_quality,
            window_analysis=window_analysis,
            walk_forward=walk_forward,
            cost_analysis=cost_analysis,
            profit_concentration=profit_concentration,
            reproducibility=reproducibility,
            total_trades=result.total_trades,
        )
        return {
            "strategy": strategy,
            "implemented": True,
            "control": definition["control"],
            "hypothesis": definition["hypothesis"],
            "changes_from_baseline": definition["changes_from_baseline"],
            "parameters_introduced": definition["parameters_introduced"],
            "defined_pre_backtest": definition["defined_pre_backtest"],
            "metrics": self.build_strategy_metrics(result=result, snapshots=snapshots),
            "trade_count_by_period": {label: report["trades"] for label, report in period_analysis.items()},
            "train_test_70_30": self.build_walk_forward_analysis(snapshots, strategy=strategy),
            "walk_forward": walk_forward,
            "window_analysis": window_analysis,
            "cost_analysis": cost_analysis,
            "warnings": warnings,
        }

    def build_not_implemented_variant_report(self, strategy: str, reason: str) -> dict[str, object]:
        return {
            "strategy": strategy,
            "implemented": False,
            "status": "NOT_IMPLEMENTED",
            "reason": reason,
            "changes_from_baseline": None,
            "parameters_introduced": None,
            "defined_pre_backtest": True,
        }

    def build_comparison_row(self, report: dict[str, object]) -> dict[str, object]:
        if not report.get("implemented", False):
            return {
                "strategy": report["strategy"],
                "status": report.get("status", "NOT_IMPLEMENTED"),
                "reason": report["reason"],
            }

        metrics = report["metrics"]
        test_report = report["train_test_70_30"]["test"]
        return {
            "strategy": report["strategy"],
            "status": "IMPLEMENTED",
            "trades": metrics["trades"],
            "win_rate": metrics["win_rate"],
            "net_profit": metrics["net_profit"],
            "return": metrics["return"],
            "profit_factor": metrics["profit_factor"],
            "expectancy": metrics["expectancy"],
            "max_drawdown": metrics["max_drawdown"],
            "commission": metrics["commissions"],
            "test_return": test_report["strategy_return"],
            "test_profit_factor": test_report["profit_factor"],
        }

    def build_objective_assessment(self, baseline_report: dict[str, object], variant_reports: list[dict[str, object]]) -> list[dict[str, object]]:
        baseline_metrics = baseline_report["metrics"]
        baseline_test = baseline_report["train_test_70_30"]["test"]
        baseline_costs = baseline_report["cost_analysis"]
        assessment: list[dict[str, object]] = []

        def compare_decimal_strings(current: str | None, baseline: str | None, *, higher_is_better: bool) -> str:
            if current is None or baseline is None:
                return "insufficient_sample"
            current_value = Decimal(current)
            baseline_value = Decimal(baseline)
            if higher_is_better:
                return "improved" if current_value > baseline_value else "worse_or_equal"
            return "improved" if current_value < baseline_value else "worse_or_equal"

        for report in variant_reports:
            if not report.get("implemented", False):
                assessment.append(
                    {
                        "strategy": report["strategy"],
                        "status": "NOT_IMPLEMENTED",
                        "reason": report["reason"],
                    }
                )
                continue

            metrics = report["metrics"]
            test_report = report["train_test_70_30"]["test"]
            costs = report["cost_analysis"]
            assessment.append(
                {
                    "strategy": report["strategy"],
                    "status": "IMPLEMENTED",
                    "profit_factor_vs_baseline": compare_decimal_strings(metrics["profit_factor"], baseline_metrics["profit_factor"], higher_is_better=True),
                    "expectancy_vs_baseline": compare_decimal_strings(metrics["expectancy"], baseline_metrics["expectancy"], higher_is_better=True),
                    "drawdown_vs_baseline": compare_decimal_strings(metrics["max_drawdown_percent"], baseline_metrics["max_drawdown_percent"], higher_is_better=False),
                    "test_return_vs_baseline": compare_decimal_strings(test_report["strategy_return"], baseline_test["strategy_return"], higher_is_better=True),
                    "test_profit_factor_vs_baseline": compare_decimal_strings(test_report["profit_factor"], baseline_test["profit_factor"], higher_is_better=True),
                    "commission_ratio_vs_baseline": (
                        "improved"
                        if (
                            costs["commissions_to_gross_edge_ratio"] is not None
                            and baseline_costs["commissions_to_gross_edge_ratio"] is not None
                            and Decimal(costs["commissions_to_gross_edge_ratio"]) < Decimal(baseline_costs["commissions_to_gross_edge_ratio"])
                        )
                        else "worse_or_equal"
                    ),
                    "trade_count_change": (
                        int(metrics["trades"]) - int(baseline_metrics["trades"])
                        if metrics["trades"] is not None and baseline_metrics["trades"] is not None
                        else None
                    ),
                }
            )
        return assessment

    def summarize_period_report(self, report: dict[str, object]) -> dict[str, object]:
        summary = report.get("summary") or {}
        trades = report.get("trades") or {}
        risk = report.get("risk") or {}
        return {
            "range": report.get("range"),
            "trades": summary.get("total_trades"),
            "win_rate": summary.get("win_rate"),
            "net_profit": summary.get("net_profit"),
            "strategy_return": summary.get("strategy_return"),
            "profit_factor": trades.get("profit_factor"),
            "max_drawdown": risk.get("max_drawdown"),
            "max_drawdown_percent": risk.get("max_drawdown_percent"),
            "warnings": report.get("warnings"),
        }

    def build_period_analysis(self, snapshots: list[BacktestSignalSnapshot], *, strategy: str) -> dict[str, object]:
        period_reports = self.build_period_reports(snapshots, strategy=strategy)
        return {label: self.summarize_period_report(report) for label, report in period_reports.items()}

    def build_walk_forward_analysis(self, snapshots: list[BacktestSignalSnapshot], *, strategy: str) -> dict[str, object]:
        walk_forward = self.build_walk_forward_report(snapshots, strategy=strategy)
        return {
            "split": walk_forward["split"],
            "train": self.summarize_period_report(walk_forward["train"]),
            "test": self.summarize_period_report(walk_forward["test"]),
        }

    def build_diagnostic_warnings(
        self,
        *,
        result: BacktestResult,
        signal_analysis: dict[str, object],
        cost_analysis: dict[str, object],
        period_analysis: dict[str, object],
        walk_forward_analysis: dict[str, object],
    ) -> list[str]:
        warnings = self.build_warnings(
            candles_evaluated=int(signal_analysis["candles_evaluated"]),
            signal_analysis=signal_analysis,
            total_trades=result.total_trades,
        )

        if result.profit_factor is not None and result.profit_factor < Decimal("1.10"):
            warnings.append("weak_profit_factor")
        if result.expectancy is not None and result.expectancy < 0:
            warnings.append("negative_expectancy")
        if result.win_rate < Decimal("0.35"):
            warnings.append("low_win_rate")
        if bool(cost_analysis["commissions_exceed_gross_edge"]) or (result.total_commissions > abs(result.net_profit) and result.net_profit < 0):
            warnings.append("high_cost_impact")

        period_net_profits = [
            Decimal(report["net_profit"])
            for report in period_analysis.values()
            if report["net_profit"] is not None
        ]
        if any(value > 0 for value in period_net_profits) and any(value < 0 for value in period_net_profits):
            warnings.append("period_instability")

        train_strategy_return = None
        test_strategy_return = None
        if walk_forward_analysis["train"].get("range") is not None:
            train_strategy_return = walk_forward_analysis["train"].get("strategy_return")
        if walk_forward_analysis["test"].get("range") is not None:
            test_strategy_return = walk_forward_analysis["test"].get("strategy_return")
        if train_strategy_return is not None and test_strategy_return is not None:
            if Decimal(test_strategy_return) < Decimal(train_strategy_return):
                warnings.append("out_of_sample_underperformance")

        deduped: list[str] = []
        seen: set[str] = set()
        for warning in warnings:
            if warning not in seen:
                deduped.append(warning)
                seen.add(warning)
        return deduped

    def diagnose_backtest(
        self,
        session: Session,
        *,
        asset_id: int,
        timeframe: str,
        strategy: str,
        start_timestamp: datetime,
        end_timestamp: datetime,
    ) -> dict[str, object]:
        try:
            asset, snapshots = self.prepare_range_inputs(
                session,
                asset_id=asset_id,
                timeframe=timeframe,
                strategy=strategy,
                start_timestamp=start_timestamp,
                end_timestamp=end_timestamp,
                indicator_names=self.DIAGNOSTIC_INDICATORS,
            )
            BacktestingValidator.ensure_evaluable_data(snapshots)
            signal_analysis = self.analyze_snapshots(snapshots, strategy=strategy)

            self.record_audit_event(
                session,
                event_type="backtesting.diagnostics_started",
                severity="info",
                message="Starting backtest diagnostics",
                metadata={
                    "asset_id": asset.id,
                    "asset_symbol": asset.symbol,
                    "timeframe": timeframe,
                    "strategy": strategy,
                    "start_timestamp": start_timestamp.isoformat(),
                    "end_timestamp": end_timestamp.isoformat(),
                    "candles_evaluated": len(snapshots),
                },
            )

            result = self.engine.run(
                snapshots=snapshots,
                strategy=strategy,
                initial_cash=self.settings.backtest_initial_cash,
                commission_rate=self.settings.paper_commission_rate,
            )
            trade_details = self.build_trade_details(result=result, snapshots=snapshots)
            winning_details = [detail for detail in trade_details if detail["trade"].net_pnl > 0]
            losing_details = [detail for detail in trade_details if detail["trade"].net_pnl < 0]

            period_analysis = self.build_period_analysis(snapshots, strategy=strategy)
            walk_forward_analysis = self.build_walk_forward_analysis(snapshots, strategy=strategy)
            cost_analysis = self.build_cost_analysis(result)

            summary = {
                "range": self.build_range_payload(snapshots),
                "initial_cash": format_decimal(result.initial_cash),
                "final_equity": format_decimal(result.final_equity),
                "total_trades": result.total_trades,
                "winning_trades": result.winning_trades,
                "losing_trades": result.losing_trades,
                "win_rate": format_decimal(result.win_rate),
                "net_profit": format_decimal(result.net_profit),
                "strategy_return": format_decimal(result.strategy_return),
                "profit_factor": format_decimal(result.profit_factor),
                "expectancy": format_decimal(result.expectancy),
                "buy_and_hold_return": format_decimal(result.buy_and_hold_return),
                "max_drawdown": format_decimal(result.max_drawdown),
                "max_drawdown_percent": format_decimal(result.max_drawdown_percent),
                "signals": signal_analysis,
            }

            trade_statistics = {
                "closed_trades": self.serialize_trade_details(trade_details),
                "winning_trades": result.winning_trades,
                "losing_trades": result.losing_trades,
                "average_winner": format_decimal(result.average_winner),
                "average_loser": format_decimal(result.average_loser),
                "median_winner": format_decimal(BacktestingMetrics.median([detail["trade"].net_pnl for detail in winning_details])),
                "median_loser": format_decimal(BacktestingMetrics.median([detail["trade"].net_pnl for detail in losing_details])),
                "best_trade": format_decimal(result.best_trade),
                "worst_trade": format_decimal(result.worst_trade),
                "average_holding_time_winner_minutes": self.summarize_holding_minutes(winning_details)["average"],
                "average_holding_time_loser_minutes": self.summarize_holding_minutes(losing_details)["average"],
                "distribution": self.build_trade_distribution(trade_details),
            }

            entry_analysis = {
                "winning_trades": {
                    "count": len(winning_details),
                    "indicators": self.build_indicator_statistics(winning_details, snapshot_key="entry_snapshot"),
                },
                "losing_trades": {
                    "count": len(losing_details),
                    "indicators": self.build_indicator_statistics(losing_details, snapshot_key="entry_snapshot"),
                },
            }
            exit_analysis = {
                "winning_trades": {
                    "count": len(winning_details),
                    "indicators": self.build_indicator_statistics(winning_details, snapshot_key="exit_snapshot"),
                },
                "losing_trades": {
                    "count": len(losing_details),
                    "indicators": self.build_indicator_statistics(losing_details, snapshot_key="exit_snapshot"),
                },
            }
            holding_time = {
                "overall": self.summarize_holding_minutes(trade_details),
                "winning_trades": self.summarize_holding_minutes(winning_details),
                "losing_trades": self.summarize_holding_minutes(losing_details),
            }
            streaks = self.build_streaks(trade_details)
            market_context = self.build_market_context(trade_details)
            warnings = self.build_diagnostic_warnings(
                result=result,
                signal_analysis=signal_analysis,
                cost_analysis=cost_analysis,
                period_analysis=period_analysis,
                walk_forward_analysis=walk_forward_analysis,
            )

            payload = {
                "summary": summary,
                "trade_statistics": trade_statistics,
                "entry_analysis": entry_analysis,
                "exit_analysis": exit_analysis,
                "holding_time": holding_time,
                "streaks": streaks,
                "market_context": market_context,
                "cost_analysis": cost_analysis,
                "period_analysis": period_analysis,
                "walk_forward": walk_forward_analysis,
                "warnings": warnings,
            }

            self.record_audit_event(
                session,
                event_type="backtesting.diagnostics_completed",
                severity="info",
                message="Backtest diagnostics completed",
                metadata={
                    "asset_id": asset.id,
                    "asset_symbol": asset.symbol,
                    "strategy": strategy,
                    "total_trades": result.total_trades,
                    "net_profit": format_decimal(result.net_profit),
                    "warnings": warnings,
                },
            )
            return payload
        except BacktestingValidationError as exc:
            self.record_audit_event(
                session,
                event_type="backtesting.diagnostics_rejected",
                severity="warning",
                message="Backtest diagnostics rejected",
                metadata={
                    "asset_id": asset_id,
                    "timeframe": timeframe,
                    "strategy": strategy,
                    "reason": str(exc),
                },
            )
            raise
        except Exception as exc:  # noqa: BLE001
            self.record_error_event(asset_id=asset_id, strategy=strategy, error=str(exc))
            raise

    @staticmethod
    def calculate_trade_return_percent(pnl: Decimal | None, trade: BacktestTradeRecord) -> Decimal | None:
        if pnl is None:
            return None
        entry_notional = quantize_value(trade.entry_price * trade.quantity)
        if entry_notional <= 0:
            return None
        return quantize_value(pnl / entry_notional)

    def build_atr_expanding_median_map(self, snapshots: list[BacktestSignalSnapshot]) -> dict[datetime, Decimal | None]:
        atr_history: list[Decimal] = []
        atr_expanding_median_by_timestamp: dict[datetime, Decimal | None] = {}
        for snapshot in snapshots:
            atr_14 = snapshot.indicator_values.get("ATR_14")
            atr_expanding_median_by_timestamp[snapshot.timestamp] = BacktestingMetrics.median([*atr_history, atr_14]) if atr_14 is not None else None
            self.append_atr_history(snapshot, atr_history)
        return atr_expanding_median_by_timestamp

    def build_signal_results_by_timestamp(
        self,
        snapshots: list[BacktestSignalSnapshot],
        *,
        strategy: str,
    ) -> dict[datetime, SignalEvaluationResult]:
        signal_results: dict[datetime, SignalEvaluationResult] = {}
        atr_history: list[Decimal] = []
        for snapshot in snapshots:
            if snapshot.has_required_indicators:
                signal_results[snapshot.timestamp] = self.evaluate_snapshot_signal(snapshot, strategy, atr_history=atr_history)
            self.append_atr_history(snapshot, atr_history)
        return signal_results

    @staticmethod
    def build_previous_snapshot_map(snapshots: list[BacktestSignalSnapshot]) -> dict[datetime, BacktestSignalSnapshot | None]:
        previous_snapshot_map: dict[datetime, BacktestSignalSnapshot | None] = {}
        previous_snapshot: BacktestSignalSnapshot | None = None
        for snapshot in snapshots:
            previous_snapshot_map[snapshot.timestamp] = previous_snapshot
            previous_snapshot = snapshot
        return previous_snapshot_map

    @staticmethod
    def calculate_indicator_slope(
        snapshot: BacktestSignalSnapshot | None,
        previous_snapshot: BacktestSignalSnapshot | None,
        indicator_name: str,
    ) -> Decimal | None:
        if snapshot is None or previous_snapshot is None:
            return None
        current_value = snapshot.indicator_values.get(indicator_name)
        previous_value = previous_snapshot.indicator_values.get(indicator_name)
        if current_value is None or previous_value is None:
            return None
        return quantize_value(current_value - previous_value)

    @staticmethod
    def calculate_indicator_distance(snapshot: BacktestSignalSnapshot | None, left: str, right: str) -> Decimal | None:
        if snapshot is None:
            return None
        left_value = snapshot.indicator_values.get(left)
        right_value = snapshot.indicator_values.get(right)
        if left_value is None or right_value is None:
            return None
        return quantize_value(left_value - right_value)

    def classify_trend_regime(self, snapshot: BacktestSignalSnapshot | None) -> str:
        relation = self.classify_ema_relation(
            snapshot.indicator_values.get("EMA_20") if snapshot is not None else None,
            snapshot.indicator_values.get("EMA_50") if snapshot is not None else None,
        )
        if relation == "EMA20_GT_EMA50":
            return "positive"
        if relation == "EMA20_LT_EMA50":
            return "negative"
        if relation == "EMA20_EQ_EMA50":
            return "neutral"
        return "unavailable"

    def classify_volatility_regime(
        self,
        snapshot: BacktestSignalSnapshot | None,
        *,
        atr_expanding_median_by_timestamp: dict[datetime, Decimal | None],
    ) -> str:
        if snapshot is None:
            return "unavailable"
        atr_14 = snapshot.indicator_values.get("ATR_14")
        atr_expanding_median = atr_expanding_median_by_timestamp.get(snapshot.timestamp)
        if atr_14 is None or atr_expanding_median is None:
            return "unavailable"
        return "high" if atr_14 > atr_expanding_median else "low"

    def build_trade_regime_snapshot(
        self,
        snapshot: BacktestSignalSnapshot | None,
        *,
        atr_expanding_median_by_timestamp: dict[datetime, Decimal | None],
    ) -> dict[str, str | None]:
        if snapshot is None:
            return {
                "trend": "unavailable",
                "volatility": "unavailable",
                "ema_relation": None,
                "atr_14": None,
                "atr_expanding_median": None,
            }
        return {
            "trend": self.classify_trend_regime(snapshot),
            "volatility": self.classify_volatility_regime(snapshot, atr_expanding_median_by_timestamp=atr_expanding_median_by_timestamp),
            "ema_relation": self.classify_ema_relation(snapshot.indicator_values.get("EMA_20"), snapshot.indicator_values.get("EMA_50")),
            "atr_14": format_decimal(snapshot.indicator_values.get("ATR_14")),
            "atr_expanding_median": format_decimal(atr_expanding_median_by_timestamp.get(snapshot.timestamp)),
        }

    def build_trade_indicator_snapshot(
        self,
        snapshot: BacktestSignalSnapshot | None,
        *,
        previous_snapshot: BacktestSignalSnapshot | None,
    ) -> dict[str, str | None]:
        indicator_values = self.build_indicator_bundle(snapshot)
        indicator_values.update(
            {
                "EMA20_EMA50_DISTANCE": format_decimal(self.calculate_indicator_distance(snapshot, "EMA_20", "EMA_50")),
                "EMA20_SLOPE": format_decimal(self.calculate_indicator_slope(snapshot, previous_snapshot, "EMA_20")),
                "EMA50_SLOPE": format_decimal(self.calculate_indicator_slope(snapshot, previous_snapshot, "EMA_50")),
            }
        )
        return indicator_values

    @staticmethod
    def build_trade_path_snapshots(
        trade: BacktestTradeRecord,
        snapshots: list[BacktestSignalSnapshot],
        *,
        timestamp_index: dict[datetime, int],
    ) -> list[BacktestSignalSnapshot]:
        entry_index = timestamp_index.get(trade.entry_timestamp)
        if entry_index is None:
            return []
        if trade.exit_timestamp is None:
            return snapshots[entry_index:]
        exit_index = timestamp_index.get(trade.exit_timestamp)
        if exit_index is None or exit_index < entry_index:
            return snapshots[entry_index:]
        return snapshots[entry_index:exit_index + 1]

    def calculate_trade_excursions(
        self,
        trade: BacktestTradeRecord,
        *,
        path_snapshots: list[BacktestSignalSnapshot],
    ) -> dict[str, Decimal | None]:
        if not path_snapshots:
            return {
                "mae_pnl": None,
                "mae_return_percent": None,
                "mfe_pnl": None,
                "mfe_return_percent": None,
            }

        adverse_excursions = [quantize_value((snapshot.low - trade.entry_price) * trade.quantity) for snapshot in path_snapshots]
        favorable_excursions = [quantize_value((snapshot.high - trade.entry_price) * trade.quantity) for snapshot in path_snapshots]
        mae_pnl = min(adverse_excursions)
        mfe_pnl = max(favorable_excursions)
        return {
            "mae_pnl": mae_pnl,
            "mae_return_percent": self.calculate_trade_return_percent(mae_pnl, trade),
            "mfe_pnl": mfe_pnl,
            "mfe_return_percent": self.calculate_trade_return_percent(mfe_pnl, trade),
        }

    @staticmethod
    def classify_exit_reason(
        trade: BacktestTradeRecord,
        exit_signal_result: SignalEvaluationResult | None,
    ) -> str:
        if trade.exit_timestamp is None:
            return "final_dataset"
        if exit_signal_result is not None and exit_signal_result.signal_type == SIGNAL_SELL:
            return "signal_contraria"
        return "otra_causa"

    def build_detailed_trade_records(
        self,
        *,
        result: BacktestResult,
        snapshots: list[BacktestSignalSnapshot],
        strategy: str,
    ) -> list[dict[str, Any]]:
        if not snapshots:
            return []

        snapshots_by_timestamp = {snapshot.timestamp: snapshot for snapshot in snapshots}
        timestamp_index = {snapshot.timestamp: index for index, snapshot in enumerate(snapshots)}
        previous_snapshot_map = self.build_previous_snapshot_map(snapshots)
        atr_expanding_median_by_timestamp = self.build_atr_expanding_median_map(snapshots)
        signal_results_by_timestamp = self.build_signal_results_by_timestamp(snapshots, strategy=strategy)

        details: list[dict[str, Any]] = []
        for trade in result.trades:
            entry_snapshot = snapshots_by_timestamp.get(trade.entry_timestamp)
            exit_snapshot = snapshots_by_timestamp.get(trade.exit_timestamp) if trade.exit_timestamp is not None else None
            entry_previous_snapshot = previous_snapshot_map.get(trade.entry_timestamp)
            exit_previous_snapshot = previous_snapshot_map.get(trade.exit_timestamp) if trade.exit_timestamp is not None else None
            path_snapshots = self.build_trade_path_snapshots(trade, snapshots, timestamp_index=timestamp_index)
            excursion_metrics = self.calculate_trade_excursions(trade, path_snapshots=path_snapshots)
            gross_return_percent = self.calculate_trade_return_percent(trade.gross_pnl, trade)
            exit_signal_result = signal_results_by_timestamp.get(trade.exit_timestamp) if trade.exit_timestamp is not None else None

            details.append(
                {
                    "trade": trade,
                    "entry_snapshot": entry_snapshot,
                    "exit_snapshot": exit_snapshot,
                    "entry_previous_snapshot": entry_previous_snapshot,
                    "exit_previous_snapshot": exit_previous_snapshot,
                    "entry_indicators": self.build_trade_indicator_snapshot(entry_snapshot, previous_snapshot=entry_previous_snapshot),
                    "exit_indicators": self.build_trade_indicator_snapshot(exit_snapshot, previous_snapshot=exit_previous_snapshot),
                    "entry_market_context": self.build_trade_regime_snapshot(
                        entry_snapshot,
                        atr_expanding_median_by_timestamp=atr_expanding_median_by_timestamp,
                    ),
                    "exit_market_context": self.build_trade_regime_snapshot(
                        exit_snapshot,
                        atr_expanding_median_by_timestamp=atr_expanding_median_by_timestamp,
                    ),
                    "entry_context": self.build_market_context_snapshot(entry_snapshot),
                    "exit_context": self.build_market_context_snapshot(exit_snapshot),
                    "holding_minutes": self.calculate_holding_minutes(trade),
                    "exit_reason": self.classify_exit_reason(trade, exit_signal_result),
                    "exit_reason_detail": exit_signal_result.reason if exit_signal_result is not None else "END_OF_DATASET",
                    "gross_return_percent": gross_return_percent,
                    "commission_percentage_of_gross_edge": (
                        quantize_value(trade.commission_total / trade.gross_pnl)
                        if trade.gross_pnl > 0
                        else None
                    ),
                    "was_profitable_without_commission": trade.gross_pnl > 0,
                    "is_profitable_after_commission": trade.net_pnl > 0,
                    "gross_edge_lower_than_cost": trade.gross_pnl > 0 and trade.gross_pnl < trade.commission_total,
                    "outcome": "WIN" if trade.net_pnl > 0 else "LOSS" if trade.net_pnl < 0 else "FLAT",
                    "path_snapshots": path_snapshots,
                    **excursion_metrics,
                }
            )

        return details

    def serialize_detailed_trade_records(self, details: list[dict[str, Any]]) -> list[dict[str, object]]:
        payload: list[dict[str, object]] = []
        for detail in details:
            trade: BacktestTradeRecord = detail["trade"]
            payload.append(
                {
                    "status": trade.status,
                    "outcome": detail["outcome"],
                    "entry_timestamp": trade.entry_timestamp.isoformat(),
                    "exit_timestamp": trade.exit_timestamp.isoformat() if trade.exit_timestamp else None,
                    "entry_price": format_decimal(trade.entry_price),
                    "exit_price": format_decimal(trade.exit_price),
                    "gross_pnl": format_decimal(trade.gross_pnl),
                    "gross_return_percent": format_decimal(detail["gross_return_percent"]),
                    "commission": format_decimal(trade.commission_total),
                    "net_pnl": format_decimal(trade.net_pnl),
                    "net_return_percent": format_decimal(trade.return_percent),
                    "holding_time_minutes": detail["holding_minutes"],
                    "mae_pnl": format_decimal(detail["mae_pnl"]),
                    "mae_return_percent": format_decimal(detail["mae_return_percent"]),
                    "mfe_pnl": format_decimal(detail["mfe_pnl"]),
                    "mfe_return_percent": format_decimal(detail["mfe_return_percent"]),
                    "commission_percentage_of_gross_edge": format_decimal(detail["commission_percentage_of_gross_edge"]),
                    "was_profitable_without_commission": detail["was_profitable_without_commission"],
                    "is_profitable_after_commission": detail["is_profitable_after_commission"],
                    "gross_edge_lower_than_cost": detail["gross_edge_lower_than_cost"],
                    "entry_indicators": detail["entry_indicators"],
                    "exit_indicators": detail["exit_indicators"],
                    "entry_context": detail["entry_context"],
                    "exit_context": detail["exit_context"],
                    "entry_market_context": detail["entry_market_context"],
                    "exit_market_context": detail["exit_market_context"],
                    "exit_reason": detail["exit_reason"],
                    "exit_reason_detail": detail["exit_reason_detail"],
                }
            )
        return payload

    def build_trade_subset_summary(self, details: list[dict[str, Any]]) -> dict[str, object]:
        trades = [detail["trade"] for detail in details]
        gross_values = [trade.gross_pnl for trade in trades]
        net_values = [trade.net_pnl for trade in trades]
        holding_values = [Decimal(detail["holding_minutes"]) for detail in details if detail["holding_minutes"] is not None]
        mae_values = [detail["mae_pnl"] for detail in details if detail["mae_pnl"] is not None]
        mfe_values = [detail["mfe_pnl"] for detail in details if detail["mfe_pnl"] is not None]
        return {
            "count": len(details),
            "gross_pnl": self.summarize_decimal_series(gross_values),
            "net_pnl": self.summarize_decimal_series(net_values),
            "holding_time_minutes": self.summarize_decimal_series(holding_values),
            "mae_pnl": self.summarize_decimal_series(mae_values),
            "mfe_pnl": self.summarize_decimal_series(mfe_values),
        }

    def build_winner_analysis(self, details: list[dict[str, Any]]) -> dict[str, object]:
        winner_details = [detail for detail in details if detail["trade"].status == "CLOSED" and detail["trade"].net_pnl > 0]
        return {
            "summary": self.build_trade_subset_summary(winner_details),
            "conditions": {
                "entry_context": self.build_market_context(winner_details)["entry_context"],
                "exit_reasons": self.build_exit_analysis(winner_details)["reason_distribution"],
            },
        }

    def build_loser_analysis(self, details: list[dict[str, Any]]) -> dict[str, object]:
        loser_details = [detail for detail in details if detail["trade"].status == "CLOSED" and detail["trade"].net_pnl < 0]
        immediate_losses = sum(1 for detail in loser_details if (detail["mfe_pnl"] or Decimal("0")) <= 0)
        previously_profitable = sum(1 for detail in loser_details if (detail["mfe_pnl"] or Decimal("0")) > 0)
        mfe_positive_significant = sum(
            1
            for detail in loser_details
            if detail["mfe_pnl"] is not None and detail["mfe_pnl"] > detail["trade"].commission_total
        )
        return {
            "summary": self.build_trade_subset_summary(loser_details),
            "classification": {
                "immediate_losses": immediate_losses,
                "previously_profitable_losses": previously_profitable,
                "significant_positive_mfe_losses": mfe_positive_significant,
                "large_mae_classification": {
                    "status": "NOT_CLASSIFIED",
                    "reason": "No se definio un umbral objetivo no arbitrario para etiquetar 'MAE grande'; se reporta la distribucion descriptiva.",
                },
                "likely_driver_breakdown": {
                    "bad_entries": immediate_losses,
                    "cost_only": sum(
                        1
                        for detail in loser_details
                        if detail["trade"].gross_pnl > 0 and detail["trade"].net_pnl <= 0
                    ),
                    "delayed_exit_after_positive_excursion": sum(
                        1
                        for detail in loser_details
                        if detail["mfe_pnl"] is not None and detail["mfe_pnl"] > detail["trade"].commission_total and detail["trade"].net_pnl < 0
                    ),
                },
            },
            "conditions": {
                "entry_context": self.build_market_context(loser_details)["entry_context"],
                "exit_reasons": self.build_exit_analysis(loser_details)["reason_distribution"],
            },
        }

    def build_holding_time_analysis(
        self,
        winner_details: list[dict[str, Any]],
        loser_details: list[dict[str, Any]],
    ) -> dict[str, object]:
        winner_average = self.summarize_holding_minutes(winner_details)["average"]
        loser_average = self.summarize_holding_minutes(loser_details)["average"]
        ratio = None
        if winner_average is not None and loser_average is not None and Decimal(loser_average) != 0:
            ratio = format_decimal(quantize_value(Decimal(winner_average) / Decimal(loser_average)))
        return {
            "winners": self.summarize_holding_minutes(winner_details),
            "losers": self.summarize_holding_minutes(loser_details),
            "comparison": {
                "winners_hold_longer_than_losers": bool(
                    winner_average is not None and loser_average is not None and Decimal(winner_average) > Decimal(loser_average)
                ),
                "winner_to_loser_average_ratio": ratio,
                "losers_with_positive_mfe": sum(1 for detail in loser_details if (detail["mfe_pnl"] or Decimal("0")) > 0),
                "losers_never_positive": sum(1 for detail in loser_details if (detail["mfe_pnl"] or Decimal("0")) <= 0),
            },
        }

    def build_trade_cost_impact_analysis(
        self,
        *,
        result: BacktestResult,
        details: list[dict[str, Any]],
    ) -> dict[str, object]:
        closed_details = [detail for detail in details if detail["trade"].status == "CLOSED"]
        profitable_without_commission = sum(1 for detail in closed_details if detail["trade"].gross_pnl > 0)
        profitable_after_commission = sum(1 for detail in closed_details if detail["trade"].net_pnl > 0)
        gross_edge_lower_than_cost = sum(1 for detail in closed_details if detail["gross_edge_lower_than_cost"])
        cost_only_loss_total = sum(
            (
                abs(detail["trade"].net_pnl)
                for detail in closed_details
                if detail["trade"].gross_pnl > 0 and detail["trade"].net_pnl <= 0
            ),
            Decimal("0"),
        )
        gross_edge_before_commissions = quantize_value(result.gross_profit + result.gross_loss)
        negative_result_due_exclusively_to_costs = None
        if result.net_profit < 0:
            negative_result_due_exclusively_to_costs = format_decimal(
                quantize_value(max(Decimal("0"), result.total_commissions - gross_edge_before_commissions) / abs(result.net_profit))
            )

        cost_buckets = {
            "commission_lt_25pct_of_gross_edge": 0,
            "commission_25_to_100pct_of_gross_edge": 0,
            "commission_gt_100pct_of_gross_edge": 0,
            "gross_edge_non_positive": 0,
        }
        for detail in closed_details:
            ratio = detail["commission_percentage_of_gross_edge"]
            if ratio is None:
                cost_buckets["gross_edge_non_positive"] += 1
                continue
            if ratio < Decimal("0.25"):
                cost_buckets["commission_lt_25pct_of_gross_edge"] += 1
            elif ratio <= Decimal("1.0"):
                cost_buckets["commission_25_to_100pct_of_gross_edge"] += 1
            else:
                cost_buckets["commission_gt_100pct_of_gross_edge"] += 1

        return {
            "overall": self.build_cost_analysis(result),
            "trade_counts": {
                "profitable_without_commission": profitable_without_commission,
                "profitable_after_commission": profitable_after_commission,
                "gross_edge_lower_than_cost": gross_edge_lower_than_cost,
            },
            "cost_impact_buckets": cost_buckets,
            "cost_only_loss_total": format_decimal(cost_only_loss_total),
            "cost_only_loss_share_of_net_result": (
                format_decimal(quantize_value(cost_only_loss_total / abs(result.net_profit)))
                if result.net_profit < 0 and cost_only_loss_total > 0
                else None
            ),
            "negative_result_due_exclusively_to_costs": negative_result_due_exclusively_to_costs,
        }

    def build_break_even_analysis(
        self,
        *,
        result: BacktestResult,
        winner_details: list[dict[str, Any]],
        loser_details: list[dict[str, Any]],
    ) -> dict[str, object]:
        average_winner = result.average_winner
        average_loser_magnitude = abs(result.average_loser) if result.average_loser is not None else None
        required_win_rate = None
        if average_winner is not None and average_loser_magnitude is not None and (average_winner + average_loser_magnitude) > 0:
            required_win_rate = quantize_value(average_loser_magnitude / (average_winner + average_loser_magnitude))

        average_winner_needed = None
        if result.win_rate > 0 and average_loser_magnitude is not None and result.win_rate < 1:
            average_winner_needed = quantize_value(((Decimal("1") - result.win_rate) * average_loser_magnitude) / result.win_rate)

        max_average_loser_magnitude = None
        if result.win_rate < 1 and average_winner is not None:
            max_average_loser_magnitude = quantize_value((result.win_rate * average_winner) / (Decimal("1") - result.win_rate))

        gross_edge_before_commissions = quantize_value(result.gross_profit + result.gross_loss)
        commission_reduction_needed = max(Decimal("0"), result.total_commissions - gross_edge_before_commissions)
        commission_reduction_needed_percent = None
        if result.total_commissions > 0:
            commission_reduction_needed_percent = quantize_value(commission_reduction_needed / result.total_commissions)

        total_closed_trades = len(winner_details) + len(loser_details)
        additional_net_per_trade_needed = None
        if total_closed_trades > 0 and result.net_profit < 0:
            additional_net_per_trade_needed = quantize_value(abs(result.net_profit) / Decimal(total_closed_trades))

        average_trade_count_reduction_feasibility = "not_required" if result.net_profit >= 0 else "not_sufficient_under_current_average_trade_profile"
        return {
            "required_win_rate_at_current_payoff": format_decimal(required_win_rate),
            "required_average_winner_at_current_win_rate": format_decimal(average_winner_needed),
            "max_average_loser_magnitude_compatible_with_break_even": format_decimal(max_average_loser_magnitude),
            "commission_reduction_needed": format_decimal(commission_reduction_needed),
            "commission_reduction_needed_percent": format_decimal(commission_reduction_needed_percent),
            "additional_net_per_trade_needed": format_decimal(additional_net_per_trade_needed),
            "trade_count_reduction_for_break_even": {
                "status": average_trade_count_reduction_feasibility,
                "reason": (
                    "Reducir solo la cantidad de operaciones, manteniendo el mismo perfil promedio por trade, no cambia el signo del expectancy neto."
                    if average_trade_count_reduction_feasibility == "not_sufficient_under_current_average_trade_profile"
                    else None
                ),
            },
        }

    def build_statistical_comparison(
        self,
        *,
        winner_details: list[dict[str, Any]],
        loser_details: list[dict[str, Any]],
        value_getter,
    ) -> dict[str, object]:
        winner_values = [value for detail in winner_details for value in [value_getter(detail)] if value is not None]
        loser_values = [value for detail in loser_details for value in [value_getter(detail)] if value is not None]
        return {
            "wins": self.summarize_decimal_series(winner_values),
            "losses": self.summarize_decimal_series(loser_values),
        }

    def build_trade_entry_analysis(
        self,
        *,
        winner_details: list[dict[str, Any]],
        loser_details: list[dict[str, Any]],
    ) -> dict[str, object]:
        entry_metric_getters = {
            "RSI14": lambda detail: detail["entry_snapshot"].indicator_values.get("RSI_14") if detail["entry_snapshot"] is not None else None,
            "MACD": lambda detail: detail["entry_snapshot"].indicator_values.get("MACD") if detail["entry_snapshot"] is not None else None,
            "MACD_HISTOGRAM": lambda detail: detail["entry_snapshot"].indicator_values.get("MACD_HISTOGRAM") if detail["entry_snapshot"] is not None else None,
            "EMA20": lambda detail: detail["entry_snapshot"].indicator_values.get("EMA_20") if detail["entry_snapshot"] is not None else None,
            "EMA50": lambda detail: detail["entry_snapshot"].indicator_values.get("EMA_50") if detail["entry_snapshot"] is not None else None,
            "EMA20_EMA50_DISTANCE": lambda detail: self.calculate_indicator_distance(detail["entry_snapshot"], "EMA_20", "EMA_50"),
            "ATR14": lambda detail: detail["entry_snapshot"].indicator_values.get("ATR_14") if detail["entry_snapshot"] is not None else None,
            "EMA20_SLOPE": lambda detail: self.calculate_indicator_slope(detail["entry_snapshot"], detail["entry_previous_snapshot"], "EMA_20"),
            "EMA50_SLOPE": lambda detail: self.calculate_indicator_slope(detail["entry_snapshot"], detail["entry_previous_snapshot"], "EMA_50"),
            "HOLDING_TIME_MINUTES": lambda detail: Decimal(detail["holding_minutes"]) if detail["holding_minutes"] is not None else None,
        }
        return {
            "win_vs_loss": {
                label: self.build_statistical_comparison(
                    winner_details=winner_details,
                    loser_details=loser_details,
                    value_getter=value_getter,
                )
                for label, value_getter in entry_metric_getters.items()
            }
        }

    def build_exit_analysis(self, details: list[dict[str, Any]]) -> dict[str, object]:
        closed_details = [detail for detail in details if detail["trade"].status == "CLOSED"]
        reason_distribution = {
            "signal_contraria": 0,
            "condicion_tecnica": 0,
            "final_dataset": 0,
            "otra_causa": 0,
        }
        for detail in closed_details:
            reason = detail["exit_reason"]
            if reason in reason_distribution:
                reason_distribution[reason] += 1
            else:
                reason_distribution["otra_causa"] += 1
        return {
            "reason_distribution": reason_distribution,
            "losing_trade_reason_distribution": {
                key: sum(
                    1
                    for detail in closed_details
                    if detail["trade"].net_pnl < 0 and detail["exit_reason"] == key
                )
                for key in reason_distribution
            },
            "winning_trade_reason_distribution": {
                key: sum(
                    1
                    for detail in closed_details
                    if detail["trade"].net_pnl > 0 and detail["exit_reason"] == key
                )
                for key in reason_distribution
            },
        }

    def build_regime_bucket_summary(self, details: list[dict[str, Any]], *, regime_getter) -> dict[str, object]:
        buckets: dict[str, list[dict[str, Any]]] = {}
        for detail in details:
            label = regime_getter(detail)
            buckets.setdefault(label, []).append(detail)

        summary: dict[str, object] = {}
        for label, bucket_details in buckets.items():
            net_values = [bucket_detail["trade"].net_pnl for bucket_detail in bucket_details]
            wins = sum(1 for bucket_detail in bucket_details if bucket_detail["trade"].net_pnl > 0)
            summary[label] = {
                "trades": len(bucket_details),
                "wins": wins,
                "losses": sum(1 for bucket_detail in bucket_details if bucket_detail["trade"].net_pnl < 0),
                "win_rate": format_decimal(quantize_value(Decimal(wins) / Decimal(len(bucket_details)))) if bucket_details else None,
                "net_pnl": format_decimal(sum(net_values, Decimal("0"))),
            }
        return summary

    def build_trade_market_context_analysis(self, details: list[dict[str, Any]]) -> dict[str, object]:
        closed_details = [detail for detail in details if detail["trade"].status == "CLOSED"]
        return {
            "definitions": {
                "trend": "positive si EMA20 > EMA50, negative si EMA20 < EMA50, neutral si EMA20 = EMA50.",
                "volatility": "high si ATR14 > ATR14 expanding median calculada solo con informacion disponible hasta ese timestamp; low en caso contrario.",
            },
            "entry": {
                "trend": self.build_regime_bucket_summary(
                    closed_details,
                    regime_getter=lambda detail: detail["entry_market_context"]["trend"],
                ),
                "volatility": self.build_regime_bucket_summary(
                    closed_details,
                    regime_getter=lambda detail: detail["entry_market_context"]["volatility"],
                ),
                "combined": self.build_regime_bucket_summary(
                    closed_details,
                    regime_getter=lambda detail: f"{detail['entry_market_context']['trend']}|{detail['entry_market_context']['volatility']}",
                ),
            },
            "exit": {
                "trend": self.build_regime_bucket_summary(
                    closed_details,
                    regime_getter=lambda detail: detail["exit_market_context"]["trend"],
                ),
                "volatility": self.build_regime_bucket_summary(
                    closed_details,
                    regime_getter=lambda detail: detail["exit_market_context"]["volatility"],
                ),
                "combined": self.build_regime_bucket_summary(
                    closed_details,
                    regime_getter=lambda detail: f"{detail['exit_market_context']['trend']}|{detail['exit_market_context']['volatility']}",
                ),
            },
        }

    def build_trade_diagnostics_summary(
        self,
        *,
        result: BacktestResult,
        strategy: str,
        snapshots: list[BacktestSignalSnapshot],
        details: list[dict[str, Any]],
    ) -> dict[str, object]:
        closed_details = [detail for detail in details if detail["trade"].status == "CLOSED"]
        return {
            "strategy": strategy,
            "range": self.build_range_payload(snapshots),
            "total_trade_records": len(details),
            "closed_trades": len(closed_details),
            "open_trade_records": len(details) - len(closed_details),
            "winning_trades": sum(1 for detail in closed_details if detail["trade"].net_pnl > 0),
            "losing_trades": sum(1 for detail in closed_details if detail["trade"].net_pnl < 0),
            "win_rate": format_decimal(result.win_rate),
            "gross_edge_before_commissions": format_decimal(quantize_value(result.gross_profit + result.gross_loss)),
            "commissions": format_decimal(result.total_commissions),
            "net_profit": format_decimal(result.net_profit),
            "profit_factor": format_decimal(result.profit_factor),
            "expectancy": format_decimal(result.expectancy),
        }

    def build_trade_diagnostic_warnings(
        self,
        *,
        result: BacktestResult,
        loser_analysis: dict[str, object],
        cost_analysis: dict[str, object],
        break_even_analysis: dict[str, object],
    ) -> list[str]:
        warnings: list[str] = []
        if cost_analysis["overall"]["commissions_exceed_gross_edge"]:
            warnings.append("cost_dominance")
        if cost_analysis["negative_result_due_exclusively_to_costs"] == "1.00000000":
            warnings.append("aggregate_net_result_explained_by_costs")
        if loser_analysis["classification"]["large_mae_classification"]["status"] == "NOT_CLASSIFIED":
            warnings.append("large_mae_threshold_not_defined_objectively")
        if break_even_analysis["trade_count_reduction_for_break_even"]["status"] == "not_sufficient_under_current_average_trade_profile":
            warnings.append("trade_count_reduction_alone_not_sufficient")
        if result.total_trades == 0:
            warnings.append("no_trades")
        deduped: list[str] = []
        seen: set[str] = set()
        for warning in warnings:
            if warning not in seen:
                deduped.append(warning)
                seen.add(warning)
        return deduped

    def diagnose_trade_backtest(
        self,
        session: Session,
        *,
        asset_id: int,
        timeframe: str,
        strategy: str,
        start_timestamp: datetime,
        end_timestamp: datetime,
    ) -> dict[str, object]:
        try:
            _, snapshots = self.prepare_range_inputs(
                session,
                asset_id=asset_id,
                timeframe=timeframe,
                strategy=strategy,
                start_timestamp=start_timestamp,
                end_timestamp=end_timestamp,
                indicator_names=self.DIAGNOSTIC_INDICATORS,
            )
            BacktestingValidator.ensure_evaluable_data(snapshots)
            result = self.engine.run(
                snapshots=snapshots,
                strategy=strategy,
                initial_cash=self.settings.backtest_initial_cash,
                commission_rate=self.settings.paper_commission_rate,
            )
            detailed_trade_records = self.build_detailed_trade_records(result=result, snapshots=snapshots, strategy=strategy)
            closed_details = [detail for detail in detailed_trade_records if detail["trade"].status == "CLOSED"]
            winner_details = [detail for detail in closed_details if detail["trade"].net_pnl > 0]
            loser_details = [detail for detail in closed_details if detail["trade"].net_pnl < 0]

            winner_analysis = self.build_winner_analysis(closed_details)
            loser_analysis = self.build_loser_analysis(closed_details)
            holding_time_analysis = self.build_holding_time_analysis(winner_details, loser_details)
            cost_analysis = self.build_trade_cost_impact_analysis(result=result, details=closed_details)
            break_even_analysis = self.build_break_even_analysis(
                result=result,
                winner_details=winner_details,
                loser_details=loser_details,
            )
            exit_analysis = self.build_exit_analysis(closed_details)
            market_context = self.build_trade_market_context_analysis(closed_details)
            warnings = self.build_trade_diagnostic_warnings(
                result=result,
                loser_analysis=loser_analysis,
                cost_analysis=cost_analysis,
                break_even_analysis=break_even_analysis,
            )

            return {
                "summary": self.build_trade_diagnostics_summary(
                    result=result,
                    strategy=strategy,
                    snapshots=snapshots,
                    details=detailed_trade_records,
                ),
                "trade_analysis": {
                    "definitions": {
                        "significant_positive_mfe": "MFE gross PnL > total_commission del trade.",
                        "market_regime": {
                            "trend": "EMA20 vs EMA50",
                            "volatility": "ATR14 vs ATR14 expanding median sin look-ahead",
                        },
                    },
                    "trades": self.serialize_detailed_trade_records(detailed_trade_records),
                },
                "winner_analysis": winner_analysis,
                "loser_analysis": loser_analysis,
                "holding_time_analysis": holding_time_analysis,
                "cost_analysis": cost_analysis,
                "break_even_analysis": break_even_analysis,
                "entry_analysis": self.build_trade_entry_analysis(
                    winner_details=winner_details,
                    loser_details=loser_details,
                ),
                "exit_analysis": exit_analysis,
                "market_context": market_context,
                "warnings": warnings,
            }
        except BacktestingValidationError:
            raise
        except Exception as exc:  # noqa: BLE001
            self.record_error_event(asset_id=asset_id, strategy=strategy, error=str(exc))
            raise

    def audit_dataset_quality(self, market_rows: list[MarketData]) -> dict[str, object]:
        timestamps = [row.timestamp for row in market_rows]
        duplicate_timestamps = len(timestamps) - len(set(timestamps))
        invalid_ohlc = 0
        gaps = 0

        for row in market_rows:
            numeric_values = [row.open, row.high, row.low, row.close, row.volume]
            if any(not value.is_finite() for value in numeric_values):
                invalid_ohlc += 1
            elif (
                row.open <= 0
                or row.high <= 0
                or row.low <= 0
                or row.close <= 0
                or row.volume < 0
                or row.high < max(row.open, row.close)
                or row.low > min(row.open, row.close)
                or row.high < row.low
            ):
                invalid_ohlc += 1

        deltas = [current.timestamp - previous.timestamp for previous, current in zip(market_rows, market_rows[1:], strict=False)]
        positive_deltas = [delta for delta in deltas if delta.total_seconds() > 0]
        expected_delta = min(positive_deltas) if positive_deltas else None
        if expected_delta is not None:
            gaps = sum(1 for delta in positive_deltas if delta != expected_delta)

        return {
            "count": len(market_rows),
            "min_timestamp": market_rows[0].timestamp.isoformat() if market_rows else None,
            "max_timestamp": market_rows[-1].timestamp.isoformat() if market_rows else None,
            "gaps": gaps,
            "duplicate_timestamps": duplicate_timestamps,
            "invalid_ohlc": invalid_ohlc,
        }

    def build_window_percentages(self) -> tuple[int, ...]:
        return (25, 50, 75, 100)

    def build_window_segments(self, snapshots: list[BacktestSignalSnapshot]) -> dict[str, list[BacktestSignalSnapshot]]:
        windows: dict[str, list[BacktestSignalSnapshot]] = {}
        total = len(snapshots)
        for percent in self.build_window_percentages():
            count = max(1, int(total * Decimal(percent) / Decimal("100"))) if total else 0
            if percent == 100:
                count = total
            windows[f"{percent}%"] = snapshots[:count]
        return windows

    def build_window_result_summary(self, *, label: str, snapshots: list[BacktestSignalSnapshot], strategy: str) -> dict[str, object]:
        if not snapshots or not any(snapshot.has_required_indicators for snapshot in snapshots):
            return {
                "label": label,
                "candles": len(snapshots),
                "trades": 0,
                "win_rate": None,
                "net_profit": None,
                "return": None,
                "profit_factor": None,
                "expectancy": None,
                "max_drawdown": None,
                "max_drawdown_percent": None,
                "buy_and_hold_return": None,
                "gross_profit": None,
                "gross_loss": None,
                "gross_edge": None,
                "commissions": None,
                "commission_to_gross_edge_ratio": None,
            }

        result = self.engine.run(
            snapshots=snapshots,
            strategy=strategy,
            initial_cash=self.settings.backtest_initial_cash,
            commission_rate=self.settings.paper_commission_rate,
        )
        gross_edge = result.gross_profit + result.gross_loss
        cost_ratio = None if gross_edge == 0 else format_decimal(result.total_commissions / abs(gross_edge))
        return {
            "label": label,
            "candles": len(snapshots),
            "trades": result.total_trades,
            "win_rate": format_decimal(result.win_rate),
            "net_profit": format_decimal(result.net_profit),
            "return": format_decimal(result.strategy_return),
            "profit_factor": format_decimal(result.profit_factor),
            "expectancy": format_decimal(result.expectancy),
            "max_drawdown": format_decimal(result.max_drawdown),
            "max_drawdown_percent": format_decimal(result.max_drawdown_percent),
            "buy_and_hold_return": format_decimal(result.buy_and_hold_return),
            "gross_profit": format_decimal(result.gross_profit),
            "gross_loss": format_decimal(result.gross_loss),
            "gross_edge": format_decimal(gross_edge),
            "commissions": format_decimal(result.total_commissions),
            "commission_to_gross_edge_ratio": cost_ratio,
        }

    def build_window_analysis(self, snapshots: list[BacktestSignalSnapshot], *, strategy: str) -> dict[str, object]:
        windows = self.build_window_segments(snapshots)
        reports = {label: self.build_window_result_summary(label=label, snapshots=segment, strategy=strategy) for label, segment in windows.items()}

        profitable = sum(1 for report in reports.values() if report["net_profit"] is not None and Decimal(report["net_profit"]) > 0)
        negative = sum(1 for report in reports.values() if report["net_profit"] is not None and Decimal(report["net_profit"]) < 0)
        pf_gt_1 = sum(1 for report in reports.values() if report["profit_factor"] is not None and Decimal(report["profit_factor"]) > 1)
        pf_lt_1 = sum(1 for report in reports.values() if report["profit_factor"] is not None and Decimal(report["profit_factor"]) < 1)
        returns = [Decimal(report["return"]) for report in reports.values() if report["return"] is not None]
        drawdowns = [Decimal(report["max_drawdown_percent"]) for report in reports.values() if report["max_drawdown_percent"] is not None]
        win_rates = [Decimal(report["win_rate"]) for report in reports.values() if report["win_rate"] is not None]
        profit_factors = [Decimal(report["profit_factor"]) for report in reports.values() if report["profit_factor"] is not None]

        return {
            "windows": reports,
            "stability": {
                "profitable_windows": profitable,
                "negative_windows": negative,
                "profit_factor_gt_1_windows": pf_gt_1,
                "profit_factor_lt_1_windows": pf_lt_1,
                "return_distribution": self.summarize_decimal_series(returns),
                "drawdown_distribution": self.summarize_decimal_series(drawdowns),
                "win_rate_distribution": self.summarize_decimal_series(win_rates),
                "profit_factor_distribution": self.summarize_decimal_series(profit_factors),
            },
        }

    def build_walk_forward_matrix(self, snapshots: list[BacktestSignalSnapshot], *, strategy: str) -> dict[str, object]:
        output: dict[str, object] = {}
        for train_percent in (60, 70, 80):
            report = self.build_walk_forward_report_for_ratio(snapshots, strategy=strategy, train_percent=train_percent)
            output[f"{train_percent}/{100 - train_percent}"] = {
                "split": report["split"],
                "train": self.summarize_period_report(report["train"]),
                "test": self.summarize_period_report(report["test"]),
            }
        return output

    def build_macd_stability(self, window_analysis: dict[str, object], snapshots: list[BacktestSignalSnapshot], *, strategy: str) -> dict[str, object]:
        windows = self.build_window_segments(snapshots)
        output: dict[str, object] = {}
        for label, segment in windows.items():
            result = self.engine.run(
                snapshots=segment,
                strategy=strategy,
                initial_cash=self.settings.backtest_initial_cash,
                commission_rate=self.settings.paper_commission_rate,
            ) if segment and any(snapshot.has_required_indicators for snapshot in segment) else None
            if result is None:
                output[label] = {"positive": "INSUFFICIENT_SAMPLE", "negative": "INSUFFICIENT_SAMPLE"}
                continue

            details = self.build_trade_details(result=result, snapshots=segment)
            positive = [detail for detail in details if detail["entry_context"]["macd_sign"] == "positive"]
            negative = [detail for detail in details if detail["entry_context"]["macd_sign"] == "negative"]

            def summarize_bucket(bucket: list[dict[str, Any]]) -> dict[str, object] | str:
                if len(bucket) < 10:
                    return "INSUFFICIENT_SAMPLE"
                returns = [detail["trade"].return_percent for detail in bucket if detail["trade"].return_percent is not None]
                wins = sum(1 for detail in bucket if detail["trade"].net_pnl > 0)
                return {
                    "trades": len(bucket),
                    "win_rate": format_decimal(quantize_value(Decimal(wins) / Decimal(len(bucket)))),
                    "net_profit": format_decimal(sum((detail["trade"].net_pnl for detail in bucket), Decimal("0"))),
                    "average_return": format_decimal(BacktestingMetrics.average(returns)),
                }

            output[label] = {
                "positive": summarize_bucket(positive),
                "negative": summarize_bucket(negative),
            }
        return output

    def build_holding_time_stability(self, snapshots: list[BacktestSignalSnapshot], *, strategy: str) -> dict[str, object]:
        windows = self.build_window_segments(snapshots)
        output: dict[str, object] = {}
        for label, segment in windows.items():
            if not segment or not any(snapshot.has_required_indicators for snapshot in segment):
                output[label] = {
                    "average_winner_holding": None,
                    "median_winner_holding": None,
                    "average_loser_holding": None,
                    "median_loser_holding": None,
                }
                continue
            result = self.engine.run(
                snapshots=segment,
                strategy=strategy,
                initial_cash=self.settings.backtest_initial_cash,
                commission_rate=self.settings.paper_commission_rate,
            )
            details = self.build_trade_details(result=result, snapshots=segment)
            winning_details = [detail for detail in details if detail["trade"].net_pnl > 0]
            losing_details = [detail for detail in details if detail["trade"].net_pnl < 0]
            winner_summary = self.summarize_holding_minutes(winning_details)
            loser_summary = self.summarize_holding_minutes(losing_details)
            output[label] = {
                "average_winner_holding": winner_summary["average"],
                "median_winner_holding": winner_summary["median"],
                "average_loser_holding": loser_summary["average"],
                "median_loser_holding": loser_summary["median"],
            }
        return output

    def build_profit_concentration(self, result: BacktestResult) -> dict[str, object]:
        winning_net_pnls = sorted([trade.net_pnl for trade in result.trades if trade.status == "CLOSED" and trade.net_pnl > 0], reverse=True)
        total_positive_profit = sum(winning_net_pnls, Decimal("0"))

        def share(top_n: int) -> str | None:
            if total_positive_profit <= 0:
                return None
            top_profit = sum(winning_net_pnls[:top_n], Decimal("0"))
            return format_decimal(quantize_value(top_profit / total_positive_profit))

        return {
            "total_positive_profit": format_decimal(total_positive_profit),
            "top_1_share": share(1),
            "top_3_share": share(3),
            "top_5_share": share(5),
            "top_10_share": share(10),
        }

    def run_monte_carlo(self, result: BacktestResult, *, simulations: int = 1000, seed: int = 42) -> dict[str, object]:
        closed_trades = [trade for trade in result.trades if trade.status == "CLOSED"]
        if not closed_trades:
            return {
                "simulations": simulations,
                "seed": seed,
                "final_return": {"p5": None, "p25": None, "median": None, "p75": None, "p95": None},
                "max_drawdown": {"p5": None, "p25": None, "median": None, "p75": None, "p95": None},
                "profit_factor": {"p5": None, "p25": None, "median": None, "p75": None, "p95": None},
            }

        rng = random.Random(seed)
        initial_cash = result.initial_cash
        net_pnls = [trade.net_pnl for trade in closed_trades]
        gross_pnls = [trade.gross_pnl for trade in closed_trades]
        commissions = [trade.commission_total for trade in closed_trades]

        final_returns: list[Decimal] = []
        max_drawdowns: list[Decimal] = []
        profit_factors: list[Decimal] = []

        for _ in range(simulations):
            indices = list(range(len(closed_trades)))
            rng.shuffle(indices)
            equity = initial_cash
            peak = initial_cash
            max_drawdown = Decimal("0")
            gross_profit = Decimal("0")
            gross_loss = Decimal("0")

            for index in indices:
                equity = quantize_value(equity + net_pnls[index])
                if equity > peak:
                    peak = equity
                drawdown = quantize_value((peak - equity) / peak) if peak > 0 else Decimal("0")
                if drawdown > max_drawdown:
                    max_drawdown = drawdown
                if gross_pnls[index] > 0:
                    gross_profit += gross_pnls[index]
                elif gross_pnls[index] < 0:
                    gross_loss += gross_pnls[index]

            final_returns.append(quantize_value((equity - initial_cash) / initial_cash))
            max_drawdowns.append(max_drawdown)
            profit_factors.append(quantize_value(gross_profit / abs(gross_loss)) if gross_loss != 0 else Decimal("0"))

        def percentile(values: list[Decimal], fraction: Decimal) -> str | None:
            if not values:
                return None
            ordered = sorted(values)
            index = int((Decimal(len(ordered) - 1) * fraction).to_integral_value())
            return format_decimal(ordered[index])

        return {
            "simulations": simulations,
            "seed": seed,
            "final_return": {
                "p5": percentile(final_returns, Decimal("0.05")),
                "p25": percentile(final_returns, Decimal("0.25")),
                "median": format_decimal(BacktestingMetrics.median(final_returns)),
                "p75": percentile(final_returns, Decimal("0.75")),
                "p95": percentile(final_returns, Decimal("0.95")),
            },
            "max_drawdown": {
                "p5": percentile(max_drawdowns, Decimal("0.05")),
                "p25": percentile(max_drawdowns, Decimal("0.25")),
                "median": format_decimal(BacktestingMetrics.median(max_drawdowns)),
                "p75": percentile(max_drawdowns, Decimal("0.75")),
                "p95": percentile(max_drawdowns, Decimal("0.95")),
            },
            "profit_factor": {
                "p5": percentile(profit_factors, Decimal("0.05")),
                "p25": percentile(profit_factors, Decimal("0.25")),
                "median": format_decimal(BacktestingMetrics.median(profit_factors)),
                "p75": percentile(profit_factors, Decimal("0.75")),
                "p95": percentile(profit_factors, Decimal("0.95")),
            },
        }

    def build_reproducibility_report(self, snapshots: list[BacktestSignalSnapshot], *, strategy: str) -> dict[str, object]:
        first = self.engine.run(
            snapshots=snapshots,
            strategy=strategy,
            initial_cash=self.settings.backtest_initial_cash,
            commission_rate=self.settings.paper_commission_rate,
        )
        second = self.engine.run(
            snapshots=snapshots,
            strategy=strategy,
            initial_cash=self.settings.backtest_initial_cash,
            commission_rate=self.settings.paper_commission_rate,
        )
        return {
            "identical_trades": [trade.to_dict() for trade in first.trades] == [trade.to_dict() for trade in second.trades],
            "identical_net_profit": first.net_profit == second.net_profit,
            "identical_return": first.strategy_return == second.strategy_return,
            "identical_drawdown": first.max_drawdown_percent == second.max_drawdown_percent,
            "identical_signals": self.analyze_snapshots(snapshots, strategy=strategy) == self.analyze_snapshots(snapshots, strategy=strategy),
        }

    def build_robustness_warnings(
        self,
        *,
        dataset_quality: dict[str, object],
        window_analysis: dict[str, object],
        walk_forward: dict[str, object],
        cost_analysis: dict[str, object],
        profit_concentration: dict[str, object],
        reproducibility: dict[str, object],
        total_trades: int,
    ) -> list[str]:
        warnings: list[str] = []
        if total_trades < 30:
            warnings.append("insufficient_sample")
        if total_trades < 10:
            warnings.append("low_trade_count")

        stability = window_analysis["stability"]
        win_rate_values = [
            Decimal(report["win_rate"])
            for report in window_analysis["windows"].values()
            if report["win_rate"] is not None
        ]
        if len(win_rate_values) >= 2 and (max(win_rate_values) - min(win_rate_values)) > Decimal("0.10"):
            warnings.append("unstable_win_rate")

        pf_values = [
            Decimal(report["profit_factor"])
            for report in window_analysis["windows"].values()
            if report["profit_factor"] is not None
        ]
        if len(pf_values) >= 2 and (max(pf_values) - min(pf_values)) > Decimal("0.50"):
            warnings.append("unstable_profit_factor")

        if stability["profitable_windows"] > 0 and stability["negative_windows"] > 0:
            warnings.append("period_instability")

        if cost_analysis["commissions_exceed_gross_edge"]:
            warnings.append("cost_dominance")

        if profit_concentration["top_3_share"] is not None and Decimal(profit_concentration["top_3_share"]) > Decimal("0.80"):
            warnings.append("profit_concentration")

        test_returns = [
            Decimal(report["test"]["strategy_return"])
            for report in walk_forward.values()
            if report["test"]["strategy_return"] is not None
        ]
        if len(test_returns) >= 2 and (max(test_returns) - min(test_returns)) > Decimal("0.10"):
            warnings.append("out_of_sample_instability")

        if any(not reproducibility[key] for key in reproducibility):
            warnings.append("reproducibility_failure")
        if int(dataset_quality["duplicate_timestamps"]) > 0 or int(dataset_quality["invalid_ohlc"]) > 0:
            warnings.append("dataset_quality_issue")

        deduped: list[str] = []
        seen: set[str] = set()
        for warning in warnings:
            if warning not in seen:
                deduped.append(warning)
                seen.add(warning)
        return deduped

    def build_strategy_comparison_warnings(self, reports: list[dict[str, object]]) -> list[str]:
        warnings: list[str] = []
        for report in reports:
            if report.get("implemented", False):
                warnings.extend(report.get("warnings", []))
        deduped: list[str] = []
        seen: set[str] = set()
        for warning in warnings:
            if warning not in seen:
                deduped.append(warning)
                seen.add(warning)
        return deduped

    def compare_strategies(
        self,
        session: Session,
        *,
        asset_id: int,
        timeframe: str,
        start_timestamp: datetime,
        end_timestamp: datetime,
    ) -> dict[str, object]:
        try:
            BacktestingValidator.validate_request(start_timestamp=start_timestamp, end_timestamp=end_timestamp)
            asset = self.get_asset(session, asset_id=asset_id)
            if asset is None:
                raise BacktestingValidationError("asset_not_found")

            market_rows = self.load_market_rows(
                session,
                asset_id=asset_id,
                timeframe=timeframe,
                start_timestamp=start_timestamp,
                end_timestamp=end_timestamp,
            )
            if not market_rows:
                raise BacktestingValidationError("range_without_data")
            dataset_quality = self.audit_dataset_quality(market_rows)

            indicator_rows = self.load_indicator_rows(
                session,
                asset_id=asset_id,
                timeframe=timeframe,
                start_timestamp=start_timestamp,
                end_timestamp=end_timestamp,
                indicator_names=self.DIAGNOSTIC_INDICATORS,
            )
            snapshots = self.build_snapshots(asset=asset, timeframe=timeframe, market_rows=market_rows, indicator_rows=indicator_rows)
            BacktestingValidator.validate_market_snapshots(snapshots)
            BacktestingValidator.ensure_evaluable_data(snapshots)

            self.record_audit_event(
                session,
                event_type="backtesting.strategy_comparison_started",
                severity="info",
                message="Starting controlled strategy comparison",
                metadata={
                    "asset_id": asset.id,
                    "asset_symbol": asset.symbol,
                    "timeframe": timeframe,
                    "start_timestamp": start_timestamp.isoformat(),
                    "end_timestamp": end_timestamp.isoformat(),
                    "candles_evaluated": len(snapshots),
                },
            )

            baseline_report = self.build_strategy_report(
                strategy=BASELINE_TREND_RSI,
                snapshots=snapshots,
                dataset_quality=dataset_quality,
            )
            variant_reports = [
                self.build_strategy_report(strategy=strategy, snapshots=snapshots, dataset_quality=dataset_quality)
                for strategy in self.STRATEGY_COMPARISON_VARIANTS
            ]
            variant_reports.extend(
                self.build_not_implemented_variant_report(strategy, reason)
                for strategy, reason in self.NOT_IMPLEMENTED_VARIANTS.items()
            )

            comparison_rows = [self.build_comparison_row(baseline_report)]
            comparison_rows.extend(self.build_comparison_row(report) for report in variant_reports)

            robustness = {
                baseline_report["strategy"]: {
                    "trade_count_by_period": baseline_report["trade_count_by_period"],
                    "train_test_70_30": baseline_report["train_test_70_30"],
                    "walk_forward": baseline_report["walk_forward"],
                    "window_analysis": baseline_report["window_analysis"],
                }
            }
            robustness.update(
                {
                    report["strategy"]: {
                        "trade_count_by_period": report["trade_count_by_period"],
                        "train_test_70_30": report["train_test_70_30"],
                        "walk_forward": report["walk_forward"],
                        "window_analysis": report["window_analysis"],
                    }
                    for report in variant_reports
                    if report.get("implemented", False)
                }
            )
            cost_analysis = {
                baseline_report["strategy"]: baseline_report["cost_analysis"],
                **{
                    report["strategy"]: report["cost_analysis"]
                    for report in variant_reports
                    if report.get("implemented", False)
                },
            }
            warnings = self.build_strategy_comparison_warnings([baseline_report, *variant_reports])

            payload = {
                "baseline": baseline_report,
                "variants": variant_reports,
                "comparison": {
                    "table": comparison_rows,
                    "objective_assessment": self.build_objective_assessment(baseline_report, variant_reports),
                },
                "robustness": robustness,
                "cost_analysis": cost_analysis,
                "warnings": warnings,
            }

            self.record_audit_event(
                session,
                event_type="backtesting.strategy_comparison_completed",
                severity="info",
                message="Controlled strategy comparison completed",
                metadata={
                    "asset_id": asset.id,
                    "asset_symbol": asset.symbol,
                    "baseline_trades": baseline_report["metrics"]["trades"],
                    "variant_count": len(variant_reports),
                    "warnings": warnings,
                },
            )
            return payload
        except BacktestingValidationError as exc:
            self.record_audit_event(
                session,
                event_type="backtesting.strategy_comparison_rejected",
                severity="warning",
                message="Controlled strategy comparison rejected",
                metadata={
                    "asset_id": asset_id,
                    "timeframe": timeframe,
                    "reason": str(exc),
                },
            )
            raise
        except Exception as exc:  # noqa: BLE001
            self.record_error_event(asset_id=asset_id, strategy="strategy_comparison", error=str(exc))
            raise

    def robustness_backtest(
        self,
        session: Session,
        *,
        asset_id: int,
        timeframe: str,
        strategy: str,
        start_timestamp: datetime,
        end_timestamp: datetime,
    ) -> dict[str, object]:
        try:
            BacktestingValidator.validate_request(start_timestamp=start_timestamp, end_timestamp=end_timestamp)
            asset = self.get_asset(session, asset_id=asset_id)
            if asset is None:
                raise BacktestingValidationError("asset_not_found")
            if strategy not in VALID_STRATEGIES:
                raise BacktestingValidationError("strategy_not_found")

            market_rows = self.load_market_rows(
                session,
                asset_id=asset_id,
                timeframe=timeframe,
                start_timestamp=start_timestamp,
                end_timestamp=end_timestamp,
            )
            if not market_rows:
                raise BacktestingValidationError("range_without_data")
            dataset_quality = self.audit_dataset_quality(market_rows)

            indicator_rows = self.load_indicator_rows(
                session,
                asset_id=asset_id,
                timeframe=timeframe,
                start_timestamp=start_timestamp,
                end_timestamp=end_timestamp,
                indicator_names=self.DIAGNOSTIC_INDICATORS,
            )
            snapshots = self.build_snapshots(asset=asset, timeframe=timeframe, market_rows=market_rows, indicator_rows=indicator_rows)
            BacktestingValidator.validate_market_snapshots(snapshots)
            BacktestingValidator.ensure_evaluable_data(snapshots)

            self.record_audit_event(
                session,
                event_type="backtesting.robustness_started",
                severity="info",
                message="Starting backtest robustness analysis",
                metadata={
                    "asset_id": asset.id,
                    "asset_symbol": asset.symbol,
                    "timeframe": timeframe,
                    "strategy": strategy,
                    "start_timestamp": start_timestamp.isoformat(),
                    "end_timestamp": end_timestamp.isoformat(),
                    "candles_evaluated": len(snapshots),
                },
            )

            result = self.engine.run(
                snapshots=snapshots,
                strategy=strategy,
                initial_cash=self.settings.backtest_initial_cash,
                commission_rate=self.settings.paper_commission_rate,
            )
            window_analysis = self.build_window_analysis(snapshots, strategy=strategy)
            walk_forward = self.build_walk_forward_matrix(snapshots, strategy=strategy)
            cost_analysis = self.build_cost_analysis(result)
            macd_stability = self.build_macd_stability(window_analysis, snapshots, strategy=strategy)
            holding_time_stability = self.build_holding_time_stability(snapshots, strategy=strategy)
            profit_concentration = self.build_profit_concentration(result)
            monte_carlo = self.run_monte_carlo(result, simulations=1000, seed=42)
            reproducibility = self.build_reproducibility_report(snapshots, strategy=strategy)
            warnings = self.build_robustness_warnings(
                dataset_quality=dataset_quality,
                window_analysis=window_analysis,
                walk_forward=walk_forward,
                cost_analysis=cost_analysis,
                profit_concentration=profit_concentration,
                reproducibility=reproducibility,
                total_trades=result.total_trades,
            )

            payload = {
                "dataset_quality": dataset_quality,
                "window_analysis": window_analysis,
                "walk_forward": walk_forward,
                "cost_analysis": cost_analysis,
                "macd_stability": macd_stability,
                "holding_time_stability": holding_time_stability,
                "profit_concentration": profit_concentration,
                "monte_carlo": monte_carlo,
                "reproducibility": reproducibility,
                "warnings": warnings,
            }

            self.record_audit_event(
                session,
                event_type="backtesting.robustness_completed",
                severity="info",
                message="Backtest robustness analysis completed",
                metadata={
                    "asset_id": asset.id,
                    "asset_symbol": asset.symbol,
                    "strategy": strategy,
                    "total_trades": result.total_trades,
                    "warnings": warnings,
                },
            )
            return payload
        except BacktestingValidationError as exc:
            self.record_audit_event(
                session,
                event_type="backtesting.robustness_rejected",
                severity="warning",
                message="Backtest robustness analysis rejected",
                metadata={
                    "asset_id": asset_id,
                    "timeframe": timeframe,
                    "strategy": strategy,
                    "reason": str(exc),
                },
            )
            raise
        except Exception as exc:  # noqa: BLE001
            self.record_error_event(asset_id=asset_id, strategy=strategy, error=str(exc))
            raise

    def run_backtest(
        self,
        session: Session,
        *,
        asset_id: int,
        timeframe: str,
        strategy: str,
        start_timestamp: datetime,
        end_timestamp: datetime,
    ) -> dict[str, object]:
        try:
            asset, snapshots = self.prepare_range_inputs(
                session,
                asset_id=asset_id,
                timeframe=timeframe,
                strategy=strategy,
                start_timestamp=start_timestamp,
                end_timestamp=end_timestamp,
            )
            BacktestingValidator.ensure_evaluable_data(snapshots)
            signal_analysis = self.analyze_snapshots(snapshots, strategy=strategy)

            self.record_audit_event(
                session,
                event_type="backtesting.started",
                severity="info",
                message="Starting backtest run",
                metadata={
                    "asset_id": asset_id,
                    "asset_symbol": asset.symbol,
                    "timeframe": timeframe,
                    "strategy": strategy,
                    "start_timestamp": start_timestamp.isoformat(),
                    "end_timestamp": end_timestamp.isoformat(),
                    "candles_evaluated": len(snapshots),
                    "buy_signals": signal_analysis["buy_signals"],
                    "sell_signals": signal_analysis["sell_signals"],
                },
            )

            result = self.engine.run(
                snapshots=snapshots,
                strategy=strategy,
                initial_cash=self.settings.backtest_initial_cash,
                commission_rate=self.settings.paper_commission_rate,
            )
            warnings = self.build_warnings(candles_evaluated=len(snapshots), signal_analysis=signal_analysis, total_trades=result.total_trades)
            run = self.persist_result(
                session,
                asset_id=asset_id,
                timeframe=timeframe,
                strategy=strategy,
                start_timestamp=start_timestamp,
                end_timestamp=end_timestamp,
                result=result,
            )
            summary = self.build_sectioned_response(
                result=result,
                signal_analysis=signal_analysis,
                snapshots=snapshots,
                warnings=warnings,
                run_id=run.id,
            )
            summary["periods"] = self.build_period_reports(snapshots, strategy=strategy)
            summary["walk_forward"] = self.build_walk_forward_report(snapshots, strategy=strategy)

            self.record_audit_event(
                session,
                event_type="backtesting.completed",
                severity="info",
                message="Backtest completed",
                metadata={
                    "run_id": run.id,
                    "asset_id": asset_id,
                    "strategy": strategy,
                    "final_equity": summary["final_equity"],
                    "strategy_return": summary["strategy_return"],
                    "total_trades": summary["total_trades"],
                    "max_drawdown_percent": summary["max_drawdown_percent"],
                    "warnings": warnings,
                },
            )
            return summary
        except BacktestingValidationError as exc:
            self.record_audit_event(
                session,
                event_type="backtesting.rejected",
                severity="warning",
                message="Backtest rejected",
                metadata={
                    "asset_id": asset_id,
                    "timeframe": timeframe,
                    "strategy": strategy,
                    "reason": str(exc),
                },
            )
            raise
        except Exception as exc:  # noqa: BLE001
            self.record_error_event(asset_id=asset_id, strategy=strategy, error=str(exc))
            raise
