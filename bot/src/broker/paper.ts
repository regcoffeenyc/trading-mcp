import { log } from '../logger.js';
import type { MarketData } from '../data/types.js';
import type { Candle, Instrument, Position, Side, Ticker, WalletBalance } from '../bybit/types.js';
import type { Broker, ClosedTrade, OpenRequest } from './types.js';

interface PaperPosition {
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  markPrice: number;
  openedAt: number;
}

export interface PaperOptions {
  startingEquity: number;
  takerFeeRate: number;
  /** One-way slippage as a percentage of price, applied on entry and exit. */
  slippagePct: number;
}

/**
 * Simulated execution against the live market feed.
 *
 * Charges the same taker fee Bybit does and applies slippage on both sides, so
 * paper results are pessimistic rather than flattering. Stops and targets are
 * evaluated against each bar's high and low; when a bar spans both, the stop is
 * assumed to fill first — the conservative reading, since intrabar order is
 * unknowable from candle data.
 */
export class PaperBroker implements Broker {
  readonly kind = 'paper' as const;
  private equity: number;
  private readonly positions_ = new Map<string, PaperPosition>();
  private readonly instruments = new Map<string, Instrument>();
  private pending: ClosedTrade[] = [];

  constructor(private readonly rest: MarketData, private readonly opts: PaperOptions) {
    this.equity = opts.startingEquity;
  }

  /** Cash balance excluding open-position P&L — the figure that is persisted. */
  get cashEquity(): number { return this.equity; }

  /** Restores a previous run's balance so a restart continues the same curve. */
  restoreEquity(equity: number): void {
    if (Number.isFinite(equity) && equity > 0) this.equity = equity;
  }

  async init(symbols: string[], _leverage: number): Promise<void> {
    for (const symbol of symbols) {
      this.instruments.set(symbol, await this.rest.instrument(symbol));
    }
    log.info('Paper broker ready', { equity: this.equity.toFixed(2), venue: this.rest.venue });
  }

  async instrument(symbol: string): Promise<Instrument> {
    const cached = this.instruments.get(symbol);
    if (cached) return cached;
    const inst = await this.rest.instrument(symbol);
    this.instruments.set(symbol, inst);
    return inst;
  }

  ticker(symbol: string): Promise<Ticker> { return this.rest.ticker(symbol); }

  async balance(): Promise<WalletBalance> {
    const unrealised = [...this.positions_.values()].reduce((sum, p) => sum + this.unrealised(p), 0);
    const used = [...this.positions_.values()].reduce((sum, p) => sum + p.qty * p.entryPrice, 0);
    return { equity: this.equity + unrealised, available: Math.max(0, this.equity - used / 10) };
  }

  async positions(): Promise<Position[]> {
    return [...this.positions_.values()].map((p) => ({
      symbol: p.symbol,
      side: p.side,
      size: p.qty,
      entryPrice: p.entryPrice,
      markPrice: p.markPrice,
      unrealisedPnl: this.unrealised(p),
      leverage: 1,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      createdTime: p.openedAt,
    }));
  }

  async open(req: OpenRequest): Promise<void> {
    const ticker = await this.ticker(req.symbol);
    const slip = 1 + (req.side === 'Buy' ? 1 : -1) * (this.opts.slippagePct / 100);
    const fill = ticker.lastPrice * slip;
    const qty = Number(req.qty);
    this.equity -= qty * fill * this.opts.takerFeeRate;
    this.positions_.set(req.symbol, {
      symbol: req.symbol,
      side: req.side,
      qty,
      entryPrice: fill,
      stopLoss: Number(req.stopLoss),
      takeProfit: Number(req.takeProfit),
      markPrice: fill,
      openedAt: Date.now(),
    });
    log.info('[paper] Opened', { symbol: req.symbol, side: req.side, qty, entry: fill.toFixed(4) });
  }

  async close(symbol: string, _side: Side, _qty: string, reason: string): Promise<void> {
    const pos = this.positions_.get(symbol);
    if (!pos) return;
    const ticker = await this.ticker(symbol);
    this.settle(pos, ticker.lastPrice, reason);
  }

  async moveStop(symbol: string, stopLoss: string): Promise<void> {
    const pos = this.positions_.get(symbol);
    if (pos) pos.stopLoss = Number(stopLoss);
  }

  async pollClosures(): Promise<ClosedTrade[]> {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** Drives stop/target fills from live bars. */
  onCandle(symbol: string, candle: Candle): void {
    const pos = this.positions_.get(symbol);
    if (!pos) return;
    pos.markPrice = candle.close;

    if (pos.side === 'Buy') {
      if (candle.low <= pos.stopLoss) return this.settle(pos, pos.stopLoss, 'stop');
      if (candle.high >= pos.takeProfit) return this.settle(pos, pos.takeProfit, 'target');
    } else {
      if (candle.high >= pos.stopLoss) return this.settle(pos, pos.stopLoss, 'stop');
      if (candle.low <= pos.takeProfit) return this.settle(pos, pos.takeProfit, 'target');
    }
  }

  private unrealised(p: PaperPosition): number {
    const dir = p.side === 'Buy' ? 1 : -1;
    return (p.markPrice - p.entryPrice) * p.qty * dir;
  }

  private settle(pos: PaperPosition, rawExit: number, reason: string): void {
    const slip = 1 - (pos.side === 'Buy' ? 1 : -1) * (this.opts.slippagePct / 100);
    const exit = rawExit * slip;
    const dir = pos.side === 'Buy' ? 1 : -1;
    const gross = (exit - pos.entryPrice) * pos.qty * dir;
    const exitFee = pos.qty * exit * this.opts.takerFeeRate;
    const pnl = gross - exitFee;
    this.equity += pnl;
    this.positions_.delete(pos.symbol);
    this.pending.push({
      symbol: pos.symbol,
      side: pos.side,
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      exitPrice: exit,
      pnl,
      openedAt: pos.openedAt,
      closedAt: Date.now(),
      reason,
    });
    log.info('[paper] Closed', { symbol: pos.symbol, reason, pnl: pnl.toFixed(4), equity: this.equity.toFixed(2) });
  }
}
