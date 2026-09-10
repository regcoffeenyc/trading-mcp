import type { Candle, Side } from '../bybit/types.js';

export interface Signal {
  side: Side;
  /** Price the signal is based on — the close of the bar that produced it. */
  price: number;
  /** Absolute stop price. Position size is derived from the distance to it. */
  stopLoss: number;
  takeProfit: number;
  /** ATR at signal time, carried through for breakeven/trailing management. */
  atr: number;
  reason: string;
}

export interface StrategyContext {
  symbol: string;
  /** Closed candles only, oldest first. */
  candles: Candle[];
  stopAtrMult: number;
  takeProfitR: number;
  minAtrPct: number;
}

export interface Strategy {
  readonly name: string;
  /** Bars required before the strategy will emit anything. */
  readonly warmupBars: number;
  evaluate(ctx: StrategyContext): Signal | null;
}

/**
 * How many bars of history a strategy is given.
 *
 * Three times the warmup so the longest EMA is well converged, and — critically
 * — the SAME number live and in backtests. Live can only ever hold a bounded
 * buffer, so a backtest that fed the strategy unlimited history would compute
 * subtly different indicator values than the running bot and report results it
 * could never reproduce. It also keeps the backtest linear instead of
 * quadratic in the length of the history.
 */
export function strategyWindow(warmupBars: number): number {
  return warmupBars * 3;
}
