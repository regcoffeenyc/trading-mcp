import { log } from '../logger.js';
import type { BybitRest } from '../bybit/rest.js';
import type { Candle, Instrument, Position, Side, Ticker, WalletBalance } from '../bybit/types.js';
import type { Broker, ClosedTrade, OpenRequest } from './types.js';

interface TrackedPosition {
  side: Side;
  qty: number;
  entryPrice: number;
  openedAt: number;
}

/**
 * Places real orders on Bybit.
 *
 * Stops and targets are attached to the order itself, so they live on Bybit's
 * matching engine. If this process is killed, the machine reboots, or the network
 * drops for an hour, open positions are still protected.
 */
export class LiveBroker implements Broker {
  readonly kind = 'live' as const;
  private readonly instruments = new Map<string, Instrument>();
  private tracked = new Map<string, TrackedPosition>();
  private lastClosureScan = Date.now();

  constructor(private readonly rest: BybitRest) {}

  async init(symbols: string[], leverage: number): Promise<void> {
    await this.rest.syncClock();
    for (const symbol of symbols) {
      const inst = await this.rest.instrument(symbol);
      this.instruments.set(symbol, inst);
      const capped = Math.min(leverage, inst.maxLeverage);
      try {
        await this.rest.setLeverage(symbol, capped);
        log.info('Leverage set', { symbol, leverage: capped });
      } catch (err) {
        // "leverage not modified" is normal on restart; anything else is worth knowing.
        log.warn('Could not set leverage', { symbol, error: String(err) });
      }
    }
    // Adopt any position that already exists so the bot manages rather than duplicates it.
    for (const pos of await this.positions()) {
      this.tracked.set(pos.symbol, {
        side: pos.side, qty: pos.size, entryPrice: pos.entryPrice, openedAt: pos.createdTime,
      });
      log.info('Adopted existing position', { symbol: pos.symbol, side: pos.side, size: pos.size });
    }
  }

  async instrument(symbol: string): Promise<Instrument> {
    const cached = this.instruments.get(symbol);
    if (cached) return cached;
    const inst = await this.rest.instrument(symbol);
    this.instruments.set(symbol, inst);
    return inst;
  }

  ticker(symbol: string): Promise<Ticker> { return this.rest.ticker(symbol); }
  balance(): Promise<WalletBalance> { return this.rest.walletBalance(); }
  positions(): Promise<Position[]> { return this.rest.positions(); }

  async open(req: OpenRequest): Promise<void> {
    const res = await this.rest.placeMarketOrder({
      symbol: req.symbol,
      side: req.side,
      qty: req.qty,
      stopLoss: req.stopLoss,
      takeProfit: req.takeProfit,
      orderLinkId: `bot-${Date.now()}-${req.symbol}`,
    });
    log.info('Order submitted', { symbol: req.symbol, side: req.side, qty: req.qty, orderId: res.orderId });

    // Confirm the fill from the position endpoint rather than assuming it.
    const filled = (await this.positions()).find((p) => p.symbol === req.symbol);
    if (!filled) {
      log.warn('Order submitted but no position appeared yet', { symbol: req.symbol });
      return;
    }
    this.tracked.set(req.symbol, {
      side: filled.side, qty: filled.size, entryPrice: filled.entryPrice, openedAt: Date.now(),
    });
    if (!filled.stopLoss) {
      // The attached stop did not stick — set it explicitly rather than run naked.
      log.warn('Entry has no stop attached, setting it now', { symbol: req.symbol });
      await this.rest.setTradingStop(req.symbol, { stopLoss: req.stopLoss, takeProfit: req.takeProfit });
    }
  }

  async close(symbol: string, side: Side, qty: string, reason: string): Promise<void> {
    log.info('Closing position', { symbol, side, qty, reason });
    await this.rest.closePosition(symbol, side, qty);
  }

  async moveStop(symbol: string, stopLoss: string): Promise<void> {
    await this.rest.setTradingStop(symbol, { stopLoss });
    log.info('Stop moved', { symbol, stopLoss });
  }

  /**
   * Detects closures by diffing tracked positions against the exchange, then
   * reads realised P&L from Bybit's closed-P&L ledger so fees and funding are
   * included exactly as the exchange booked them.
   */
  async pollClosures(): Promise<ClosedTrade[]> {
    const live = await this.positions();
    const liveBySymbol = new Map(live.map((p) => [p.symbol, p]));
    const closed: ClosedTrade[] = [];

    for (const [symbol, tracked] of this.tracked) {
      if (liveBySymbol.has(symbol)) continue;
      const ledger = await this.rest.closedPnl(this.lastClosureScan - 60_000).catch((err) => {
        log.warn('Could not read closed P&L', { error: String(err) });
        return [];
      });
      const entry = ledger.find((e) => e.symbol === symbol);
      const pnl = entry?.closedPnl ?? 0;
      closed.push({
        symbol,
        side: tracked.side,
        qty: tracked.qty,
        entryPrice: tracked.entryPrice,
        exitPrice: entry ? tracked.entryPrice + pnl / tracked.qty * (tracked.side === 'Buy' ? 1 : -1) : tracked.entryPrice,
        pnl,
        openedAt: tracked.openedAt,
        closedAt: entry?.updatedTime ?? Date.now(),
        reason: pnl >= 0 ? 'target/exit' : 'stop/exit',
      });
      this.tracked.delete(symbol);
    }

    // Keep sizes current — a partial fill or partial close changes them.
    for (const pos of live) {
      const t = this.tracked.get(pos.symbol);
      if (t) { t.qty = pos.size; t.entryPrice = pos.entryPrice; }
      else this.tracked.set(pos.symbol, { side: pos.side, qty: pos.size, entryPrice: pos.entryPrice, openedAt: pos.createdTime });
    }

    this.lastClosureScan = Date.now();
    return closed;
  }

  onCandle(_symbol: string, _candle: Candle): void { /* live fills come from the exchange */ }
}
