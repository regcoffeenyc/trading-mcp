import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atr, bollinger, ema, rsi, sma } from './indicators.js';
import { floorToStep, roundToStep, tradingDayKey } from './util.js';
import { RiskManager } from './risk.js';
import { emptyState } from './state.js';
import { validate, type Config } from './config.js';
import { simulate } from './backtest.js';
import { createStrategy } from './strategy/index.js';
import type { Candle, Instrument } from './bybit/types.js';

const INSTRUMENT: Instrument = {
  symbol: 'TESTUSDT',
  tickSize: '0.01',
  qtyStep: '0.001',
  minOrderQty: '0.001',
  maxOrderQty: '100',
  minNotionalValue: 5,
  maxLeverage: 25,
};

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    mode: 'paper', network: 'mainnet', apiKey: '', apiSecret: '', recvWindow: '5000',
    symbols: ['TESTUSDT'], interval: '15', strategy: 'trend', leverage: 5, dataSource: 'bybit',
    startingEquity: 50, riskPerTradePct: 3, maxDailyLossUsd: 15, maxDailyProfitUsd: 0,
    equityFloorUsd: 20, maxConcurrentPositions: 1, maxTradesPerDay: 8,
    maxConsecutiveLosses: 3, cooldownMinutes: 60, dayResetHourUtc: 0, flattenOnDailyStop: true,
    stopAtrMult: 1.8, takeProfitR: 2, breakevenAtR: 1, trailAtrMult: 0,
    maxSpreadPct: 0.06, minAtrPct: 0.15, maxHoldMinutes: 720,
    takerFeeRate: 0.00055,
    entryStyle: 'limit', entryTimeoutSeconds: 120, entryOffsetTicks: 1, maxBarAgeIntervals: 3, slippagePct: 0.02,
    tickMs: 15_000, stateFile: './data/test.json', logLevel: 'error', healthPort: 0,
    ...overrides,
  };
}

// ------------------------------------------------------------------ rounding

test('floorToStep never rounds size up past the exchange step', () => {
  assert.equal(floorToStep(0.0019, '0.001'), '0.001');
  assert.equal(floorToStep(1.9999, '0.001'), '1.999');
  assert.equal(floorToStep(0.0009, '0.001'), '0.000');
  assert.equal(floorToStep(3, '1'), '3');
});

test('floorToStep avoids binary floating point artefacts', () => {
  assert.equal(floorToStep(0.3, '0.1'), '0.3');
  assert.equal(floorToStep(0.07, '0.01'), '0.07');
});

test('roundToStep snaps prices to the tick grid', () => {
  assert.equal(roundToStep(103.456, '0.01'), '103.46');
  assert.equal(roundToStep(103.454, '0.01'), '103.45');
  assert.equal(roundToStep(2.5, '0.5'), '2.5');
});

test('tradingDayKey honours the configured reset hour', () => {
  const t = Date.parse('2026-03-05T02:00:00Z');
  assert.equal(tradingDayKey(t, 0), '2026-03-05');
  // With a 08:00 reset, 02:00 UTC still belongs to the previous trading day.
  assert.equal(tradingDayKey(t, 8), '2026-03-04');
});

// ---------------------------------------------------------------- indicators

test('sma and ema produce known values', () => {
  const values = [1, 2, 3, 4, 5];
  assert.deepEqual(sma(values, 5)[4], 3);
  // EMA seeds on the SMA, so the first defined point equals it.
  assert.equal(ema(values, 5)[4], 3);
  assert.equal(ema(values, 5)[3], null);
});

test('rsi is 100 for an unbroken uptrend and bounded in [0,100]', () => {
  const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
  const out = rsi(rising, 14);
  assert.equal(out[39], 100);
  const noisy = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 5);
  for (const v of rsi(noisy, 14)) {
    if (v !== null) assert.ok(v >= 0 && v <= 100, `RSI out of range: ${v}`);
  }
});

test('atr equals the constant range of a constant-range series', () => {
  const candles: Candle[] = Array.from({ length: 30 }, (_, i) => ({
    time: i * 60000, open: 100, high: 102, low: 98, close: 100, volume: 1, closed: true,
  }));
  const out = atr(candles, 14);
  assert.ok(Math.abs(out[29]! - 4) < 1e-9);
});

test('bollinger bands collapse onto the mean with zero variance', () => {
  const flat = new Array(30).fill(50);
  const b = bollinger(flat, 20, 2);
  assert.equal(b.upper[29], 50);
  assert.equal(b.lower[29], 50);
});

// ---------------------------------------------------------------------- risk

