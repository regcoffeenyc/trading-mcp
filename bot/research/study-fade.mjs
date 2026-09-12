// Study: fade the breakout — does this market pay for selling new highs?
//
// The breakout study did not merely fail to find an edge. It found significance
// in the losing direction: Donchian 40 on 6h bars at clustered t -4.22, the
// squeeze variant at mean R -0.198. A rule that loses reliably is a statement
// about the market, and the statement here is that new extremes revert - highs
// get sold, lows get bought, and anything chasing them is fed.
//
// So this runs the same entries in the opposite direction. It is deliberately
// NOT a sign flip of the previous results: with a 1.8 ATR stop and a 2R target,
// a trade that lost 1R long does not mechanically win 2R short, because the
// stop and the target sit in different places relative to a new entry. The only
// way to know what fading pays is to trade it.
//
// Two honest warnings on reading the output. Costs are symmetric, so fading
// does not recover the fees the following side paid - it pays them again. And
// this is the fourth signal family examined in this project; the multiple-
// testing threshold is now well past |t| > 3.2, so a marginal winner here is
// more likely to be the twentieth coin landing heads than a discovery. The bar
// for acting is a clustered t that clears the threshold with both halves
// positive, and then a walk-forward before a single dollar moves.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('data/research');
const INTERVALS = (process.env.INTERVALS ?? '360,720').split(',').map((s) => s.trim());
const MAKER = 0.0002;
const SQUEEZE_LOOKBACK = 100;
const SQUEEZE_PCT = 0.33;

function ema(v, period) {
  const out = new Array(v.length).fill(null);
  if (v.length < period) return out;
  const k = 2 / (period + 1);
  let prev = v.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < v.length; i++) { prev = v[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

function atr(c, period) {
  const tr = c.map((x, i) => i === 0 ? x.h - x.l
    : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c)));
  const out = new Array(c.length).fill(null);
  if (c.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < c.length; i++) { prev = (prev * (period - 1) + tr[i]) / period; out[i] = prev; }
  return out;
}

/**
 * True when this bar's ATR is in the quietest SQUEEZE_PCT of its own recent
 * history. Measured against the symbol's own past, so a structurally volatile
 * coin is not permanently excluded and a calm one permanently admitted.
 */
function isSqueezed(a, i) {
  if (i < SQUEEZE_LOOKBACK) return false;
  const window = a.slice(i - SQUEEZE_LOOKBACK, i).filter((x) => x != null);
  if (window.length < SQUEEZE_LOOKBACK * 0.8) return false;
  const rank = window.filter((x) => x < a[i]).length / window.length;
  return rank <= SQUEEZE_PCT;
}

/**
 * One symbol's trades. `entryLook` is the Donchian window; `exit` is 'target'
 * (the live 1.8 ATR stop and 2R target) or 'trail' (leave on the opposite
 * Donchian extreme, which is how turtle-style systems actually exit).
 */
function tradeSymbol(candles, { entryLook, exitLook, stopAtr, tpR, exit, trendFilter, squeeze }) {
  const closes = candles.map((c) => c.c);
  const trend = ema(closes, 200);
  const a = atr(candles, 14);
  const out = [];
  let pos = null;

  for (let i = Math.max(entryLook, 200) + 1; i < candles.length - 1; i++) {
    const bar = candles[i], next = candles[i + 1];

    if (pos) {
      const dir = pos.side === 'long' ? 1 : -1;
      let exitPrice = null;
      const hitStop = pos.side === 'long' ? bar.l <= pos.stop : bar.h >= pos.stop;
      // Stop first when one bar spans both outcomes — the pessimistic reading.
      if (hitStop) exitPrice = pos.stop;
      else if (exit === 'target') {
        const hitTp = pos.side === 'long' ? bar.h >= pos.tp : bar.l <= pos.tp;
        if (hitTp) exitPrice = pos.tp;
      } else {
        const lows = candles.slice(i - exitLook, i).map((c) => c.l);
        const highs = candles.slice(i - exitLook, i).map((c) => c.h);
        const out_ = pos.side === 'long' ? bar.c < Math.min(...lows) : bar.c > Math.max(...highs);
        if (out_) exitPrice = next.o;
      }
      if (exitPrice != null) {
        const gross = (exitPrice - pos.entry) * dir;
        const costs = (pos.entry + exitPrice) * MAKER;
        out.push({ r: (gross - costs) / pos.risk, day: pos.day, t: pos.at });
        pos = null;
      }
    }
    if (pos) continue;
    if (a[i] == null || trend[i] == null) continue;
    if (squeeze && !isSqueezed(a, i)) continue;

    const prior = candles.slice(i - entryLook, i);
    const hi = Math.max(...prior.map((c) => c.h));
    const lo = Math.min(...prior.map((c) => c.l));
    const up = bar.c > hi;
    const dn = bar.c < lo;
    // Fading with the larger trend rather than against it: sell a new high
    // only while price is below its 200 EMA, and buy a new low only above.
    if (trendFilter && up && bar.c > trend[i]) continue;
    if (trendFilter && dn && bar.c < trend[i]) continue;

    const risk = a[i] * stopAtr;
    const day = new Date(next.t).toISOString().slice(0, 10);
    // Inverted: a new high is sold, a new low is bought.
    if (up) pos = { side: 'short', entry: next.o, stop: next.o + risk, tp: next.o - risk * tpR, risk, day, at: next.t };
    else if (dn) pos = { side: 'long', entry: next.o, stop: next.o - risk, tp: next.o + risk * tpR, risk, day, at: next.t };
  }
  return out;
}

