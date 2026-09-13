import crypto from 'node:crypto';
import { RetryableError, retry } from '../util.js';
import { log } from '../logger.js';
import type {
  AccountInfo, ApiKeyInfo, Candle, ClosedPnl, Instrument, OrderRequest, OrderResult, Position, Ticker, WalletBalance,
} from './types.js';
import type { MarketData } from '../data/types.js';

const HOSTS = {
  mainnet: 'https://api.bybit.com',
  testnet: 'https://api-testnet.bybit.com',
  demo: 'https://api-demo.bybit.com',
} as const;

export type Network = keyof typeof HOSTS;

const TIMEOUT_MS = 15_000;

/**
 * How long a clock reading stays trustworthy.
 *
 * A host whose time service is stopped drifts steadily — five seconds an hour
 * on the machine this was found on, which is the whole recv window. Syncing
 * once at startup is therefore only correct for the first hour. Re-reading
 * server time costs one unauthenticated GET, so do it often enough that drift
 * never reaches the window rather than waiting to be rejected.
 */
const CLOCK_RESYNC_AFTER_MS = 5 * 60_000;

/** Bybit ret codes that mean "the request was fine, the state just isn't there". */
const BENIGN_CODES = new Set([
  110043, // leverage not modified
  34036,  // leverage not modified (UTA)
  110025, // position mode not modified
  10001,  // param error — surfaced to caller, never retried
]);

export interface RestOptions {
  network: Network;
  apiKey: string;
  apiSecret: string;
  recvWindow: string;
  /**
   * Overrides the host for `network`. Bybit serves several equivalent domains
   * (api.bytick.com, api.bybit.nl) and blocks some regions outright, so
   * operators behind a geo-block can point the bot at a reachable one.
   */
  host?: string;
}

export class BybitRest implements MarketData {
  readonly venue = 'bybit' as const;
  private readonly host: string;
  private readonly key: string;
  private readonly secret: string;
  private readonly recvWindow: string;
  /** Bybit rejects requests whose timestamp drifts from server time by > recvWindow. */
  private clockOffsetMs = 0;
  private clockSyncedAt = 0;
  private clockSyncInFlight: Promise<number> | null = null;

  constructor(opts: RestOptions) {
    this.host = opts.host ?? HOSTS[opts.network];
    this.key = opts.apiKey;
    this.secret = opts.apiSecret;
    this.recvWindow = opts.recvWindow;
  }

  // ---------------------------------------------------------------- transport

  private sign(payload: string, timestamp: string): string {
    return crypto
      .createHmac('sha256', this.secret)
      .update(`${timestamp}${this.key}${this.recvWindow}${payload}`)
      .digest('hex');
  }

  private query(params: Record<string, unknown>): string {
    return Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, unknown>,
    auth: boolean,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const isGet = method === 'GET';
        const payload = isGet ? this.query(params) : JSON.stringify(params);
        const url = isGet && payload ? `${this.host}${path}?${payload}` : `${this.host}${path}`;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };

        if (auth) {
          if (!this.key || !this.secret) {
            throw new Error(`${path} requires API credentials (BYBIT_API_KEY / BYBIT_API_SECRET).`);
          }
          await this.ensureClockFresh();
          const timestamp = String(Date.now() + this.clockOffsetMs);
          headers['X-BAPI-API-KEY'] = this.key;
          headers['X-BAPI-TIMESTAMP'] = timestamp;
          headers['X-BAPI-RECV-WINDOW'] = this.recvWindow;
          headers['X-BAPI-SIGN'] = this.sign(payload, timestamp);
        }

