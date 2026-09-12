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
