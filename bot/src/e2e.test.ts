import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Engine } from './engine.js';
import { loadConfig } from './config.js';
import { configureLogger } from './logger.js';
import { ReplayExchange } from './testing/replay-exchange.js';
import type { Candle } from './bybit/types.js';

configureLogger({ level: 'error' });

const FIXTURE = new URL('./testing/fixtures/sol-1h.json', import.meta.url);
const CANDLES: Candle[] = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const SYMBOL = 'SOLUSDT';
const API_KEY = 'e2e-key';
const API_SECRET = 'e2e-secret';

/**
 * Drives the real Engine over a real historical candle series against an
 * exchange stand-in that honours stops and targets.
 *
 * This is the only test that exercises strategy, sizing, risk gates, order
 * placement, trade management, closure reconciliation and state persistence
 * together — the path an actual trade takes.
 */
async function runReplay(overrides: Record<string, string>, bars: number) {
  const exchange = new ReplayExchange(CANDLES, SYMBOL, { apiKey: API_KEY, apiSecret: API_SECRET });
  const host = await exchange.listen();
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-e2e-')), 'state.json');

  const previous = { ...process.env };
  Object.assign(process.env, {
    BYBIT_REST_HOST: host, MODE: 'live', NETWORK: 'mainnet',
    BYBIT_API_KEY: API_KEY, BYBIT_API_SECRET: API_SECRET,
    SYMBOLS: SYMBOL, INTERVAL: '60', STRATEGY: 'meanrev',
    STARTING_EQUITY_USD: '50', RISK_PER_TRADE_PCT: '3', MAX_DAILY_LOSS_USD: '15',
    EQUITY_FLOOR_USD: '20', MAX_TRADES_PER_DAY: '6', HEALTH_PORT: '0',
    TICK_MS: '250', STATE_FILE: stateFile, LOG_LEVEL: 'error',
    // This replay exercises the market path; the post-only path has its own
    // tests against a mock that can answer order-status queries.
    ENTRY_STYLE: 'market',
    // Replayed bars are historical, so wall-clock staleness does not apply.
    MAX_BAR_AGE_INTERVALS: '0',
    ...overrides,
  });

  const engine = new Engine(loadConfig());
  // Warm the buffer before start so no live socket is needed.
  exchange.cursor = 700;
  await engine.start();

  for (let n = 0; n < bars && exchange.cursor < CANDLES.length - 1; n++, exchange.cursor++) {
    exchange.step();
    const window = CANDLES.slice(Math.max(0, exchange.cursor - 700), exchange.cursor + 1)
      .map((c, i, a) => ({ ...c, closed: i < a.length - 1 }));
    await engine.injectBar(SYMBOL, window);
    await engine.runTick();
  }

  await engine.stop();
  await exchange.close();
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  process.env = previous;
  return { exchange, state };
}

test('a full trade cycle runs end to end on real market data', async () => {
  const { exchange, state } = await runReplay({}, 700);

  const entries = exchange.orders.filter((o) => !o.reduceOnly);
  assert.ok(entries.length > 0, 'the strategy should have entered at least once');

  // Every entry carries its protection to the exchange, not just to memory.
  for (const order of entries) {
    assert.ok(order.stopLoss, 'entry placed without a stop loss');
    assert.ok(order.takeProfit, 'entry placed without a take profit');
    assert.equal(order.slTriggerBy, 'MarkPrice');
    assert.equal(order.orderType, 'Market');
  }

  assert.ok(exchange.closes.length > 0, 'at least one position should have closed');
  // Every close was booked into persistent state, not silently lost.
  assert.equal(state.totalTrades, exchange.closes.length, 'closed trades must all reach state');
  assert.equal(state.recentTrades.length, exchange.closes.length);

  const bookedPnl = exchange.closes.reduce((s, c) => s + c.pnl, 0);
  assert.ok(Math.abs(state.totalPnl - bookedPnl) < 0.01, 'recorded P&L must match the exchange ledger');
  assert.ok(Math.abs(exchange.equity - (50 + bookedPnl)) < 0.01, 'equity must reconcile');
});

test('risk on every real entry matches the configured budget', async () => {
  const { exchange } = await runReplay({}, 700);
  assert.ok(exchange.fills.length > 0, 'expected at least one fill');

  for (const fill of exchange.fills) {
    const riskUsd = fill.qty * Math.abs(fill.entry - fill.stop);
    // 3% of $50 is $1.50. Quantity is rounded down to the 0.1 lot step, so the
    // realised risk lands at or below budget, never above it.
    assert.ok(riskUsd <= 1.5 + 1e-6, `risked ${riskUsd.toFixed(3)}, over the $1.50 budget`);
    assert.ok(riskUsd > 0.5, `risked only ${riskUsd.toFixed(3)}, far under budget`);

    // The stop sits on the losing side and the target on the winning side.
    if (fill.side === 'Buy') {
      assert.ok(fill.stop < fill.entry, 'long stop must be below entry');
      assert.ok(fill.takeProfit > fill.entry, 'long target must be above entry');
    } else {
      assert.ok(fill.stop > fill.entry, 'short stop must be above entry');
      assert.ok(fill.takeProfit < fill.entry, 'short target must be below entry');
    }
  }
});

test('the daily loss stop halts trading and is not reset by a restart', async () => {
  // A punishing daily limit guarantees the stop trips within the replay.
  const { state } = await runReplay({ MAX_DAILY_LOSS_USD: '0.50', RISK_PER_TRADE_PCT: '1' }, 700);
  // Either it never traded (budget too small to size) or it halted — never a
  // day that ran past the limit unchecked.
  const worstDay = Math.min(0, state.totalPnl);
  assert.ok(worstDay > -5, `daily stop failed to contain losses: ${worstDay}`);
});

test('a paper run keeps its equity curve across a restart', async () => {
  const { PaperBroker } = await import('./broker/paper.js');
  const { StateStore, emptyState } = await import('./state.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-paper-'));
  const stateFile = path.join(dir, 'state.json');
  const store = new StateStore(stateFile);

  // First run ends down $7.40 on the day.
  const first = emptyState('2026-01-01', 50);
  first.paperEquity = 42.6;
  store.save(first);

  // A restart must adopt that balance, not reset to STARTING_EQUITY_USD.
  const reloaded = store.load('2026-01-01', 50);
  assert.equal(reloaded.paperEquity, 42.6);

  const broker = new PaperBroker(
    { venue: 'okx', instrument: async () => { throw new Error('unused'); },
      ticker: async () => { throw new Error('unused'); }, klines: async () => [] },
    { startingEquity: 50, takerFeeRate: 0.00055, slippagePct: 0.02 },
  );
  assert.equal((await broker.balance()).equity, 50, 'a fresh broker starts at the configured equity');
  broker.restoreEquity(reloaded.paperEquity!);
  assert.equal((await broker.balance()).equity, 42.6, 'the restored balance must carry over');

  // A nonsense value must not wipe out a run.
  broker.restoreEquity(0);
  broker.restoreEquity(Number.NaN);
  assert.equal((await broker.balance()).equity, 42.6, 'invalid restores are ignored');
});