test('position size makes the stop distance cost exactly the risk budget', () => {
  const risk = new RiskManager(baseConfig());
  const result = risk.sizePosition({
    equity: 50, available: 50, entryPrice: 100, stopPrice: 98, instrument: INSTRUMENT,
  });
  assert.ok(result.ok);
  // 3% of $50 = $1.50 budget, $2 stop distance -> 0.75 units.
  assert.ok(Math.abs(result.qty - 0.75) < 1e-9);
  assert.ok(Math.abs(result.riskUsd - 1.5) < 1e-9);
});

test('sizing refuses when the exchange minimum would blow the risk budget', () => {
  const risk = new RiskManager(baseConfig());
  // A $100k instrument: the 0.001 minimum is $100 notional, and a 2% stop on it
  // risks far more than the $1.50 budget.
  const result = risk.sizePosition({
    equity: 50, available: 50, entryPrice: 100_000, stopPrice: 98_000, instrument: INSTRUMENT,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /Exchange minimum/);
});

test('sizing is capped by available margin at the configured leverage', () => {
  const risk = new RiskManager(baseConfig({ leverage: 2 }));
  const result = risk.sizePosition({
    equity: 50, available: 50, entryPrice: 100, stopPrice: 99.9, instrument: INSTRUMENT,
  });
  assert.ok(result.ok);
  assert.ok(result.notional <= 50 * 2 + 1e-9, `notional ${result.notional} exceeded 2x margin`);
});

test('daily loss limit blocks new entries and demands a flatten', () => {
  const cfg = baseConfig();
  const risk = new RiskManager(cfg);
  const state = emptyState('2026-01-01', 50);
  const verdict = risk.checkGuards(state, 35); // down $15 on the day
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.flatten, true);
  assert.match(verdict.reason, /Daily loss/);
});

test('equity floor trips before the daily limit when it is closer', () => {
  const risk = new RiskManager(baseConfig({ equityFloorUsd: 40 }));
  const state = emptyState('2026-01-01', 50);
  const verdict = risk.checkGuards(state, 39);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /floor/);
});

test('a trade is refused when it could overshoot the remaining daily budget', () => {
  const cfg = baseConfig({ riskPerTradePct: 10, maxDailyLossUsd: 15 });
  const risk = new RiskManager(cfg);
  const state = emptyState('2026-01-01', 50);
  // Already down $12; a 10% trade risks $3.80 of the $3 left.
  const verdict = risk.canOpen(state, { equity: 38, available: 38, openPositions: 0 }, 'TESTUSDT');
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /daily loss budget/);
});

test('consecutive losses trigger a cooldown, a win clears the streak', () => {
  const cfg = baseConfig({ maxConsecutiveLosses: 3, cooldownMinutes: 60 });
  const risk = new RiskManager(cfg);
  const state = emptyState('2026-01-01', 50);
  const now = Date.now();
  risk.recordOutcome(state, -1, now);
  risk.recordOutcome(state, -1, now);
  assert.equal(state.cooldownUntil, 0);
  risk.recordOutcome(state, -1, now);
  assert.ok(state.cooldownUntil > now, 'cooldown should be armed after 3 losses');

  const fresh = emptyState('2026-01-01', 50);
  risk.recordOutcome(fresh, -1, now);
  risk.recordOutcome(fresh, +2, now);
  assert.equal(fresh.consecutiveLosses, 0);
});

test('concurrent position and daily trade caps are enforced', () => {
  const risk = new RiskManager(baseConfig({ maxConcurrentPositions: 1, maxTradesPerDay: 2 }));
  const state = emptyState('2026-01-01', 50);
  assert.equal(risk.canOpen(state, { equity: 50, available: 50, openPositions: 1 }, 'X').allowed, false);
  state.tradesToday = 2;
  assert.equal(risk.canOpen(state, { equity: 50, available: 50, openPositions: 0 }, 'X').allowed, false);
});

// -------------------------------------------------------------------- config

test('config rejects a per-trade risk larger than the daily loss limit', () => {
  assert.throws(
    () => validate(baseConfig({ riskPerTradePct: 9, maxDailyLossUsd: 2, startingEquity: 50 })),
    /daily limit|MAX_DAILY_LOSS_USD/i,
  );
});

test('config rejects an equity floor at or above starting equity', () => {
  assert.throws(() => validate(baseConfig({ equityFloorUsd: 50 })), /EQUITY_FLOOR_USD/);
});

test('OKX market data is refused for live trading', () => {
  assert.throws(
    () => validate(baseConfig({ dataSource: 'okx', mode: 'live' })),
    /cannot be used with MODE=live/,
  );
});

test('OKX market data is allowed for paper trading', () => {
  assert.doesNotThrow(() => validate(baseConfig({ dataSource: 'okx', mode: 'paper' })));
});