function tStat(values) {
  const n = values.length;
  if (n < 10) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { n, mean, sd, t: sd === 0 ? 0 : mean / (sd / Math.sqrt(n)) };
}

function clustered(trades) {
  const byDay = new Map();
  for (const tr of trades) {
    if (!byDay.has(tr.day)) byDay.set(tr.day, []);
    byDay.get(tr.day).push(tr.r);
  }
  return tStat([...byDay.values()].map((rs) => rs.reduce((a, b) => a + b, 0) / rs.length));
}

const CONFIGS = [
  { label: 'Fade 20, 2R target',        entryLook: 20, stopAtr: 1.8, tpR: 2, exit: 'target' },
  { label: 'Fade 20, 3R target',        entryLook: 20, stopAtr: 1.8, tpR: 3, exit: 'target' },
  { label: 'Fade 20, trail 10',         entryLook: 20, exitLook: 10, stopAtr: 1.8, exit: 'trail' },
  { label: 'Fade 40, 2R target',        entryLook: 40, stopAtr: 1.8, tpR: 2, exit: 'target' },
  { label: 'Fade 40, trail 20',         entryLook: 40, exitLook: 20, stopAtr: 1.8, exit: 'trail' },
  { label: 'Fade 55, trail 20',         entryLook: 55, exitLook: 20, stopAtr: 2.5, exit: 'trail' },
  { label: 'Fade 20 + trend, 2R',       entryLook: 20, stopAtr: 1.8, tpR: 2, exit: 'target', trendFilter: true },
  { label: 'Fade 40 + trend, trail 20', entryLook: 40, exitLook: 20, stopAtr: 1.8, exit: 'trail', trendFilter: true },
  { label: 'Fade 20 + squeeze, 2R',     entryLook: 20, stopAtr: 1.8, tpR: 2, exit: 'target', squeeze: true },
  { label: 'Fade 40 + squeeze, trail',  entryLook: 40, exitLook: 20, stopAtr: 1.8, exit: 'trail', squeeze: true },
];

const universe = JSON.parse(fs.readFileSync(path.join(DIR, 'universe.json'), 'utf8'));
let examined = 0;
const survivors = [];

for (const interval of INTERVALS) {
  const dir = path.join(DIR, 'klines-' + interval);
  if (!fs.existsSync(dir)) {
    console.log('no cached ' + interval + 'm candles — run study-interval.mjs first\n');
    continue;
  }
  const series = [];
  for (const u of universe) {
    const f = path.join(dir, u.symbol + '.json');
    if (!fs.existsSync(f)) continue;
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (c.length >= 300) series.push(c);
  }

  console.log('=== ' + interval + 'm bars, ' + series.length + ' symbols ===');
  console.log('  rule                          trades   mean R   naive t   CLUSTERED t   1st half   2nd half');

  for (const cfg of CONFIGS) {
    const trades = [];
    for (const candles of series) trades.push(...tradeSymbol(candles, cfg));
    trades.sort((a, b) => a.t - b.t);
    const naive = tStat(trades.map((x) => x.r));
    const clust = clustered(trades);
    if (!naive || !clust) { console.log('  ' + cfg.label.padEnd(30) + 'too few trades'); continue; }
    examined++;

    const half = Math.floor(trades.length / 2);
    const h1 = clustered(trades.slice(0, half));
    const h2 = clustered(trades.slice(half));
    console.log('  ' + cfg.label.padEnd(30) + String(naive.n).padStart(6) +
      (naive.mean >= 0 ? '   +' : '   ') + naive.mean.toFixed(3) +
      naive.t.toFixed(2).padStart(10) + clust.t.toFixed(2).padStart(14) +
      (h1 ? h1.t.toFixed(2).padStart(11) : '          —') +
      (h2 ? h2.t.toFixed(2).padStart(11) : '          —'));

    if (clust.t > 3.2 && h1 && h2 && h1.t > 0 && h2.t > 0) {
      survivors.push(interval + 'm  ' + cfg.label + '  clustered t ' + clust.t.toFixed(2));
    }
  }
  console.log('');
}

console.log(examined + ' configurations examined; the corrected 5% threshold is about |t| > 3.2.');
console.log('A rule must clear that on the CLUSTERED t and be positive in both halves.\n');
if (survivors.length === 0) {
  console.log('SURVIVORS: none. Fading breakouts is not an edge either.');
} else {
  console.log('SURVIVORS:');
  for (const s of survivors) console.log('  ' + s);
  console.log('\nThese still need a walk-forward before anything goes live.');
}
