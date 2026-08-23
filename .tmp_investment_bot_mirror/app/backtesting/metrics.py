from __future__ import annotations

from decimal import Decimal

from app.backtesting.models import BacktestEquityPoint, BacktestTradeRecord, quantize_value


class BacktestingMetrics:
    @staticmethod
    def median(values: list[Decimal]) -> Decimal | None:
        if not values:
            return None
        ordered = sorted(values)
        midpoint = len(ordered) // 2
        if len(ordered) % 2 == 1:
            return quantize_value(ordered[midpoint])
        return quantize_value((ordered[midpoint - 1] + ordered[midpoint]) / Decimal("2"))

    @staticmethod
    def average(values: list[Decimal]) -> Decimal | None:
        if not values:
            return None
        return quantize_value(sum(values, Decimal("0")) / Decimal(len(values)))

    @staticmethod
    def summarize(
        *,
        initial_cash: Decimal,
        final_cash: Decimal,
        final_equity: Decimal,
        trades: list[BacktestTradeRecord],
        equity_curve: list[BacktestEquityPoint],
        buy_and_hold_return: Decimal | None,
        exposure_points: int,
        total_points: int,
    ) -> dict[str, Decimal | int | None]:
        closed_trades = [trade for trade in trades if trade.status == "CLOSED"]
        total_trades = len(closed_trades)
        winning_trades = sum(1 for trade in closed_trades if trade.net_pnl > 0)
        losing_trades = sum(1 for trade in closed_trades if trade.net_pnl < 0)
        gross_profit = quantize_value(sum((trade.gross_pnl for trade in closed_trades if trade.gross_pnl > 0), Decimal("0")))
        gross_loss = quantize_value(sum((trade.gross_pnl for trade in closed_trades if trade.gross_pnl < 0), Decimal("0")))
        total_commissions = quantize_value(sum((trade.commission_total for trade in trades), Decimal("0")))
        net_profit = quantize_value(final_equity - initial_cash)
        total_return = quantize_value(net_profit / initial_cash) if initial_cash else Decimal("0")
        strategy_return = total_return
        win_rate = quantize_value(Decimal(winning_trades) / Decimal(total_trades)) if total_trades else Decimal("0")
        loss_rate = quantize_value(Decimal(losing_trades) / Decimal(total_trades)) if total_trades else Decimal("0")

        trade_net_pnls = [trade.net_pnl for trade in closed_trades]
        winners = [trade.net_pnl for trade in closed_trades if trade.net_pnl > 0]
        losers = [trade.net_pnl for trade in closed_trades if trade.net_pnl < 0]
        average_trade = BacktestingMetrics.average(trade_net_pnls)
        median_trade = BacktestingMetrics.median(trade_net_pnls)
        best_trade = quantize_value(max(trade_net_pnls)) if trade_net_pnls else None
        worst_trade = quantize_value(min(trade_net_pnls)) if trade_net_pnls else None
        average_winner = BacktestingMetrics.average(winners)
        average_loser = BacktestingMetrics.average(losers)

        expectancy = None
        if total_trades:
            winner_component = win_rate * (average_winner if average_winner is not None else Decimal("0"))
            loser_component = loss_rate * abs(average_loser if average_loser is not None else Decimal("0"))
            expectancy = quantize_value(winner_component - loser_component)

        profit_factor = None if gross_loss == 0 else quantize_value(gross_profit / abs(gross_loss))
        max_drawdown = quantize_value(max((point.drawdown for point in equity_curve), default=Decimal("0")))
        max_drawdown_percent = quantize_value(max((point.drawdown_percent for point in equity_curve), default=Decimal("0")))
        exposure_time_percent = quantize_value(Decimal(exposure_points) / Decimal(total_points)) if total_points else Decimal("0")
        strategy_minus_buy_hold = None if buy_and_hold_return is None else quantize_value(strategy_return - buy_and_hold_return)

        return {
            "initial_cash": quantize_value(initial_cash),
            "final_cash": quantize_value(final_cash),
            "final_equity": quantize_value(final_equity),
            "total_return": total_return,
            "strategy_return": strategy_return,
            "strategy_minus_buy_hold": strategy_minus_buy_hold,
            "total_trades": total_trades,
            "winning_trades": winning_trades,
            "losing_trades": losing_trades,
            "win_rate": win_rate,
            "gross_profit": gross_profit,
            "gross_loss": gross_loss,
            "net_profit": net_profit,
            "total_commissions": total_commissions,
            "max_drawdown": max_drawdown,
            "max_drawdown_percent": max_drawdown_percent,
            "average_trade": average_trade,
            "median_trade": median_trade,
            "best_trade": best_trade,
            "worst_trade": worst_trade,
            "average_winner": average_winner,
            "average_loser": average_loser,
            "expectancy": expectancy,
            "profit_factor": profit_factor,
            "buy_and_hold_return": quantize_value(buy_and_hold_return) if buy_and_hold_return is not None else None,
            "exposure_time_percent": exposure_time_percent,
            "closed_trade_records": total_trades,
            "open_trade_records": len(trades) - total_trades,
        }
