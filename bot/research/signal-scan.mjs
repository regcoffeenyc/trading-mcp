// What is the live strategy actually seeing right now, across a wide symbol set?
//
// On 12-hour bars the signal rate is low by construction. This shows, per
// symbol, how close the shipped trend rules are to firing, so the choice
// between "wait" and "widen the universe" is made on facts rather than
// impatience.
import { BybitRest } from '../dist/bybit/rest.js';
import { createStrategy } from '../dist/strategy/index.js';
import { loadEnvFile } from '../dist/env.js';
import { adx, atr, closes, ema, rsi } from '../dist/indicators.js';

loadEnvFile();

const rest = new BybitRest({ network: 'mainnet', apiKey: '', apiSecret: '', recvWindow: '5000' });
// Default to what the bot itself is trading, so the scan answers "what is my
// bot seeing" rather than whatever the last shell happened to export. An empty
// list used to print a clean report of nothing, which reads exactly like a
// genuine "no signals" result and is not one.
const INTERVAL = process.env.SCAN_INTERVAL ?? process.env.INTERVAL ?? '720';
const symbols = (process.env.SCAN_SYMBOLS ?? process.env.SYMBOLS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (symbols.length === 0) {
  console.error('No symbols to scan. Set SCAN_SYMBOLS, or run from the bot directory so .env supplies SYMBOLS.');
  process.exit(1);
}

const strategy = createStrategy('trend');
const rows = [];

for (const symbol of symbols) {
  try {
    const candles = await rest.klines(symbol, INTERVAL, 300);
    const closed = candles.filter((c) => c.closed);
    if (closed.length < strategy.warmupBars) { rows.push({ symbol, note: 'warming up' }); continue; }

    const price = closes(closed);
    const i = closed.length - 1;
    const fast = ema(price, 21)[i];
    const slow = ema(price, 55)[i];
    const trend = ema(price, 200)[i];
    const r = rsi(price, 14)[i];
    const a = atr(closed, 14)[i];
    const dx = adx(closed, 14)[i];
    const c = price[i];
    if ([fast, slow, trend, r, a, dx].some((v) => v == null)) { rows.push({ symbol, note: 'insufficient' }); continue; }

    const signal = strategy.evaluate({
      symbol, candles: closed, stopAtrMult: 1.8, takeProfitR: 2, minAtrPct: 0.15,
    });

    // How far the fast EMA is from crossing, as a share of ATR — a rough
    // measure of how near a signal is.
    const gapAtr = Math.abs(fast - slow) / a;
    rows.push({
      symbol,
      bias: c > trend ? 'up' : 'down',
      emaSide: fast > slow ? 'fast>slow' : 'fast<slow',
      gapAtr,
      adx: dx,
      rsi: r,
      atrPct: (a / c) * 100,
      firing: Boolean(signal),
      reason: signal?.reason ?? '',
    });
  } catch (err) {
    rows.push({ symbol, note: String(err).slice(0, 60) });
  }
}

const live = rows.filter((r) => !r.note);
live.sort((a, b) => a.gapAtr - b.gapAtr);

console.log('interval ' + INTERVAL + 'm, ' + live.length + ' symbols evaluated\n');
console.log('symbol        bias   ema         gap(ATR)   ADX    RSI   ATR%   status');
for (const r of live.slice(0, 30)) {
  const status = r.firing ? '*** SIGNAL ***'
    : r.adx < 20 ? 'no trend (ADX<20)'
    : r.gapAtr < 0.25 ? 'near a cross'
    : '';
  console.log(
    r.symbol.padEnd(13) + r.bias.padEnd(7) + r.emaSide.padEnd(12) +
    r.gapAtr.toFixed(2).padStart(7) + r.adx.toFixed(1).padStart(7) +
    r.rsi.toFixed(0).padStart(7) + r.atrPct.toFixed(2).padStart(7) + '   ' + status,
  );
}

const firing = live.filter((r) => r.firing);
console.log('\nfiring now: ' + firing.length);
for (const f of firing) console.log('  ' + f.symbol + '  ' + f.reason);
const near = live.filter((r) => !r.firing && r.gapAtr < 0.25 && r.adx >= 20);
console.log('within a quarter-ATR of a cross, with trend strength: ' + near.length +
  (near.length ? '  (' + near.map((n) => n.symbol).join(', ') + ')' : ''));
