import { log } from '../logger.js';
import { roundToStep, sleep } from '../util.js';
import type { BybitRest } from '../bybit/rest.js';
import type { Candle, Instrument, Position, Side, Ticker, WalletBalance } from '../bybit/types.js';
import type { Broker, ClosedTrade, EntryExecution, OpenRequest } from './types.js';

interface TrackedPosition {
  side: Side;
  qty: number;
  entryPrice: number;
  openedAt: number;
}

/**
 * A position that vanished from the exchange but whose realised P&L has not
 * appeared in the closed-P&L ledger yet.
 */
interface PendingClosure {
  tracked: TrackedPosition;
  symbol: string;
  detectedAt: number;
  attempts: number;
}

/** How many polls to wait for the ledger before booking the trade regardless. */
const MAX_LEDGER_ATTEMPTS = 8;

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
  private readonly pending = new Map<string, PendingClosure>();

  constructor(private readonly rest: BybitRest, private readonly entry: EntryExecution) {}

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

  async open(req: OpenRequest): Promise<boolean> {
    const res = this.entry.style === 'limit'
      ? await this.openWithLimit(req)
      : await this.openWithMarket(req);
    if (!res) return false;

    // Confirm against the position endpoint rather than trusting the order.
    const filled = (await this.positions()).find((p) => p.symbol === req.symbol);
    if (!filled) {
      log.warn('Order reported filled but no position appeared', { symbol: req.symbol });
      return false;
    }
    this.tracked.set(req.symbol, {
      side: filled.side, qty: filled.size, entryPrice: filled.entryPrice, openedAt: Date.now(),
    });
    if (!filled.stopLoss) {
      // The attached stop did not stick — set it explicitly rather than run naked.
      log.warn('Entry has no stop attached, setting it now', { symbol: req.symbol });
      await this.rest.setTradingStop(req.symbol, { stopLoss: req.stopLoss, takeProfit: req.takeProfit });
    }
    return true;
  }

  private async openWithMarket(req: OpenRequest): Promise<boolean> {
    const res = await this.rest.placeMarketOrder({
      symbol: req.symbol,
      side: req.side,
      qty: req.qty,
      stopLoss: req.stopLoss,
      takeProfit: req.takeProfit,
      orderLinkId: `bot-${Date.now()}-${req.symbol}`,
    });
    log.info('Market order submitted', { symbol: req.symbol, side: req.side, qty: req.qty, orderId: res.orderId });
    return true;
  }

  /**
   * Rests a post-only order just behind the touch and waits for it to fill.
   *
   * Maker execution costs 0.02% against 0.055% taker — on a round trip that is
   * the difference between giving up 0.11% and 0.04%, which matters more than
   * it sounds on a strategy whose edge is thin. The price is that the order may
   * not fill at all, so this returns false and the signal is simply skipped
   * rather than chased across the spread.
   */
  private async openWithLimit(req: OpenRequest): Promise<boolean> {
    const inst = await this.instrument(req.symbol);
    const ticker = await this.rest.ticker(req.symbol);
    const tick = Number(inst.tickSize);

    // Sit behind the touch: a buy below the bid, a sell above the ask. Posting
    // at the touch risks PostOnly rejection if the book moves first.
    const offset = tick * this.entry.offsetTicks;
    const raw = req.side === 'Buy' ? ticker.bid - offset : ticker.ask + offset;
    const price = roundToStep(raw, inst.tickSize);

    let order: { orderId: string };
    try {
      order = await this.rest.placePostOnlyLimit({
        symbol: req.symbol,
        side: req.side,
        qty: req.qty,
        price,
        stopLoss: req.stopLoss,
        takeProfit: req.takeProfit,
        orderLinkId: `bot-${Date.now()}-${req.symbol}`,
      });
    } catch (err) {
      // 30208/110094: PostOnly would have crossed. The book moved; skip the bar.
      log.info('Post-only entry rejected, skipping', { symbol: req.symbol, price, error: String(err) });
      return false;
    }

    log.info('Post-only entry resting', {
      symbol: req.symbol, side: req.side, qty: req.qty, price,
      bid: ticker.bid, ask: ticker.ask, timeoutSeconds: this.entry.timeoutSeconds,
    });

    const deadline = Date.now() + this.entry.timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const status = await this.rest.orderStatus(req.symbol, order.orderId).catch(() => null);
      if (!status) continue;
      if (status.status === 'Filled') {
        log.info('Post-only entry filled', { symbol: req.symbol, price: status.avgPrice, qty: status.filledQty });
        return true;
      }
      if (status.status === 'Cancelled' || status.status === 'Rejected') {
        log.info('Post-only entry did not survive', { symbol: req.symbol, status: status.status });
        return false;
      }
    }

    // Out of time. Cancel, and keep a partial fill if one happened.
    await this.rest.cancelOrder(req.symbol, order.orderId).catch(() => undefined);
    const final = await this.rest.orderStatus(req.symbol, order.orderId).catch(() => null);
    const partial = (final?.filledQty ?? 0) > 0;
    log.info(partial ? 'Post-only entry partially filled, keeping it' : 'Post-only entry unfilled, cancelled', {
      symbol: req.symbol, filledQty: final?.filledQty ?? 0,
    });
    return partial;
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
   *
   * The ledger lags the position disappearing by a moment, so a closure is held
   * back until its entry appears rather than being booked as a zero — recording
   * a stop-out as break-even would corrupt the losing-streak counter and the
   * day's realised P&L.
   */
  async pollClosures(): Promise<ClosedTrade[]> {
    const live = await this.positions();
    const liveBySymbol = new Map(live.map((p) => [p.symbol, p]));

    // Anything tracked but no longer on the exchange has closed.
    for (const [symbol, tracked] of this.tracked) {
      if (liveBySymbol.has(symbol)) continue;
      this.tracked.delete(symbol);
      if (!this.pending.has(symbol)) {
        this.pending.set(symbol, { tracked, symbol, detectedAt: Date.now(), attempts: 0 });
      }
    }

    const closed: ClosedTrade[] = [];
    if (this.pending.size > 0) {
      const earliest = Math.min(...[...this.pending.values()].map((p) => p.detectedAt));
      const ledger = await this.rest.closedPnl(earliest - 5 * 60_000).catch((err) => {
        log.warn('Could not read closed P&L', { error: String(err) });
        return [];
      });

      for (const entry of [...this.pending.values()]) {
        entry.attempts += 1;
        const booked = ledger
          .filter((e) => e.symbol === entry.symbol && e.updatedTime >= entry.detectedAt - 5 * 60_000)
          .sort((a, b) => b.updatedTime - a.updatedTime)[0];

        if (!booked) {
          if (entry.attempts < MAX_LEDGER_ATTEMPTS) continue;
          // Give up waiting. Equity-based guards still hold the daily limit, but
          // the streak counter needs a verdict, so treat an unknown as a loss.
          log.warn('Closed P&L never appeared; booking the trade as unknown', {
            symbol: entry.symbol, attempts: entry.attempts,
          });
          this.pending.delete(entry.symbol);
          closed.push(this.toClosedTrade(entry.tracked, entry.symbol, 0, Date.now(), 'closed-unknown-pnl'));
          continue;
        }

        this.pending.delete(entry.symbol);
        closed.push(this.toClosedTrade(
          entry.tracked, entry.symbol, booked.closedPnl, booked.updatedTime,
          booked.closedPnl >= 0 ? 'target/exit' : 'stop/exit',
        ));
      }
    }

    // Keep sizes current — a partial fill or partial close changes them.
    for (const pos of live) {
      const t = this.tracked.get(pos.symbol);
      if (t) { t.qty = pos.size; t.entryPrice = pos.entryPrice; }
      else this.tracked.set(pos.symbol, { side: pos.side, qty: pos.size, entryPrice: pos.entryPrice, openedAt: pos.createdTime });
    }

    return closed;
  }

  private toClosedTrade(
    tracked: TrackedPosition, symbol: string, pnl: number, closedAt: number, reason: string,
  ): ClosedTrade {
    const dir = tracked.side === 'Buy' ? 1 : -1;
    // Back out the effective exit price from realised P&L, for the trade log.
    const exitPrice = tracked.qty > 0 ? tracked.entryPrice + (pnl / tracked.qty) * dir : tracked.entryPrice;
    return {
      symbol,
      side: tracked.side,
      qty: tracked.qty,
      entryPrice: tracked.entryPrice,
      exitPrice,
      pnl,
      openedAt: tracked.openedAt,
      closedAt,
      reason,
    };
  }

  onCandle(_symbol: string, _candle: Candle): void { /* live fills come from the exchange */ }
}