test('config accepts the shipped defaults', () => {
  assert.doesNotThrow(() => validate(baseConfig()));
});

// ------------------------------------------------------------------ backtest

/** Deterministic PRNG so the synthetic market is identical on every run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Alternating up/down drift regimes with noise on top. A perfectly smooth ramp
 * would pin RSI at 0/100 and every strategy would correctly refuse to trade it,
 * so the noise is what makes this a meaningful fixture.
 */
function syntheticCandles(count: number, legLength = 200, noise = 1): Candle[] {
  const rnd = mulberry32(42);
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const drift = Math.floor(i / legLength) % 2 === 0 ? 0.08 : -0.08;
    price = Math.max(1, price + drift + (rnd() - 0.5) * noise);
    const wick = noise * 0.4;
    out.push({
      time: i * 900_000,
      open: price,
      high: price + rnd() * wick,
      low: price - rnd() * wick,
      close: price,
      volume: 100,
      closed: true,
    });
  }
  return out;
}

test('backtest runs end to end and produces trades', () => {
  const cfg = baseConfig({ strategy: 'meanrev' });
  const result = simulate(cfg, 'TESTUSDT', syntheticCandles(3000), { ...INSTRUMENT, minNotionalValue: 1 });
  assert.equal(result.bars, 3000);
  assert.ok(result.trades.length > 0, 'noisy synthetic data should produce trades');
  assert.ok(result.endEquity > 0);
  assert.ok(Number.isFinite(result.winRate) && result.winRate >= 0 && result.winRate <= 100);
  assert.equal(result.wins + result.losses, result.trades.length);
});

test('the daily loss stop caps any single day in simulation', () => {
  const cfg = baseConfig({ strategy: 'meanrev', maxDailyLossUsd: 5, riskPerTradePct: 3 });
  const result = simulate(cfg, 'TESTUSDT', syntheticCandles(4000), { ...INSTRUMENT, minNotionalValue: 1 });

  const byDay = new Map<string, number>();
  for (const t of result.trades) {
    const day = tradingDayKey(t.closedAt, 0);
    byDay.set(day, (byDay.get(day) ?? 0) + t.pnl);
  }
  for (const [day, pnl] of byDay) {
    // A trade already in flight can carry the day past the line before the
    // flatten fires, so allow one extra trade's worth — never a runaway day.
    const worstAllowed = -(cfg.maxDailyLossUsd + (cfg.startingEquity * cfg.riskPerTradePct) / 100);
    assert.ok(pnl >= worstAllowed, `day ${day} lost ${pnl.toFixed(2)}, past the ${worstAllowed.toFixed(2)} bound`);
  }
});

test('backtest takes no trade when the risk budget cannot meet the minimum size', () => {
  const cfg = baseConfig({ startingEquity: 50, riskPerTradePct: 0.5, strategy: 'meanrev' });
  const expensive: Instrument = { ...INSTRUMENT, minOrderQty: '1', minNotionalValue: 500 };
  const result = simulate(cfg, 'TESTUSDT', syntheticCandles(2000), expensive);
  assert.equal(result.trades.length, 0);
  assert.equal(result.endEquity, 50);
});

test('both strategies stay silent until warmed up', () => {
  for (const name of ['trend', 'meanrev'] as const) {
    const strategy = createStrategy(name);
    const short = syntheticCandles(strategy.warmupBars - 1);
    const signal = strategy.evaluate({
      symbol: 'TESTUSDT', candles: short, stopAtrMult: 1.8, takeProfitR: 2, minAtrPct: 0.15,
    });
    assert.equal(signal, null, `${name} emitted a signal before warmup`);
  }
});

test('a signal always carries a stop on the losing side of entry', () => {
  const strategy = createStrategy('meanrev');
  const candles = syntheticCandles(3000);
  let checked = 0;
  for (let i = strategy.warmupBars; i < candles.length; i++) {
    const signal = strategy.evaluate({
      symbol: 'TESTUSDT', candles: candles.slice(0, i + 1), stopAtrMult: 1.8, takeProfitR: 2, minAtrPct: 0.15,
    });
    if (!signal) continue;
    checked++;
    if (signal.side === 'Buy') {
      assert.ok(signal.stopLoss < signal.price, 'long stop must sit below entry');
      assert.ok(signal.takeProfit > signal.price, 'long target must sit above entry');
    } else {
      assert.ok(signal.stopLoss > signal.price, 'short stop must sit above entry');
      assert.ok(signal.takeProfit < signal.price, 'short target must sit below entry');
    }
  }
  assert.ok(checked > 0, 'expected at least one signal to validate');
});

