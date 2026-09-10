import { RetryableError, retry, sleep } from '../util.js';
import type { Candle, Instrument, Ticker } from '../bybit/types.js';
import type { MarketData } from './types.js';

/**
 * Historical candles from OKX, used as a stand-in when Bybit's REST API is not
 * reachable (it geo-blocks some regions outright, and CI runners frequently sit
 * in one).
 *
 * OKX lists the same USDT-margined perpetual swaps and its prices track Bybit's
 * to within a few basis points on liquid pairs, so it is a sound proxy for
 * measuring whether a strategy has an edge. It is NOT a substitute for the real
 * thing when sizing or fees matter — always re-run the backtest against Bybit
 * from a machine that can reach it before trusting the numbers.
 */

const BASE = 'https://www.okx.com';
const PAGE_LIMIT = 100;
/** Maximum bars OKX returns from the non-paginated candles endpoint. */
const PAGE_MAX = 300;

/** Bybit interval codes to OKX bar codes. */
const BAR_MAP: Record<string, string> = {
  '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
  '60': '1H', '120': '2H', '240': '4H', '360': '6H', '720': '12H',
  D: '1D', W: '1W', M: '1M',
};

export function toInstId(symbol: string): string {
  const upper = symbol.toUpperCase();
  if (!upper.endsWith('USDT')) throw new Error(`Only USDT pairs are supported, got ${symbol}`);
  return `${upper.slice(0, -4)}-USDT-SWAP`;
}

export function toBar(interval: string): string {
  const bar = BAR_MAP[interval];
  if (!bar) throw new Error(`No OKX bar code for interval "${interval}"`);
  return bar;
}

interface OkxResponse { code: string; msg: string; data: string[][] }

async function fetchPage(instId: string, bar: string, after?: number): Promise<string[][]> {
  return retry(async () => {
    const params = new URLSearchParams({ instId, bar, limit: String(PAGE_LIMIT) });
    if (after !== undefined) params.set('after', String(after));
    const res = await fetch(`${BASE}/api/v5/market/history-candles?${params}`, {
      signal: AbortSignal.timeout(20_000),
    });
    // 429/503 are OKX throttling a long backfill; back off rather than abandon
    // thousands of already-fetched bars.
    if (res.status === 429 || res.status >= 500) {
      throw new RetryableError(`OKX HTTP ${res.status} for ${instId}`);
    }
    if (!res.ok) throw new Error(`OKX HTTP ${res.status} for ${instId}`);
    const json = (await res.json()) as OkxResponse;
    // 50011 is OKX's own rate-limit code.
    if (json.code === '50011') throw new RetryableError(`OKX rate limited on ${instId}`);
    if (json.code !== '0') throw new Error(`OKX error ${json.code}: ${json.msg}`);
    return json.data ?? [];
  }, { attempts: 5, baseMs: 1000 });
}

/**
 * Fetches `bars` candles, oldest first. OKX returns newest-first pages and the
 * `after` cursor walks backwards in time.
 */
export async function fetchOkxHistory(symbol: string, interval: string, bars: number): Promise<Candle[]> {
  const instId = toInstId(symbol);
  const bar = toBar(interval);
  const collected: Candle[] = [];
  let cursor: number | undefined;

  while (collected.length < bars) {
    const page = await fetchPage(instId, bar, cursor);
    if (page.length === 0) break;

    for (const row of page) {
      collected.push({
        time: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
        // Field 8 is OKX's own confirm flag: "1" once the bar has closed.
        closed: row[8] === '1',
      });
    }
    cursor = Number(page[page.length - 1]![0]);
    if (page.length < PAGE_LIMIT) break;
    // OKX allows 20 requests per 2s on this endpoint; stay well inside it.
    await sleep(250);
  }

  const seen = new Set<number>();
  const unique = collected.filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)));
  unique.sort((a, b) => a.time - b.time);
  // Drop any still-forming bar; a backtest must only see completed candles.
  const closed = unique.filter((c) => c.closed);
  return closed.slice(-bars);
}

