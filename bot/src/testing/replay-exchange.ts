import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Candle } from '../bybit/types.js';

/**
 * A Bybit stand-in whose prices come from a real candle series.
 *
 * Unlike the plain mock, this one honours stops and targets the way the exchange
 * does — evaluating them against each bar's high and low — so an end-to-end test
 * exercises the part of the design that matters most: that a position is
 * protected by the venue, not by the bot process.
 */
export class ReplayExchange {
  private server: http.Server | null = null;
  private position: Record<string, string> | null = null;
  equity = 50;
  cursor = 0;
  readonly orders: Array<Record<string, string>> = [];
  /** Entries with the price they actually filled at, for asserting risk sizing. */
  readonly fills: Array<{ side: string; qty: number; entry: number; stop: number; takeProfit: number }> = [];
  readonly closes: Array<{ exit: number; pnl: number; reason: string }> = [];
  private readonly ledger: Array<Record<string, string>> = [];

  constructor(
    private readonly candles: Candle[],
    private readonly symbol: string,
    private readonly opts: { apiKey: string; apiSecret: string; takerFeeRate?: number } ,
  ) {}

  get price(): number { return this.candles[this.cursor]!.close; }

  async listen(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  /** Advances to the next bar, applying any stop or target it touches. */
  step(): void {
    const bar = this.candles[this.cursor];
    if (!bar || !this.position) return;
    const sl = Number(this.position.stopLoss);
    const tp = Number(this.position.takeProfit);
    const long = this.position.side === 'Buy';
    // Stop before target when a bar spans both — the conservative reading.
    if (sl && (long ? bar.low <= sl : bar.high >= sl)) return this.settle(sl, 'STOP');
    if (tp && (long ? bar.high >= tp : bar.low <= tp)) return this.settle(tp, 'TARGET');
  }

  private settle(exit: number, reason: string): void {
    const p = this.position;
    if (!p) return;
    const qty = Number(p.size);
    const dir = p.side === 'Buy' ? 1 : -1;
    const fee = qty * exit * (this.opts.takerFeeRate ?? 0.00055) * 2;
    const pnl = (exit - Number(p.avgPrice)) * qty * dir - fee;
    this.equity += pnl;
    this.ledger.unshift({
      symbol: this.symbol, side: p.side!, closedPnl: String(pnl),
      updatedTime: String(Date.now()), orderId: 'replay',
    });
    this.closes.push({ exit, pnl, reason });
    this.position = null;
  }

  private verify(req: http.IncomingMessage, payload: string): boolean {
    const ts = req.headers['x-bapi-timestamp'] as string;
    const expected = crypto.createHmac('sha256', this.opts.apiSecret)
      .update(`${ts}${this.opts.apiKey}${req.headers['x-bapi-recv-window']}${payload}`).digest('hex');
    return expected === req.headers['x-bapi-sign'];
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (result: unknown, retCode = 0) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ retCode, retMsg: 'OK', result, time: Date.now() }));
    };

    const isPrivate = /^\/v5\/(account|position|order)/.test(url.pathname);
    if (isPrivate && !this.verify(req, req.method === 'GET' ? url.search.slice(1) : body)) {
      return send({}, 10004);
    }

    const price = this.price;
    const unrealised = this.position
      ? (price - Number(this.position.avgPrice)) * Number(this.position.size) * (this.position.side === 'Buy' ? 1 : -1)
      : 0;

    switch (url.pathname) {
      case '/v5/market/time':
        return send({ timeNano: String(Date.now() * 1e6) });
      case '/v5/market/instruments-info':
        return send({ list: [{
          symbol: this.symbol,
          priceFilter: { tickSize: '0.001' },
          lotSizeFilter: { qtyStep: '0.1', minOrderQty: '0.1', maxOrderQty: '10000', minNotionalValue: '5' },
          leverageFilter: { maxLeverage: '25' },
        }] });
      case '/v5/market/tickers':
        return send({ list: [{
          symbol: this.symbol, lastPrice: String(price),
          bid1Price: String(price * 0.99995), ask1Price: String(price * 1.00005),
        }] });
      case '/v5/market/kline': {
        const limit = Number(url.searchParams.get('limit') ?? 200);
        const slice = this.candles.slice(Math.max(0, this.cursor - limit + 1), this.cursor + 1);
        return send({ list: slice.map((c) => [
          String(c.time), String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), '0',
        ]).reverse() });
      }
      case '/v5/account/wallet-balance':
        return send({ list: [{
          totalEquity: String(this.equity + unrealised),
          totalAvailableBalance: String(this.equity),
          coin: [{ coin: 'USDT', equity: String(this.equity + unrealised), walletBalance: String(this.equity) }],
        }] });
      case '/v5/position/list':
        return send({ list: this.position ? [{
          ...this.position, markPrice: String(price), unrealisedPnl: String(unrealised),
        }] : [] });
      case '/v5/position/closed-pnl':
        return send({ list: this.ledger });
      case '/v5/position/set-leverage':
        return send({});
      case '/v5/position/trading-stop': {
        const b = JSON.parse(body) as Record<string, string>;
        if (this.position && b.stopLoss) this.position.stopLoss = b.stopLoss;
        if (this.position && b.takeProfit) this.position.takeProfit = b.takeProfit;
        return send({});
      }
      case '/v5/order/create': {
        const o = JSON.parse(body) as Record<string, string>;
        this.orders.push(o);
        if (o.reduceOnly) { this.settle(price, 'MANUAL'); return send({ orderId: 'x', orderLinkId: '' }); }
        this.fills.push({
          side: o.side!, qty: Number(o.qty), entry: price,
          stop: Number(o.stopLoss), takeProfit: Number(o.takeProfit),
        });
        this.position = {
          symbol: this.symbol, side: o.side!, size: o.qty!, avgPrice: String(price),
          markPrice: String(price), leverage: '5', stopLoss: o.stopLoss ?? '',
          takeProfit: o.takeProfit ?? '', createdTime: String(Date.now()),
        };
        return send({ orderId: 'x', orderLinkId: '' });
      }
      case '/v5/order/cancel-all':
        return send({ list: [] });
      default:
        return send({}, 10001);
    }
  }
}
