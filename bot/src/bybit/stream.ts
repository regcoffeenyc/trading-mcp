import { EventEmitter } from 'node:events';
import { log } from '../logger.js';
import type { Network } from './rest.js';
import type { MarketData } from '../data/types.js';
import type { Candle } from './types.js';

const WS_HOSTS: Record<Network, string> = {
  mainnet: 'wss://stream.bybit.com/v5/public/linear',
  testnet: 'wss://stream-testnet.bybit.com/v5/public/linear',
  // Demo trading has no separate public feed — market data is the mainnet feed.
  demo: 'wss://stream.bybit.com/v5/public/linear',
};

const PING_INTERVAL_MS = 20_000;
const STALE_AFTER_MS = 90_000;
const MAX_BUFFER = 1000;

export interface KlineStreamOptions {
  network: Network;
  symbols: string[];
  interval: string;
  rest: MarketData;
  /** Candles kept per symbol; must exceed the longest indicator lookback. */
  historyBars?: number;
  /**
   * 'ws' subscribes to Bybit's push feed. 'poll' re-reads candles on a timer,
   * for a provider with no socket — slower to notice a close, but a bot on 1H
   * bars does not care about a few seconds.
   */
  mode?: 'ws' | 'poll';
  pollMs?: number;
}

/**
 * Maintains a rolling candle buffer per symbol.
 *
 * Seeded from REST, kept current over the public WebSocket, and self-healing: if
 * the socket dies or goes quiet the stream reconnects with backoff and re-seeds
 * from REST, so a network outage cannot leave the strategy trading stale data.
 *
 * Emits `bar` (symbol, closedCandle) only when a candle closes.
 */