/**
 * Bybit's linear-perp constraints, applied to OKX price data.
 *
 * Instrument filters come from Bybit rather than OKX on purpose: the point of
 * paper trading is to rehearse what would happen on Bybit, and the constraint
 * that actually binds a $50 account is Bybit's uniform $5 minimum order value.
 * Lot granularity is left fine so it never becomes a fake constraint.
 */
const BYBIT_LINEAR_FILTERS: Omit<Instrument, 'symbol'> = {
  tickSize: '0.00001',
  qtyStep: '0.000001',
  minOrderQty: '0.000001',
  maxOrderQty: '1000000',
  minNotionalValue: 5,
  maxLeverage: 25,
};

/** Market data from OKX, for paper trading where Bybit's REST API is blocked. */
export class OkxMarketData implements MarketData {
  readonly venue = 'okx' as const;

  async instrument(symbol: string): Promise<Instrument> {
    // Validates the symbol maps to a real OKX swap before returning filters.
    toInstId(symbol);
    return { symbol, ...BYBIT_LINEAR_FILTERS };
  }

  async ticker(symbol: string): Promise<Ticker> {
    const instId = toInstId(symbol);
    const raw = await retry(async () => {
      const res = await fetch(`${BASE}/api/v5/market/ticker?instId=${instId}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429 || res.status >= 500) throw new RetryableError(`OKX HTTP ${res.status}`);
      if (!res.ok) throw new Error(`OKX HTTP ${res.status} for ${instId}`);
      const json = (await res.json()) as { code: string; msg: string; data: Record<string, string>[] };
      if (json.code === '50011') throw new RetryableError('OKX rate limited');
      if (json.code !== '0') throw new Error(`OKX error ${json.code}: ${json.msg}`);
      const row = json.data?.[0];
      if (!row) throw new Error(`No OKX ticker for ${instId}`);
      return row;
    }, { attempts: 4, baseMs: 500 });

    const bid = Number(raw.bidPx);
    const ask = Number(raw.askPx);
    const mid = (bid + ask) / 2;
    return {
      symbol,
      lastPrice: Number(raw.last),
      bid,
      ask,
      spreadPct: mid > 0 ? ((ask - bid) / mid) * 100 : 0,
    };
  }

  /** Recent candles, oldest first, with the still-forming bar marked open. */
  async klines(symbol: string, interval: string, limit = 200): Promise<Candle[]> {
    // One OKX page holds at most 300 bars; a longer warmup needs the paginated
    // history endpoint, or the strategy would silently run on a short window.
    if (limit > PAGE_MAX) {
      const history = await fetchOkxHistory(symbol, interval, limit);
      const recent = await this.klines(symbol, interval, PAGE_MAX);
      const seen = new Set(history.map((c) => c.time));
      const merged = [...history, ...recent.filter((c) => !seen.has(c.time))];
      merged.sort((a, b) => a.time - b.time);
      return merged.slice(-limit);
    }
    const instId = toInstId(symbol);
    const bar = toBar(interval);
    const rows = await retry(async () => {
      const res = await fetch(
        `${BASE}/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${Math.min(limit, PAGE_MAX)}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (res.status === 429 || res.status >= 500) throw new RetryableError(`OKX HTTP ${res.status}`);
      if (!res.ok) throw new Error(`OKX HTTP ${res.status} for ${instId}`);
      const json = (await res.json()) as OkxResponse;
      if (json.code === '50011') throw new RetryableError('OKX rate limited');
      if (json.code !== '0') throw new Error(`OKX error ${json.code}: ${json.msg}`);
      return json.data ?? [];
    }, { attempts: 4, baseMs: 500 });

    return rows
      .map((r) => ({
        time: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
        closed: r[8] === '1',
      }))
      .sort((a, b) => a.time - b.time);
  }

  /** Deeper history for a warmup that needs more than one page. */
  history(symbol: string, interval: string, bars: number): Promise<Candle[]> {
    return fetchOkxHistory(symbol, interval, bars);
  }
}