        const res = await fetch(url, {
          method,
          headers,
          body: isGet ? undefined : payload,
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new Error(`HTTP ${res.status} ${path}: ${body.slice(0, 300)}`);
          if (res.status >= 500 || res.status === 429) throw new RetryableError(err.message);
          throw err;
        }

        const json = (await res.json()) as { retCode: number; retMsg: string; result: T };
        if (json.retCode !== 0 && !BENIGN_CODES.has(json.retCode)) {
          const msg = `Bybit ${json.retCode} on ${path}: ${json.retMsg}`;
          // 10002 = request expired: our clock drifted.
          if (json.retCode === 10002) {
            // The rejection carries Bybit's own clock, so correct from that
            // first. Re-reading /v5/market/time needs the network, and the
            // outages that cause this drift are the same ones that would stop
            // the read going through — which is how an 8.5s skew survived a
            // five-minute resync policy on a flaky connection.
            if (!this.adoptOffsetFrom(json.retMsg)) {
              await this.syncClock().catch(() => undefined);
            }
            throw new RetryableError(msg);
          }
          if (json.retCode === 10006 || json.retCode === 10016) throw new RetryableError(msg);
          throw new Error(msg);
        }
        return json.result;
      } finally {
        clearTimeout(timer);
      }
    };

    return retry(run, {
      attempts: 4,
      baseMs: 400,
      onRetry: (err, attempt) => log.warn(`Retrying ${path} (attempt ${attempt})`, { error: String(err) }),
    });
  }

  /**
   * Corrects the clock from a 10002 rejection.
   *
   * Bybit states both timestamps in the message it refuses with:
   *   req_timestamp[1789252608184],server_timestamp[1789252616519]
   * The difference is the error in the offset we just signed with, so adding it
   * lands the next signature on the exchange's clock exactly, with no round
   * trip. Parsing an error string is not elegant; being correct without needing
   * the network is worth more than elegance here.
   *
   * Returns false when the message is not in the expected shape, so the caller
   * falls back to reading the time endpoint rather than trusting a bad parse.
   */
  private adoptOffsetFrom(retMsg: string): boolean {
    const req = /req_timestamp\[(\d+)\]/.exec(retMsg);
    const server = /server_timestamp\[(\d+)\]/.exec(retMsg);
    if (!req || !server) return false;
    const error = Number(server[1]) - Number(req[1]);
    if (!Number.isFinite(error) || Math.abs(error) > 3_600_000) return false;
    this.clockOffsetMs += error;
    this.clockSyncedAt = Date.now();
    log.warn('Clock corrected from a rejected request', {
      correctedByMs: error, offsetMs: this.clockOffsetMs,
    });
    return true;
  }

  /**
   * Re-reads server time if the last reading has gone stale.
   *
   * Only signed requests need this, and syncClock is unauthenticated, so there
   * is no recursion. Concurrent callers share one in-flight read, and a failed
   * read keeps the previous offset: a stale offset still beats no request.
   */
  private async ensureClockFresh(): Promise<void> {
    if (Date.now() - this.clockSyncedAt < CLOCK_RESYNC_AFTER_MS) return;
    this.clockSyncInFlight ??= this.syncClock().finally(() => { this.clockSyncInFlight = null; });
    await this.clockSyncInFlight.catch(() => undefined);
  }

  /** Aligns our clock with Bybit's so signed requests are not rejected as expired. */
  async syncClock(): Promise<number> {
    const before = Date.now();
    const res = await this.request<{ timeNano: string }>('GET', '/v5/market/time', {}, false);
    const rtt = Date.now() - before;
    const serverMs = Number(res.timeNano) / 1e6;
    this.clockOffsetMs = Math.round(serverMs + rtt / 2 - Date.now());
    this.clockSyncedAt = Date.now();
    if (Math.abs(this.clockOffsetMs) > 1000) {
      log.warn('Local clock drifts from Bybit', { offsetMs: this.clockOffsetMs });
    }
    return this.clockOffsetMs;
  }

  // ------------------------------------------------------------- market data

  async instrument(symbol: string): Promise<Instrument> {
    const res = await this.request<{ list: any[] }>(
      'GET', '/v5/market/instruments-info', { category: 'linear', symbol }, false,
    );
    const raw = res.list?.[0];
    if (!raw) throw new Error(`Unknown symbol ${symbol} on Bybit linear perpetuals.`);
    return {
      symbol: raw.symbol,
      tickSize: raw.priceFilter.tickSize,
      qtyStep: raw.lotSizeFilter.qtyStep,
      minOrderQty: raw.lotSizeFilter.minOrderQty,
      maxOrderQty: raw.lotSizeFilter.maxOrderQty,
      minNotionalValue: Number(raw.lotSizeFilter.minNotionalValue ?? 5),
      maxLeverage: Number(raw.leverageFilter.maxLeverage),
    };
  }

  /**
   * Returns candles oldest-first. Bybit returns newest-first and marks nothing as
   * closed, so we reverse and treat every bar except the most recent as final.
   */
  async klines(symbol: string, interval: string, limit = 200, endMs?: number): Promise<Candle[]> {
    const res = await this.request<{ list: string[][] }>(
      'GET', '/v5/market/kline',
      { category: 'linear', symbol, interval, limit, end: endMs },
      false,
    );
    const rows = (res.list ?? []).slice().reverse();
    return rows.map((r, i) => ({
      time: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      closed: i < rows.length - 1,
    }));
  }

  /** Walks backwards through /v5/market/kline to assemble a long backtest history. */
  async klineHistory(symbol: string, interval: string, bars: number): Promise<Candle[]> {
    const out: Candle[] = [];
    let end: number | undefined;
    while (out.length < bars) {
      const batch = await this.klines(symbol, interval, 1000, end);
      if (batch.length === 0) break;
      out.unshift(...batch);
      const first = batch[0];
      if (!first) break;
      end = first.time - 1;
      if (batch.length < 1000) break;
    }
    // Deduplicate (page boundaries can overlap) and mark all but the last as closed.
    const seen = new Set<number>();
    const unique = out.filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)));
    unique.sort((a, b) => a.time - b.time);
    return unique.slice(-bars).map((c, i, arr) => ({ ...c, closed: i < arr.length - 1 }));
  }

  async ticker(symbol: string): Promise<Ticker> {
    const res = await this.request<{ list: any[] }>(
      'GET', '/v5/market/tickers', { category: 'linear', symbol }, false,
    );
    const raw = res.list?.[0];
    if (!raw) throw new Error(`No ticker for ${symbol}`);
    const bid = Number(raw.bid1Price);
    const ask = Number(raw.ask1Price);
    const mid = (bid + ask) / 2;
    return {
      symbol: raw.symbol,
      lastPrice: Number(raw.lastPrice),
      bid,
      ask,
      spreadPct: mid > 0 ? ((ask - bid) / mid) * 100 : 0,
    };
  }

  // ----------------------------------------------------------------- account

  async walletBalance(): Promise<WalletBalance> {
    const res = await this.request<{ list: any[] }>(
      'GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }, true,
    );
    const acct = res.list?.[0];
    if (!acct) throw new Error('Bybit returned no UNIFIED wallet. Upgrade the account to Unified Trading.');
    // On UTA, totalEquity is the account-wide USD value; fall back to the USDT coin row.
    const equity = Number(acct.totalEquity ?? 0);
    const available = Number(acct.totalAvailableBalance ?? 0);
    if (equity > 0) return { equity, available };
    const usdt = (acct.coin ?? []).find((c: any) => c.coin === 'USDT');
    return {
      equity: Number(usdt?.equity ?? 0),
      available: Number(usdt?.availableToWithdraw ?? usdt?.walletBalance ?? 0),
    };
  }

  /**
   * What this API key is actually allowed to do.
   *
   * Bybit's `readOnly` flag overrides the scope list: a key can advertise
   * ContractTrade permissions and still reject every order. Checking it is the
   * difference between finding out now and finding out when the first signal
   * fires on a funded account.
   */
  async apiKeyInfo(): Promise<ApiKeyInfo> {
    const r = await this.request<any>('GET', '/v5/user/query-api', {}, true);
    const contractScopes: string[] = r.permissions?.ContractTrade ?? [];
    return {
      note: r.note ?? '',
      readOnly: r.readOnly === 1,
      unifiedAccount: r.unified === 1,
      expiresAt: r.expiredAt || null,
      ipRestriction: (r.ips ?? []).join(', ') || 'none',
      contractScopes,
      canTrade: r.readOnly !== 1 && contractScopes.length > 0,
    };
  }

  /**
   * The account's real type, from Bybit's own account endpoint.
   *
   * Needed because the API-key endpoint's `unified` flag reads 0 on a UTA 2.0
   * account, which makes a perfectly good account look unusable.
   */
  async accountInfo(): Promise<AccountInfo> {
    const r = await this.request<any>('GET', '/v5/account/info', {}, true);
    const status = Number(r.unifiedMarginStatus);
    const DESCRIPTIONS: Record<number, string> = {
      1: 'Classic account',
      3: 'Unified Trading Account 1.0',
      4: 'Unified Trading Account 1.0 (pro)',
      5: 'Unified Trading Account 2.0',
      6: 'Unified Trading Account 2.0 (pro)',
    };
    return {
      unifiedMarginStatus: status,
      isUnified: status >= 3,
      marginMode: r.marginMode ?? '',
      description: DESCRIPTIONS[status] ?? `unknown status ${status}`,
    };
  }

  async positions(): Promise<Position[]> {
    const res = await this.request<{ list: any[] }>(
      'GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT', limit: 50 }, true,
    );
    return (res.list ?? [])
      .filter((p: any) => Number(p.size) > 0)
      .map((p: any) => ({
        symbol: p.symbol,
        side: p.side as Position['side'],
        size: Number(p.size),
        entryPrice: Number(p.avgPrice),
        markPrice: Number(p.markPrice),
        unrealisedPnl: Number(p.unrealisedPnl),
        leverage: Number(p.leverage),
        stopLoss: p.stopLoss ? Number(p.stopLoss) : null,
        takeProfit: p.takeProfit ? Number(p.takeProfit) : null,
        createdTime: Number(p.createdTime),
      }));
  }

  async closedPnl(startMs: number): Promise<ClosedPnl[]> {
    const res = await this.request<{ list: any[] }>(
      'GET', '/v5/position/closed-pnl',
      { category: 'linear', startTime: startMs, endTime: Date.now(), limit: 100 },
      true,
    );
    return (res.list ?? []).map((p: any) => ({
      symbol: p.symbol,
      side: p.side,
      closedPnl: Number(p.closedPnl),
      updatedTime: Number(p.updatedTime),
      orderId: p.orderId,
    }));
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.request('POST', '/v5/position/set-leverage', {
      category: 'linear',
      symbol,
      buyLeverage: String(leverage),
      sellLeverage: String(leverage),
    }, true);
  }

  // ------------------------------------------------------------------ orders

  /**
   * Post-only limit order with server-side SL/TP attached.
   *
   * PostOnly is rejected outright rather than filled if the price would cross
   * the spread, which is what guarantees the maker fee (0.02% against 0.055%
   * taker). The cost is that it may simply not fill — an unfilled entry is a
   * missed trade, never a worse one.
   */
  async placePostOnlyLimit(req: OrderRequest & { price: string }): Promise<OrderResult> {
    const body: Record<string, unknown> = {
      category: 'linear',
      symbol: req.symbol,
      side: req.side,
      orderType: 'Limit',
      qty: req.qty,
      price: req.price,
      timeInForce: 'PostOnly',
      positionIdx: 0,
    };
    if (req.orderLinkId) body.orderLinkId = req.orderLinkId;
    if (req.stopLoss) { body.stopLoss = req.stopLoss; body.slTriggerBy = 'MarkPrice'; }
    if (req.takeProfit) { body.takeProfit = req.takeProfit; body.tpTriggerBy = 'MarkPrice'; }
    if (req.stopLoss || req.takeProfit) body.tpslMode = 'Full';
    return this.request<OrderResult>('POST', '/v5/order/create', body, true);
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    await this.request('POST', '/v5/order/cancel', { category: 'linear', symbol, orderId }, true);
  }

  /** Status of a single order: New, PartiallyFilled, Filled, Cancelled, Rejected. */
  async orderStatus(symbol: string, orderId: string): Promise<{ status: string; filledQty: number; avgPrice: number }> {
    const res = await this.request<{ list: any[] }>(
      'GET', '/v5/order/realtime', { category: 'linear', symbol, orderId }, true,
    );
    const o = res.list?.[0];
    if (!o) return { status: 'Unknown', filledQty: 0, avgPrice: 0 };
    return {
      status: o.orderStatus,
      filledQty: Number(o.cumExecQty ?? 0),
      avgPrice: Number(o.avgPrice ?? 0),
    };
  }

  /** Market order with server-side SL/TP attached at entry. */
  async placeMarketOrder(req: OrderRequest): Promise<OrderResult> {
    const body: Record<string, unknown> = {
      category: 'linear',
      symbol: req.symbol,
      side: req.side,
      orderType: 'Market',
      qty: req.qty,
      timeInForce: 'IOC',
      positionIdx: 0, // one-way mode
    };
    if (req.reduceOnly) body.reduceOnly = true;
    if (req.orderLinkId) body.orderLinkId = req.orderLinkId;
    if (req.stopLoss) {
      body.stopLoss = req.stopLoss;
      body.slTriggerBy = 'MarkPrice';
    }
    if (req.takeProfit) {
      body.takeProfit = req.takeProfit;
      body.tpTriggerBy = 'MarkPrice';
    }
    if (req.stopLoss || req.takeProfit) body.tpslMode = 'Full';

    return this.request<OrderResult>('POST', '/v5/order/create', body, true);
  }

  /** Moves the resting stop/target on an open position (breakeven, trailing). */
  async setTradingStop(
    symbol: string,
    opts: { stopLoss?: string; takeProfit?: string; trailingStop?: string },
  ): Promise<void> {
    const body: Record<string, unknown> = { category: 'linear', symbol, positionIdx: 0, tpslMode: 'Full' };
    if (opts.stopLoss) { body.stopLoss = opts.stopLoss; body.slTriggerBy = 'MarkPrice'; }
    if (opts.takeProfit) { body.takeProfit = opts.takeProfit; body.tpTriggerBy = 'MarkPrice'; }
    if (opts.trailingStop) body.trailingStop = opts.trailingStop;
    await this.request('POST', '/v5/position/trading-stop', body, true);
  }

  async closePosition(symbol: string, side: 'Buy' | 'Sell', qty: string): Promise<OrderResult> {
    return this.placeMarketOrder({
      symbol,
      side: side === 'Buy' ? 'Sell' : 'Buy',
      qty,
      reduceOnly: true,
      orderLinkId: `close-${Date.now()}`,
    });
  }

  async cancelAll(symbol: string): Promise<void> {
    await this.request('POST', '/v5/order/cancel-all', { category: 'linear', symbol }, true);
  }
}