export class KlineStream extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly buffers = new Map<string, Candle[]>();
  private readonly opts: Required<KlineStreamOptions>;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private reconnectAttempts = 0;
  private stopped = false;
  /** Newest bar already handed to listeners, per symbol — emissions are idempotent. */
  private readonly lastEmitted = new Map<string, number>();
  /** The first seed fills history silently; later ones are catching up on a gap. */
  private seeded = false;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: KlineStreamOptions) {
    super();
    this.opts = { historyBars: 300, mode: 'ws', pollMs: 20_000, ...opts };
  }

  candles(symbol: string): Candle[] {
    return this.buffers.get(symbol) ?? [];
  }

  /** Latest closed candles only — what a strategy is allowed to see. */
  closedCandles(symbol: string): Candle[] {
    return this.candles(symbol).filter((c) => c.closed);
  }

  /**
   * Replaces a symbol's buffer wholesale. Used by replay tests to drive the
   * engine from a fixed candle series without a live socket.
   */
  replaceBuffer(symbol: string, candles: Candle[]): void {
    this.buffers.set(symbol, candles);
  }

  /** True once every symbol holds enough history for the strategy to act. */
  isWarm(minBars: number): boolean {
    return this.opts.symbols.every((s) => this.closedCandles(s).length >= minBars);
  }

  async start(): Promise<void> {
    await this.seed();
    if (this.opts.mode === 'poll') {
      this.pollTimer = setInterval(() => void this.poll(), this.opts.pollMs);
      log.info('Market data polling started', { symbols: this.opts.symbols.length, everyMs: this.opts.pollMs });
      return;
    }
    this.connect();
    this.watchdog = setInterval(() => this.checkStale(), 30_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.pollTimer) clearInterval(this.pollTimer);
    try { this.ws?.close(); } catch { /* already closing */ }
    this.ws = null;
  }

  /**
   * Fills each buffer from REST.
   *
   * The first call is startup history and stays silent. Every later call is a
   * re-seed after the socket dropped, and any bar that closed while it was down
   * is emitted now — otherwise the buffer would hold the bar but no listener
   * would ever be told it closed, and the signal on it would be lost in silence.
   */
  async seed(): Promise<void> {
    for (const symbol of this.opts.symbols) {
      const previousClose = this.newestClosedTime(symbol);
      const candles = await this.opts.rest.klines(symbol, this.opts.interval, this.opts.historyBars);
      this.buffers.set(symbol, candles);
      log.debug('Seeded candles', { symbol, bars: candles.length });
      if (!this.seeded) continue;
      const missed = candles.filter((c) => c.closed && c.time > previousClose);
      const newest = missed[missed.length - 1];
      if (newest) {
        // Only the newest is announced: a listener reads the whole buffer, so
        // replaying each intermediate bar would evaluate the same history over
        // and over — a week of downtime would fire hundreds of identical passes.
        log.info('Recovered bars missed while disconnected', {
          symbol,
          bars: missed.length,
          newestBar: new Date(newest.time).toISOString(),
        });
        this.emitBar(symbol, newest);
      }
    }
    this.seeded = true;
  }

  private newestClosedTime(symbol: string): number {
    const buffer = this.buffers.get(symbol);
    if (!buffer) return -Infinity;
    for (let i = buffer.length - 1; i >= 0; i -= 1) {
      if (buffer[i]!.closed) return buffer[i]!.time;
    }
    return -Infinity;
  }

  /** Single emission point, so the same bar is never delivered twice. */
  private emitBar(symbol: string, candle: Candle): void {
    const seen = this.lastEmitted.get(symbol);
    if (seen !== undefined && candle.time <= seen) return;
    this.lastEmitted.set(symbol, candle.time);
    this.emit('bar', symbol, candle);
  }

  /**
   * Poll mode: re-reads recent candles and emits any bar that has closed since
   * the last look. Idempotent — a bar is only emitted once, however often the
   * poll runs.
   */
  private async poll(): Promise<void> {
    if (this.stopped) return;
    for (const symbol of this.opts.symbols) {
      try {
        const fresh = await this.opts.rest.klines(symbol, this.opts.interval, 20);
        const buffer = this.buffers.get(symbol);
        if (!buffer) continue;
        for (const candle of fresh) {
          const existing = buffer.findIndex((c) => c.time === candle.time);
          if (existing >= 0) {
            const previouslyClosed = buffer[existing]!.closed;
            buffer[existing] = candle;
            if (candle.closed && !previouslyClosed) this.emitBar(symbol, candle);
          } else if (candle.time > (buffer[buffer.length - 1]?.time ?? 0)) {
            buffer.push(candle);
            if (buffer.length > MAX_BUFFER) buffer.shift();
            if (candle.closed) this.emitBar(symbol, candle);
          }
        }
        this.lastMessageAt = Date.now();
      } catch (err) {
        log.warn('Candle poll failed', { symbol, error: String(err) });
      }
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const url = WS_HOSTS[this.opts.network];
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      const args = this.opts.symbols.map((s) => `kline.${this.opts.interval}.${s}`);
      ws.send(JSON.stringify({ op: 'subscribe', args }));
      log.info('Market data stream connected', { symbols: this.opts.symbols.length });
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' }));
      }, PING_INTERVAL_MS);
    });

    ws.addEventListener('message', (ev) => {
      this.lastMessageAt = Date.now();
      try {
        this.handleMessage(JSON.parse(String(ev.data)));
      } catch (err) {
        log.warn('Unparseable stream message', { error: String(err) });
      }
    });

    ws.addEventListener('error', (ev) => {
      const detail = (ev as unknown as { message?: string }).message;
      log.warn('Market data stream error', { error: detail ?? 'websocket error' });
    });

    ws.addEventListener('close', () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.stopped) return;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
    log.warn('Market data stream closed, reconnecting', { attempt: this.reconnectAttempts, delayMs: delay });
    setTimeout(async () => {
      if (this.stopped) return;
      // Re-seed so any bars missed while disconnected are filled from REST.
      await this.seed().catch((err) => log.error('Re-seed failed', { error: String(err) }));
      this.connect();
    }, delay);
  }

  private checkStale(): void {
    if (this.stopped || this.lastMessageAt === 0) return;
    if (Date.now() - this.lastMessageAt > STALE_AFTER_MS) {
      log.warn('No stream data received, forcing reconnect', { silentMs: Date.now() - this.lastMessageAt });
      this.lastMessageAt = Date.now();
      try { this.ws?.close(); } catch { /* triggers close handler */ }
    }
  }

  private handleMessage(msg: any): void {
    if (msg.op === 'pong' || msg.ret_msg === 'pong') return;
    if (msg.success === false) {
      log.warn('Stream rejected a request', { msg: msg.ret_msg });
      return;
    }
    if (typeof msg.topic !== 'string' || !msg.topic.startsWith('kline.')) return;

    const symbol = msg.topic.split('.')[2] as string | undefined;
    if (!symbol) return;
    const buffer = this.buffers.get(symbol);
    if (!buffer) return;

    for (const row of msg.data ?? []) {
      const candle: Candle = {
        time: Number(row.start),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
        closed: Boolean(row.confirm),
      };
      const last = buffer[buffer.length - 1];
      if (last && last.time === candle.time) {
        buffer[buffer.length - 1] = candle;
      } else if (!last || candle.time > last.time) {
        // A new bar started, so the previous one is final.
        if (last) last.closed = true;
        buffer.push(candle);
        if (buffer.length > MAX_BUFFER) buffer.shift();
      }
      if (candle.closed) this.emitBar(symbol, candle);
    }
  }
}
