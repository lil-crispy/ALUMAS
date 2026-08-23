from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

VALUE_QUANT = Decimal("0.00000001")


def quantize_value(value: Decimal) -> Decimal:
    return value.quantize(VALUE_QUANT, rounding=ROUND_HALF_UP)


def format_decimal(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return format(quantize_value(value), "f")


@dataclass(frozen=True)
class BacktestSignalSnapshot:
    asset_id: int
    asset_symbol: str
    timeframe: str
    timestamp: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    indicator_values: dict[str, Decimal]

    @property
    def has_required_indicators(self) -> bool:
        required = {"EMA_20", "EMA_50", "RSI_14", "MACD", "MACD_SIGNAL"}
        return required.issubset(self.indicator_values)


@dataclass(frozen=True)
class BacktestTradeRecord:
    asset_id: int
    entry_timestamp: datetime
    entry_price: Decimal
    quantity: Decimal
    commission_entry: Decimal
    exit_timestamp: datetime | None
    exit_price: Decimal | None
    commission_exit: Decimal
    commission_total: Decimal
    gross_pnl: Decimal
    net_pnl: Decimal
    return_percent: Decimal | None
    status: str

    def to_dict(self) -> dict[str, object]:
        return {
            "asset_id": self.asset_id,
            "entry_timestamp": self.entry_timestamp.isoformat(),
            "entry_price": format_decimal(self.entry_price),
            "exit_timestamp": self.exit_timestamp.isoformat() if self.exit_timestamp else None,
            "exit_price": format_decimal(self.exit_price),
            "quantity": format_decimal(self.quantity),
            "commission_entry": format_decimal(self.commission_entry),
            "commission_exit": format_decimal(self.commission_exit),
            "commission_total": format_decimal(self.commission_total),
            "gross_pnl": format_decimal(self.gross_pnl),
            "net_pnl": format_decimal(self.net_pnl),
            "return_percent": format_decimal(self.return_percent),
            "status": self.status,
        }


@dataclass(frozen=True)
class BacktestEquityPoint:
    timestamp: datetime
    cash: Decimal
    market_value: Decimal
    equity: Decimal
    unrealized_pnl: Decimal
    drawdown: Decimal
    drawdown_percent: Decimal

    def to_dict(self) -> dict[str, object]:
        return {
            "timestamp": self.timestamp.isoformat(),
            "cash": format_decimal(self.cash),
            "market_value": format_decimal(self.market_value),
            "equity": format_decimal(self.equity),
            "unrealized_pnl": format_decimal(self.unrealized_pnl),
            "drawdown": format_decimal(self.drawdown),
            "drawdown_percent": format_decimal(self.drawdown_percent),
        }


@dataclass(frozen=True)
class BacktestResult:
    initial_cash: Decimal
    final_cash: Decimal
    final_equity: Decimal
    total_return: Decimal
    total_trades: int
    winning_trades: int
    losing_trades: int
    win_rate: Decimal
    gross_profit: Decimal
    gross_loss: Decimal
    net_profit: Decimal
    total_commissions: Decimal
    max_drawdown: Decimal
    max_drawdown_percent: Decimal
    average_trade: Decimal | None
    median_trade: Decimal | None
    best_trade: Decimal | None
    worst_trade: Decimal | None
    average_winner: Decimal | None
    average_loser: Decimal | None
    expectancy: Decimal | None
    profit_factor: Decimal | None
    buy_and_hold_return: Decimal | None
    strategy_return: Decimal
    strategy_minus_buy_hold: Decimal | None
    exposure_time_percent: Decimal
    closed_trade_records: int
    open_trade_records: int
    trades: list[BacktestTradeRecord]
    equity_curve: list[BacktestEquityPoint]
    configuration: dict[str, Any]

    def to_dict(self, *, run_id: int | None = None) -> dict[str, object]:
        return {
            "run_id": run_id,
            "initial_cash": format_decimal(self.initial_cash),
            "final_cash": format_decimal(self.final_cash),
            "final_equity": format_decimal(self.final_equity),
            "total_return": format_decimal(self.total_return),
            "strategy_return": format_decimal(self.strategy_return),
            "strategy_minus_buy_hold": format_decimal(self.strategy_minus_buy_hold),
            "total_trades": self.total_trades,
            "winning_trades": self.winning_trades,
            "losing_trades": self.losing_trades,
            "win_rate": format_decimal(self.win_rate),
            "gross_profit": format_decimal(self.gross_profit),
            "gross_loss": format_decimal(self.gross_loss),
            "net_profit": format_decimal(self.net_profit),
            "total_commissions": format_decimal(self.total_commissions),
            "max_drawdown": format_decimal(self.max_drawdown),
            "max_drawdown_percent": format_decimal(self.max_drawdown_percent),
            "average_trade": format_decimal(self.average_trade),
            "median_trade": format_decimal(self.median_trade),
            "best_trade": format_decimal(self.best_trade),
            "worst_trade": format_decimal(self.worst_trade),
            "average_winner": format_decimal(self.average_winner),
            "average_loser": format_decimal(self.average_loser),
            "expectancy": format_decimal(self.expectancy),
            "profit_factor": format_decimal(self.profit_factor),
            "buy_and_hold_return": format_decimal(self.buy_and_hold_return),
            "exposure_time_percent": format_decimal(self.exposure_time_percent),
            "closed_trade_records": self.closed_trade_records,
            "open_trade_records": self.open_trade_records,
            "total_equity_points": len(self.equity_curve),
            "total_trade_records": len(self.trades),
            "configuration": self.configuration,
        }
