from __future__ import annotations

from decimal import Decimal

from app.backtesting.metrics import BacktestingMetrics
from app.backtesting.models import BacktestEquityPoint, BacktestResult, BacktestSignalSnapshot, BacktestTradeRecord, quantize_value
from app.backtesting.validator import BacktestingValidator
from app.paper_trading.execution import calculate_commission
from app.paper_trading.risk import RISK_FRACTION, calculate_buy_quantity
from app.signals.engine import SignalEngine
from app.signals.models import SIGNAL_BUY, SIGNAL_SELL, SignalEvaluationInput


class BacktestingEngine:
    def __init__(self, signal_engine: SignalEngine | None = None) -> None:
        self.signal_engine = signal_engine or SignalEngine()

    @staticmethod
    def _append_atr_history(snapshot: BacktestSignalSnapshot, atr_history: list[Decimal]) -> None:
        atr_14 = snapshot.indicator_values.get("ATR_14")
        if atr_14 is not None:
            atr_history.append(atr_14)

    def _build_signal_input(
        self,
        snapshot: BacktestSignalSnapshot,
        *,
        strategy: str,
        atr_history: list[Decimal],
    ) -> SignalEvaluationInput:
        atr_14 = snapshot.indicator_values.get("ATR_14")
        atr_expanding_median = BacktestingMetrics.median([*atr_history, atr_14]) if atr_14 is not None else None
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

    def run(
        self,
        *,
        snapshots: list[BacktestSignalSnapshot],
        strategy: str,
        initial_cash: Decimal,
        commission_rate: Decimal,
        position_size_percent: Decimal = RISK_FRACTION,
    ) -> BacktestResult:
        BacktestingValidator.validate_market_snapshots(snapshots)
        BacktestingValidator.ensure_evaluable_data(snapshots)

        cash = quantize_value(initial_cash)
        quantity = Decimal("0")
        average_price = Decimal("0")
        open_trade: dict[str, Decimal | object] | None = None
        trades: list[BacktestTradeRecord] = []
        equity_curve: list[BacktestEquityPoint] = []
        peak_equity = quantize_value(initial_cash)
        exposure_points = 0
        atr_history: list[Decimal] = []

        first_close = snapshots[0].close
        last_close = snapshots[-1].close
        buy_and_hold_return = quantize_value((last_close - first_close) / first_close) if first_close > 0 else None

        for snapshot in snapshots:
            signal_type = None
            if snapshot.has_required_indicators:
                signal_input = self._build_signal_input(snapshot, strategy=strategy, atr_history=atr_history)
                signal_result = self.signal_engine.evaluate(signal_input, strategy)
                signal_type = signal_result.signal_type

            if signal_type == SIGNAL_BUY and quantity == 0:
                buy_quantity = calculate_buy_quantity(cash=cash, market_price=snapshot.close, risk_fraction=position_size_percent)
                trade_value = quantize_value(buy_quantity * snapshot.close)
                commission_entry = calculate_commission(trade_value=trade_value, commission_rate=commission_rate)
                total_cost = quantize_value(trade_value + commission_entry)
                if total_cost <= cash:
                    cash = quantize_value(cash - total_cost)
                    quantity = buy_quantity
                    average_price = snapshot.close
                    open_trade = {
                        "asset_id": snapshot.asset_id,
                        "entry_timestamp": snapshot.timestamp,
                        "entry_price": snapshot.close,
                        "quantity": quantity,
                        "commission_entry": commission_entry,
                    }
            elif signal_type == SIGNAL_SELL and quantity > 0 and open_trade is not None:
                trade_value = quantize_value(quantity * snapshot.close)
                commission_exit = calculate_commission(trade_value=trade_value, commission_rate=commission_rate)
                gross_pnl = quantize_value((snapshot.close - average_price) * quantity)
                net_pnl = quantize_value(gross_pnl - Decimal(open_trade["commission_entry"]) - commission_exit)
                denominator = quantize_value(Decimal(open_trade["entry_price"]) * quantity + Decimal(open_trade["commission_entry"]))
                return_percent = quantize_value(net_pnl / denominator) if denominator > 0 else None
                cash = quantize_value(cash + trade_value - commission_exit)
                trades.append(
                    BacktestTradeRecord(
                        asset_id=snapshot.asset_id,
                        entry_timestamp=open_trade["entry_timestamp"],
                        entry_price=Decimal(open_trade["entry_price"]),
                        quantity=quantity,
                        commission_entry=Decimal(open_trade["commission_entry"]),
                        exit_timestamp=snapshot.timestamp,
                        exit_price=snapshot.close,
                        commission_exit=commission_exit,
                        commission_total=quantize_value(Decimal(open_trade["commission_entry"]) + commission_exit),
                        gross_pnl=gross_pnl,
                        net_pnl=net_pnl,
                        return_percent=return_percent,
                        status="CLOSED",
                    )
                )
                quantity = Decimal("0")
                average_price = Decimal("0")
                open_trade = None

            if quantity > 0:
                exposure_points += 1

            self._append_atr_history(snapshot, atr_history)

            market_value = quantize_value(quantity * snapshot.close)
            unrealized_pnl = quantize_value((snapshot.close - average_price) * quantity - (Decimal(open_trade["commission_entry"]) if open_trade else Decimal("0"))) if quantity > 0 and open_trade is not None else Decimal("0")
            equity = quantize_value(cash + market_value)
            if equity > peak_equity:
                peak_equity = equity
            drawdown = quantize_value(peak_equity - equity)
            drawdown_percent = quantize_value(drawdown / peak_equity) if peak_equity > 0 else Decimal("0")
            equity_curve.append(
                BacktestEquityPoint(
                    timestamp=snapshot.timestamp,
                    cash=cash,
                    market_value=market_value,
                    equity=equity,
                    unrealized_pnl=unrealized_pnl,
                    drawdown=drawdown,
                    drawdown_percent=drawdown_percent,
                )
            )

        if open_trade is not None and quantity > 0:
            gross_pnl = quantize_value((snapshots[-1].close - Decimal(open_trade["entry_price"])) * quantity)
            net_pnl = quantize_value(gross_pnl - Decimal(open_trade["commission_entry"]))
            denominator = quantize_value(Decimal(open_trade["entry_price"]) * quantity + Decimal(open_trade["commission_entry"]))
            return_percent = quantize_value(net_pnl / denominator) if denominator > 0 else None
            trades.append(
                BacktestTradeRecord(
                    asset_id=snapshots[-1].asset_id,
                    entry_timestamp=open_trade["entry_timestamp"],
                    entry_price=Decimal(open_trade["entry_price"]),
                    quantity=quantity,
                    commission_entry=Decimal(open_trade["commission_entry"]),
                    exit_timestamp=None,
                    exit_price=None,
                    commission_exit=Decimal("0"),
                    commission_total=Decimal(open_trade["commission_entry"]),
                    gross_pnl=gross_pnl,
                    net_pnl=net_pnl,
                    return_percent=return_percent,
                    status="OPEN",
                )
            )

        metrics = BacktestingMetrics.summarize(
            initial_cash=initial_cash,
            final_cash=cash,
            final_equity=equity_curve[-1].equity,
            trades=trades,
            equity_curve=equity_curve,
            buy_and_hold_return=buy_and_hold_return,
            exposure_points=exposure_points,
            total_points=len(snapshots),
        )

        return BacktestResult(
            initial_cash=metrics["initial_cash"],
            final_cash=metrics["final_cash"],
            final_equity=metrics["final_equity"],
            total_return=metrics["total_return"],
            total_trades=int(metrics["total_trades"]),
            winning_trades=int(metrics["winning_trades"]),
            losing_trades=int(metrics["losing_trades"]),
            win_rate=metrics["win_rate"],
            gross_profit=metrics["gross_profit"],
            gross_loss=metrics["gross_loss"],
            net_profit=metrics["net_profit"],
            total_commissions=metrics["total_commissions"],
            max_drawdown=metrics["max_drawdown"],
            max_drawdown_percent=metrics["max_drawdown_percent"],
            average_trade=metrics["average_trade"],
            median_trade=metrics["median_trade"],
            best_trade=metrics["best_trade"],
            worst_trade=metrics["worst_trade"],
            average_winner=metrics["average_winner"],
            average_loser=metrics["average_loser"],
            expectancy=metrics["expectancy"],
            profit_factor=metrics["profit_factor"],
            buy_and_hold_return=metrics["buy_and_hold_return"],
            strategy_return=metrics["strategy_return"],
            strategy_minus_buy_hold=metrics["strategy_minus_buy_hold"],
            exposure_time_percent=metrics["exposure_time_percent"],
            closed_trade_records=int(metrics["closed_trade_records"]),
            open_trade_records=int(metrics["open_trade_records"]),
            trades=trades,
            equity_curve=equity_curve,
            configuration={
                "strategy": strategy,
                "initial_cash": format(initial_cash, "f"),
                "commission_rate": format(commission_rate, "f"),
                "position_size_percent": format(position_size_percent, "f"),
                "execution_model": "close_at_signal_timestamp",
                "market_mode": "LONG_FLAT_ONLY",
            },
        )
