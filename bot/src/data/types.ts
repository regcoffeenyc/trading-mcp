import type { Candle, Instrument, Ticker } from '../bybit/types.js';

/**
 * The read-only market data the bot needs.
 *
 * Both the Bybit REST client and the OKX fallback satisfy this, which is what
 * lets paper trading run in a region where Bybit's API is blocked. Placing
 * orders is deliberately NOT part of this interface — execution always goes
 * through Bybit.
 */
export interface MarketData {
  readonly venue: 'bybit' | 'okx';
  instrument(symbol: string): Promise<Instrument>;
  ticker(symbol: string): Promise<Ticker>;
  klines(symbol: string, interval: string, limit?: number): Promise<Candle[]>;
}
