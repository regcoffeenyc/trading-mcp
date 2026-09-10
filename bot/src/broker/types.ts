import type { Candle, Instrument, Position, Side, Ticker, WalletBalance } from '../bybit/types.js';

export interface OpenRequest {
  symbol: string;
  side: Side;
  qty: string;
  stopLoss: string;
  takeProfit: string;
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
  open(req: OpenRequest): Promise<void>;
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
