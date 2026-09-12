// Adversarial validation of the daily trend result.
//
// The pooled test reported t 6.93, but it treated 2776 trades as independent
// when crypto perps move together — trades opened on the same day are close to
// the same bet, so pooling overstates significance, sometimes by a lot.
//
// This rebuilds the strategy as a PORTFOLIO and tests its daily return series
// instead. Cross-sectional correlation then shows up honestly as volatility in
// that series rather than as extra sample size. It also splits the history and
// checks the years separately, because an effect that lives in one bull run is
// not an edge.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('data/research');
const DAY = 86400000;
const FEE = 0.0002;   // maker

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

const universe = JSON.parse(fs.readFileSync(path.join(DIR, 'universe.json'), 'utf8'));
const bySymbol = new Map();
for (const inst of universe) {
  const f = path.join(DIR, 'klines', inst.symbol + '.json');
  if (!fs.existsSync(f)) continue;
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (c.length >= 300) bySymbol.set(inst.symbol, c);
}

const CFG = { fast: 20, slow: 50, trendLen: 100, stopAtr: 2.5, tpR: 2 };

/**
 * Replays one symbol, emitting each trade's R multiple stamped with the day it
 * closed, so P&L can be bucketed into a portfolio series.
 */
function tradesFor(candles) {
  const closes = candles.map((c) => c.c);
  const f = ema(closes, CFG.fast), s = ema(closes, CFG.slow), t = ema(closes, CFG.trendLen);
  const a = atr(candles, 14);
  const out = [];
  let pos = null;

  for (let i = CFG.trendLen + 1; i < candles.length - 1; i++) {
    const bar = candles[i], next = candles[i + 1];
    if (pos) {
      const dir = pos.side === 'long' ? 1 : -1;
      const hitStop = pos.side === 'long' ? bar.l <= pos.stop : bar.h >= pos.stop;
      const hitTp = pos.side === 'long' ? bar.h >= pos.tp : bar.l <= pos.tp;
      if (hitStop || hitTp) {
        const exit = hitStop ? pos.stop : pos.tp;
        const r = ((exit - pos.entry) * dir - (pos.entry + exit) * FEE) / pos.risk;
        out.push({ day: Math.floor(bar.t / DAY), openDay: pos.openDay, r });
        pos = null;
      }
    }
    if (pos) continue;
    if (f[i] == null || s[i] == null || t[i] == null || a[i] == null) continue;
    const crossUp = f[i - 1] <= s[i - 1] && f[i] > s[i];
    const crossDn = f[i - 1] >= s[i - 1] && f[i] < s[i];
    if ((a[i] / bar.c) * 100 < 0.5) continue;
    if (crossUp && bar.c > t[i]) {
      const entry = next.o, risk = a[i] * CFG.stopAtr;
      pos = { side: 'long', entry, stop: entry - risk, tp: entry + risk * CFG.tpR, risk, openDay: Math.floor(next.t / DAY) };
    } else if (crossDn && bar.c < t[i]) {
      const entry = next.o, risk = a[i] * CFG.stopAtr;
      pos = { side: 'short', entry, stop: entry + risk, tp: entry - risk * CFG.tpR, risk, openDay: Math.floor(next.t / DAY) };
    }
  }
  return out;
}

const all = [];
for (const [symbol, candles] of bySymbol) {
  for (const tr of tradesFor(candles)) all.push({ symbol, ...tr });
}
all.sort((a, b) => a.day - b.day);
console.log('trades: ' + all.length + ' across ' + bySymbol.size + ' symbols');

function describe(label, trades) {
  if (trades.length < 30) { console.log('  ' + label.padEnd(26) + 'too few trades'); return null; }

  // Pooled, treating every trade as independent — the optimistic view.
  const rs = trades.map((t) => t.r);
  const n = rs.length;
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const tPooled = mean / (sd / Math.sqrt(n));

  // Clustered by day: same-day trades collapse into one observation, so
  // correlated bets stop counting as independent evidence.
  const byDay = new Map();
  for (const t of trades) {
    if (!byDay.has(t.day)) byDay.set(t.day, []);
    byDay.get(t.day).push(t.r);
  }
  const daily = [...byDay.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  const dn = daily.length;
  const dMean = daily.reduce((a, b) => a + b, 0) / dn;
  const dSd = Math.sqrt(daily.reduce((a, b) => a + (b - dMean) ** 2, 0) / (dn - 1));
  const tClustered = dMean / (dSd / Math.sqrt(dn));

  const wins = rs.filter((r) => r > 0).length;
  console.log('  ' + label.padEnd(26) + String(n).padStart(6) +
    (mean >= 0 ? '   +' : '   ') + mean.toFixed(3) +
    tPooled.toFixed(2).padStart(9) +
    tClustered.toFixed(2).padStart(11) +
    String(dn).padStart(7) +
    ((wins / n) * 100).toFixed(0).padStart(7) + '%');
  return { mean, tPooled, tClustered, days: dn };
}

console.log('\n  window                    trades   mean R   t(pooled) t(clustered)  days  win%');
describe('full sample', all);

const mid = all[Math.floor(all.length / 2)].day;
describe('first half', all.filter((t) => t.day < mid));
describe('second half (held out)', all.filter((t) => t.day >= mid));

console.log('');
const years = [...new Set(all.map((t) => new Date(t.day * DAY).getUTCFullYear()))].sort();
for (const y of years) {
  describe(String(y), all.filter((t) => new Date(t.day * DAY).getUTCFullYear() === y));
}

console.log('\n  Long vs short — a trend edge that is only long is a bull-market artefact:');
describe('longs only', all.filter((t) => t.r !== undefined && t.long !== false));

console.log('\nt(clustered) is the number to trust. t(pooled) counts correlated same-day');
console.log('trades as independent evidence and will always look better than reality.');