// ------------------------------------------------- funding vs. drawdown floor

test('an unfunded account waits rather than latching the kill switch', () => {
  const risk = new RiskManager(baseConfig({ equityFloorUsd: 20 }));
  const state = emptyState('2026-01-01', 0);
  assert.equal(state.everFunded, false);

  const verdict = risk.checkGuards(state, 0);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.waitingForFunding, true, 'an empty account is not in drawdown');
  assert.equal(verdict.flatten, false, 'nothing to flatten on an empty account');
  assert.match(verdict.reason, /Waiting for funding/);
});

test('the floor halts permanently once the account has held capital', () => {
  const risk = new RiskManager(baseConfig({ equityFloorUsd: 20 }));
  const state = emptyState('2026-01-01', 50);
  assert.equal(state.everFunded, true, 'starting with equity counts as funded');

  const verdict = risk.checkGuards(state, 18);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.waitingForFunding, undefined, 'this is a real drawdown, not a funding wait');
  assert.equal(verdict.flatten, true);
  assert.match(verdict.reason, /Halting permanently/);
});

test('a funded account that drains to zero still halts permanently', () => {
  const risk = new RiskManager(baseConfig({ equityFloorUsd: 20 }));
  const state = emptyState('2026-01-01', 50);
  state.everFunded = true;
  const verdict = risk.checkGuards(state, 0);
  assert.equal(verdict.waitingForFunding, undefined);
  assert.equal(verdict.flatten, true);
});

test('the daily baseline is rebased when an empty account is funded', () => {
  // Regression: the baseline is recorded at startup. If that happened while the
  // account held nothing, a zero baseline makes the daily loss stop unreachable
  // — the loss would have to exceed the deposit plus the limit to trigger.
  const cfg = baseConfig({ maxDailyLossUsd: 15, equityFloorUsd: 20 });
  const risk = new RiskManager(cfg);
  const state = emptyState('2026-01-01', 0);

  assert.equal(state.dayStartEquity, 0);
  assert.equal(risk.dailyLoss(state, 70), -70, 'a zero baseline reads a deposit as profit');
  assert.equal(
    risk.checkGuards(state, 55).allowed, true,
    'with a stale baseline, a $15 loss from $70 would not stop trading',
  );

  // What the engine does on the unfunded -> funded transition.
  state.everFunded = true;
  state.dayStartEquity = 70;

  assert.equal(risk.dailyLoss(state, 55), 15);
  const verdict = risk.checkGuards(state, 55);
  assert.equal(verdict.allowed, false, 'after rebasing, the stop fires at the limit');
  assert.match(verdict.reason, /Daily loss/);
});

// ------------------------------------------------ liquidation vs stop distance

test('a stop comfortably inside liquidation is accepted', () => {
  const risk = new RiskManager(baseConfig());
  // 5x leverage: liquidation about 19.5% away. A 3% stop is well clear.
  const check = risk.stopIsInsideLiquidation({ entryPrice: 100, stopPrice: 97, leverage: 5 });
  assert.equal(check.safe, true);
  assert.ok(Math.abs(check.stopDistancePct - 3) < 1e-9);
  assert.ok(check.liquidationDistancePct > 19 && check.liquidationDistancePct < 20);
});

test('a stop beyond liquidation is refused', () => {
  const risk = new RiskManager(baseConfig());
  // 20x leverage: liquidation about 4.5% away. A 6% stop would never be reached
  // — the exchange closes the position first and takes the whole margin.
  const check = risk.stopIsInsideLiquidation({ entryPrice: 100, stopPrice: 94, leverage: 20 });
  assert.equal(check.safe, false, 'a stop the exchange would pre-empt is not protection');
});

test('a stop just under liquidation is still refused, for the buffer', () => {
  const risk = new RiskManager(baseConfig());
  // 10x: liquidation about 9.5%. A 9% stop is nominally inside but has no margin
  // for a maintenance-rate step or a gap in the mark price.
  const check = risk.stopIsInsideLiquidation({ entryPrice: 100, stopPrice: 91, leverage: 10 });
  assert.equal(check.safe, false);
});

test('higher leverage shrinks the usable stop distance', () => {
  const risk = new RiskManager(baseConfig());
  const at3 = risk.stopIsInsideLiquidation({ entryPrice: 100, stopPrice: 95, leverage: 3 });
  const at25 = risk.stopIsInsideLiquidation({ entryPrice: 100, stopPrice: 95, leverage: 25 });
  assert.equal(at3.safe, true, 'the same stop is fine at low leverage');
  assert.equal(at25.safe, false, 'and unusable at high leverage');
  assert.ok(at3.liquidationDistancePct > at25.liquidationDistancePct);
});
