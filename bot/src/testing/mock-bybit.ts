import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A minimal stand-in for Bybit's V5 REST API, used by the integration tests.
 *
 * It verifies the HMAC signature on every authenticated call exactly the way
 * Bybit does, so a signing regression fails the test suite rather than surfacing
 * as a rejected order on a live account.
 */
export interface MockOptions {
  apiKey: string;
  apiSecret: string;
  price?: number;
  equity?: number;
}

export interface MockPosition {
  symbol: string;
  side: 'Buy' | 'Sell';
  size: string;
  avgPrice: string;
  markPrice: string;
  unrealisedPnl: string;
  leverage: string;
  stopLoss: string;
  takeProfit: string;
  createdTime: string;
}

export class MockBybit {
  private server: http.Server | null = null;
  price: number;
  equity: number;
  positions: MockPosition[] = [];
  closedPnl: Array<{ symbol: string; side: string; closedPnl: string; updatedTime: string; orderId: string }> = [];
  readonly orders: Array<Record<string, unknown>> = [];
  readonly tradingStops: Array<Record<string, unknown>> = [];
  /** Set to a retCode to make the next order attempt fail, exercising error paths. */
  failNextOrderWith: number | null = null;
  signatureFailures = 0;

  constructor(private readonly opts: MockOptions) {
    this.price = opts.price ?? 100;
    this.equity = opts.equity ?? 50;
  }

  async listen(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private verifySignature(req: http.IncomingMessage, payload: string): boolean {
    const ts = req.headers['x-bapi-timestamp'] as string;
    const key = req.headers['x-bapi-api-key'] as string;
    const recv = req.headers['x-bapi-recv-window'] as string;
    const sign = req.headers['x-bapi-sign'] as string;
    if (!ts || !key || !recv || !sign) return false;
    if (key !== this.opts.apiKey) return false;
    const expected = crypto
      .createHmac('sha256', this.opts.apiSecret)
      .update(`${ts}${key}${recv}${payload}`)
      .digest('hex');
    return expected === sign;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const query = url.search.slice(1);

    const send = (result: unknown, retCode = 0, retMsg = 'OK') => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ retCode, retMsg, result, time: Date.now() }));
    };

    const isPrivate = path.startsWith('/v5/account') || path.startsWith('/v5/position') || path.startsWith('/v5/order');
    if (isPrivate && !this.verifySignature(req, req.method === 'GET' ? query : body)) {
      this.signatureFailures++;
      return send({}, 10004, 'error sign!');
    }

    switch (path) {
      case '/v5/market/time':
        return send({ timeSecond: String(Math.floor(Date.now() / 1000)), timeNano: String(Date.now() * 1e6) });

      case '/v5/market/instruments-info':
        return send({
          list: [{
            symbol: url.searchParams.get('symbol'),
            priceFilter: { tickSize: '0.01' },
            lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', maxOrderQty: '100', minNotionalValue: '5' },
            leverageFilter: { maxLeverage: '25' },
          }],
        });

      case '/v5/market/tickers':
        return send({
          list: [{
            symbol: url.searchParams.get('symbol'),
            lastPrice: String(this.price),
            bid1Price: String(this.price * 0.9999),
            ask1Price: String(this.price * 1.0001),
          }],
        });

      case '/v5/market/kline': {
        const limit = Number(url.searchParams.get('limit') ?? 200);
        const end = Number(url.searchParams.get('end') ?? Date.now());
        // Newest-first, exactly like Bybit.
        const list = Array.from({ length: limit }, (_, i) => {
          const time = end - i * 900_000;
          const p = this.price + Math.sin(time / 1e7) * 2;
          return [String(time), String(p), String(p + 1), String(p - 1), String(p), '100', '10000'];
        });
        return send({ category: 'linear', symbol: url.searchParams.get('symbol'), list });
      }

      case '/v5/account/wallet-balance':
        return send({
          list: [{
            accountType: 'UNIFIED',
            totalEquity: String(this.equity),
            totalAvailableBalance: String(this.equity),
            coin: [{ coin: 'USDT', equity: String(this.equity), walletBalance: String(this.equity) }],
          }],
        });

      case '/v5/position/list':
        return send({ list: this.positions });

      case '/v5/position/closed-pnl':
        return send({ list: this.closedPnl });

      case '/v5/position/set-leverage':
        return send({});

      case '/v5/position/trading-stop':
        this.tradingStops.push(JSON.parse(body));
        return send({});

      case '/v5/order/create': {
        if (this.failNextOrderWith !== null) {
          const code = this.failNextOrderWith;
          this.failNextOrderWith = null;
          return send({}, code, 'simulated rejection');
        }
        const order = JSON.parse(body) as Record<string, string>;
        this.orders.push(order);
        this.applyOrder(order);
        return send({ orderId: `mock-${this.orders.length}`, orderLinkId: order.orderLinkId ?? '' });
      }

      case '/v5/order/cancel-all':
        return send({ list: [] });

      default:
        return send({}, 10001, `unmocked path ${path}`);
    }
  }

  /** Mirrors Bybit's behaviour: a market order immediately becomes a position. */
  private applyOrder(order: Record<string, string>): void {
    const existing = this.positions.findIndex((p) => p.symbol === order.symbol);
    if (order.reduceOnly) {
      if (existing >= 0) this.positions.splice(existing, 1);
      return;
    }
    this.positions.push({
      symbol: order.symbol!,
      side: order.side as 'Buy' | 'Sell',
      size: order.qty!,
      avgPrice: String(this.price),
      markPrice: String(this.price),
      unrealisedPnl: '0',
      leverage: '5',
      stopLoss: order.stopLoss ?? '',
      takeProfit: order.takeProfit ?? '',
      createdTime: String(Date.now()),
    });
  }
}
