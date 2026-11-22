import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KlineStream } from './bybit/stream.js';
import type { Candle, Instrument, Ticker } from './bybit/types.js';
import type { MarketData } from './data/types.js';

const HOUR = 3_600_000;

function candle(time: number, closed: boolean): Candle {
  return { time, open: 100, high: 101, low: 99, close: 100.5, volume: 1, closed };
}

/** Serves whatever candle series the test currently wants. */
class FakeMarket implements MarketData {
  readonly venue = 'bybit' as const;
  constructor(public series: Candle[]) {}
  instrument(): Promise<Instrument> { throw new Error('not used'); }
  ticker(): Promise<Ticker> { throw new Error('not used'); }
  async klines(): Promise<Candle[]> { return this.series.map((c) => ({ ...c })); }
}

function streamOver(market: MarketData): KlineStream {
  // Poll mode with a pollMs far beyond any test's lifetime: start() seeds from
  // REST without opening a socket, and the timer never fires on its own.
  return new KlineStream({
    network: 'mainnet', symbols: ['BTCUSDT'], interval: '60', rest: market,
    mode: 'poll', pollMs: 60 * HOUR,
  });
}

test('startup history is filled without announcing every historical bar', async () => {
  const market = new FakeMarket([candle(1 * HOUR, true), candle(2 * HOUR, true), candle(3 * HOUR, false)]);
  const stream = streamOver(market);
  const bars: number[] = [];
  stream.on('bar', (_s: string, c: Candle) => bars.push(c.time));

  await stream.start();
  stream.stop();

  assert.deepEqual(bars, [], 'seeding history is not a stream of closes');
  assert.equal(stream.closedCandles('BTCUSDT').length, 2);
});

test('a bar that closed while the feed was down is announced on re-seed', async () => {
  const market = new FakeMarket([candle(1 * HOUR, true), candle(2 * HOUR, false)]);
  const stream = streamOver(market);
  await stream.start();

  const bars: Candle[] = [];
  stream.on('bar', (_s: string, c: Candle) => bars.push(c));

  // The socket drops; by the time it is back, the 2h bar has closed and a new
  // one has opened. Without this the buffer holds the close but nobody is told.
  market.series = [candle(1 * HOUR, true), candle(2 * HOUR, true), candle(3 * HOUR, false)];
  await stream.seed();
  stream.stop();

  assert.equal(bars.length, 1, 'exactly one recovered close');
  assert.equal(bars[0]?.time, 2 * HOUR);
  assert.equal(bars[0]?.closed, true);
});

test('a long outage announces only the newest close, not every bar it missed', async () => {
  const market = new FakeMarket([candle(1 * HOUR, true), candle(2 * HOUR, false)]);
  const stream = streamOver(market);
  await stream.start();

  const bars: Candle[] = [];
  stream.on('bar', (_s: string, c: Candle) => bars.push(c));

  market.series = [2, 3, 4, 5, 6].map((h) => candle(h * HOUR, true));
  await stream.seed();
  stream.stop();

  assert.equal(bars.length, 1, 'a listener re-reads the whole buffer; one nudge is enough');
  assert.equal(bars[0]?.time, 6 * HOUR, 'and it must be the newest close');
});

test('re-seeding with nothing new announces nothing', async () => {
  const market = new FakeMarket([candle(1 * HOUR, true), candle(2 * HOUR, false)]);
  const stream = streamOver(market);
  await stream.start();

  const bars: Candle[] = [];
  stream.on('bar', (_s: string, c: Candle) => bars.push(c));

  await stream.seed();
  await stream.seed();
  stream.stop();

  assert.deepEqual(bars, [], 'a reconnect that missed nothing is silent');
});

test('the same close is never delivered twice', async () => {
  const market = new FakeMarket([candle(1 * HOUR, true), candle(2 * HOUR, false)]);
  const stream = streamOver(market);
  await stream.start();

  const bars: Candle[] = [];
  stream.on('bar', (_s: string, c: Candle) => bars.push(c));

  // Re-seed announces the 2h close; a poll over the same data must not repeat it.
  market.series = [candle(1 * HOUR, true), candle(2 * HOUR, true), candle(3 * HOUR, false)];
  await stream.seed();
  await (stream as unknown as { poll(): Promise<void> }).poll();
  stream.stop();

  assert.equal(bars.length, 1, 'the 2h close is announced once');
});

/**
 * Serves candles per symbol and fails for the symbols named in `broken`.
 * Mirrors the real failure: one symbol's REST call rejects while the rest work.
 */
class PartlyBrokenMarket implements MarketData {
  readonly venue = 'bybit' as const;
  calls: string[] = [];
  constructor(public series: Candle[], public broken: Set<string>) {}
  instrument(): Promise<Instrument> { throw new Error('not used'); }
  ticker(): Promise<Ticker> { throw new Error('not used'); }
  async klines(symbol: string): Promise<Candle[]> {
    this.calls.push(symbol);
    if (this.broken.has(symbol)) throw new Error('fetch failed');
    return this.series.map((c) => ({ ...c }));
  }
}

