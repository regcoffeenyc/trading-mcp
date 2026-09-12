import type { Candle, Instrument, Position, Side, Ticker, WalletBalance } from '../bybit/types.js';

export interface OpenRequest {
  symbol: string;
  side: Side;
  qty: string;
  stopLoss: string;
  takeProfit: string;
}

export interface EntryExecution {
  /** 'limit' rests as a maker order; 'market' crosses the spread immediately. */
  style: 'limit' | 'market';
  /** How long a resting entry is given to fill before it is cancelled. */
  timeoutSeconds: number;
  /** Ticks back from the touch, to stay behind the queue and keep PostOnly valid. */
  offsetTicks: number;
}

export interface ClosedTrade {
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  /** Net of fees. */
  pnl: number;
  openedAt: number;
  closedAt: number;
  reason: string;
}

/**
 * The engine talks only to this interface, so paper trading and live trading run
 * exactly the same code path — the only way to trust that what was tested is
 * what ships.
 */
export interface Broker {
  readonly kind: 'live' | 'paper';
  init(symbols: string[], leverage: number): Promise<void>;
  instrument(symbol: string): Promise<Instrument>;
  ticker(symbol: string): Promise<Ticker>;
  balance(): Promise<WalletBalance>;
  positions(): Promise<Position[]>;
  /**
   * Opens a position. Returns false when nothing was filled — a post-only
   * entry that never traded is a missed opportunity, and the caller must not
   * record a position that does not exist.
   */
  open(req: OpenRequest): Promise<boolean>;
  close(symbol: string, side: Side, qty: string, reason: string): Promise<void>;
  moveStop(symbol: string, stopLoss: string): Promise<void>;
  /**
   * Returns trades that closed since the last call — stop-outs, targets, and
   * manual closes alike. The engine uses this to update streaks and daily P&L.
   */
  pollClosures(): Promise<ClosedTrade[]>;
  /** Paper broker only: advance the simulation with a new bar. No-op when live. */
  onCandle?(symbol: string, candle: Candle): void;
}