function streamOverSymbols(market: MarketData, symbols: string[]): KlineStream {
  return new KlineStream({
    network: 'mainnet', symbols, interval: '60', rest: market,
    mode: 'poll', pollMs: 60 * HOUR,
  });
}

test('one symbol failing to seed does not abandon the others', async () => {
  const market = new PartlyBrokenMarket(
    [candle(1 * HOUR, true), candle(2 * HOUR, false)],
    new Set(['AAAUSDT']),
  );
  const stream = streamOverSymbols(market, ['AAAUSDT', 'BBBUSDT', 'CCCUSDT']);
  await stream.start();

  // Every symbol was attempted, not just the ones before the failure. The
  // broken one appears more than once because failures get retry passes.
  assert.deepEqual([...new Set(market.calls)], ['AAAUSDT', 'BBBUSDT', 'CCCUSDT']);
  assert.ok(market.calls.filter((s) => s === 'AAAUSDT').length > 1, 'the failure was retried');
  assert.equal(stream.closedCandles('BBBUSDT').length, 1, 'a healthy symbol still seeded');
  assert.equal(stream.closedCandles('CCCUSDT').length, 1, 'the symbol after the failure seeded too');
  stream.stop();
});

test('a bar missed during an outage is still announced for symbols that re-seed cleanly', async () => {
  const market = new PartlyBrokenMarket([candle(1 * HOUR, true)], new Set());
  const stream = streamOverSymbols(market, ['AAAUSDT', 'BBBUSDT']);
  await stream.start();

  // Now the first symbol breaks and a new bar closes for the others.
  market.broken = new Set(['AAAUSDT']);
  market.series = [candle(1 * HOUR, true), candle(2 * HOUR, true)];
  const bars: string[] = [];
  stream.on('bar', (s: string, c: Candle) => bars.push(`${s}@${c.time}`));
  await stream.seed();

  assert.deepEqual(bars, [`BBBUSDT@${2 * HOUR}`], 'the healthy symbol recovered its missed close');
  stream.stop();
});

test('a first seed that reaches nothing fails loudly instead of looking like no signal', async () => {
  const market = new PartlyBrokenMarket([candle(1 * HOUR, true)], new Set(['AAAUSDT', 'BBBUSDT']));
  const stream = streamOverSymbols(market, ['AAAUSDT', 'BBBUSDT']);
  await assert.rejects(() => stream.start(), /Seed failed for all 2 symbols/);
  stream.stop();
});

test('a re-seed that reaches nothing keeps the existing history and does not throw', async () => {
  const market = new PartlyBrokenMarket([candle(1 * HOUR, true)], new Set());
  const stream = streamOverSymbols(market, ['AAAUSDT']);
  await stream.start();
  assert.equal(stream.closedCandles('AAAUSDT').length, 1);

  // A total outage mid-life must not throw into the reconnect chain, and must
  // not discard the history the strategy is still entitled to act on.
  market.broken = new Set(['AAAUSDT']);
  await stream.seed();
  assert.equal(stream.closedCandles('AAAUSDT').length, 1, 'history survived the failed re-seed');
  stream.stop();
});

/** Fails a symbol the first N times it is asked for, then succeeds. */
class FlakyMarket implements MarketData {
  readonly venue = 'bybit' as const;
  attempts = new Map<string, number>();
  constructor(public series: Candle[], public failTimes: Map<string, number>) {}
  instrument(): Promise<Instrument> { throw new Error('not used'); }
  ticker(): Promise<Ticker> { throw new Error('not used'); }
  async klines(symbol: string): Promise<Candle[]> {
    const n = (this.attempts.get(symbol) ?? 0) + 1;
    this.attempts.set(symbol, n);
    if (n <= (this.failTimes.get(symbol) ?? 0)) throw new Error('This operation was aborted');
    return this.series.map((c) => ({ ...c }));
  }
}

test('a symbol that times out once is retried rather than left unscanned', async () => {
  const market = new FlakyMarket([candle(1 * HOUR, true)], new Map([['AAAUSDT', 1]]));
  const stream = streamOverSymbols(market, ['AAAUSDT', 'BBBUSDT']);
  await stream.start();

  assert.equal(market.attempts.get('AAAUSDT'), 2, 'the flaky symbol was tried again');
  assert.equal(market.attempts.get('BBBUSDT'), 1, 'a healthy symbol was not re-fetched');
  assert.equal(stream.closedCandles('AAAUSDT').length, 1, 'it ended up seeded');
  stream.stop();
});

test('a symbol failing every pass is given up on without taking the others down', async () => {
  const market = new FlakyMarket([candle(1 * HOUR, true)], new Map([['AAAUSDT', 99]]));
  const stream = streamOverSymbols(market, ['AAAUSDT', 'BBBUSDT']);
  await stream.start();

  assert.equal(market.attempts.get('AAAUSDT'), 3, 'tried for every pass, then abandoned');
  assert.equal(stream.closedCandles('BBBUSDT').length, 1, 'the healthy symbol is unaffected');
  stream.stop();
});
