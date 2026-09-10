// Study: cross-sectional signals on the full Bybit USDT perpetual universe.
//
// Each period, rank every liquid symbol by a signal, go long the top basket and
// short the bottom, hold, and charge real costs. Testing several signals in one
// pass over the same data keeps the comparison honest — same universe, same
// costs, same days.
//
// Signals:
//   mom30 / mom90   trailing return (momentum: winners keep winning)
//   rev3            trailing 3-day return, inverted (short-term reversal)
//   funding         trailing funding rate, inverted (carry: be paid to hold)
//   volatility      trailing realised vol, inverted (low-volatility anomaly)
//
// Run from the bot/ directory, after fetch-universe.mjs.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('data/research');
const DAY = 86400000;
const TAKER = 0.00055;
const SLIP = 0.0002;

const universe = JSON.parse(fs.readFileSync(path.join(DIR, 'universe.json'), 'utf8'));

const series = new Map();
for (const inst of universe) {
  const kFile = path.join(DIR, 'klines', inst.symbol + '.json');
  if (!fs.existsSync(kFile)) continue;
  const candles = JSON.parse(fs.readFileSync(kFile, 'utf8'));
  if (candles.length < 200) continue;

  const fFile = path.join(DIR, 'funding', inst.symbol + '.json');
  const fundByDay = new Map();
  if (fs.existsSync(fFile)) {
    for (const f of JSON.parse(fs.readFileSync(fFile, 'utf8'))) {
      const d = Math.floor(f.t / DAY);
      fundByDay.set(d, (fundByDay.get(d) ?? 0) + f.r);
    }
  }
  const byDay = new Map();
  for (const c of candles) byDay.set(Math.floor(c.t / DAY), { c: c.c, q: c.q });
  series.set(inst.symbol, { byDay, fundByDay, days: [...byDay.keys()].sort((a, b) => a - b) });
}

const dayCounts = new Map();
for (const s of series.values()) for (const d of s.days) dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
const days = [...dayCounts.entries()].filter(([, n]) => n >= 40).map(([d]) => d).sort((a, b) => a - b);

console.log(`symbols ${series.size}, trading days ${days.length}`);
console.log(`period ${new Date(days[0] * DAY).toISOString().slice(0, 10)} -> ${new Date(days.at(-1) * DAY).toISOString().slice(0, 10)}`);

const ret = (sym, from, to) => {
  const a = series.get(sym).byDay.get(from);
  const b = series.get(sym).byDay.get(to);
  return a && b ? (b.c - a.c) / a.c : null;
};

const SIGNALS = {
  mom30: (sym, d) => ret(sym, d - 30, d),
  mom90: (sym, d) => ret(sym, d - 90, d),
  rev3: (sym, d) => { const r = ret(sym, d - 3, d); return r === null ? null : -r; },
  funding: (sym, d) => {
    const f = series.get(sym).fundByDay;
    let sum = 0, seen = 0;
    for (let k = 0; k < 3; k++) { const v = f.get(d - k); if (v !== undefined) { sum += v; seen++; } }
    return seen === 3 ? -sum : null;   // negative funding is the attractive side
  },
  volatility: (sym, d) => {
    const b = series.get(sym).byDay;
    const rs = [];
    for (let k = 0; k < 20; k++) {
      const a = b.get(d - k - 1), c = b.get(d - k);
      if (a && c) rs.push(Math.log(c.c / a.c));
    }
    if (rs.length < 20) return null;
    const m = rs.reduce((x, y) => x + y, 0) / rs.length;
    return -Math.sqrt(rs.reduce((x, y) => x + (y - m) ** 2, 0) / rs.length);
  },
};

const BASKET = Number(process.env.BASKET ?? 10);
const HOLD = Number(process.env.HOLD ?? 1);
const MIN_TURNOVER = Number(process.env.MIN_TURNOVER ?? 2_000_000);

function stats(values) {
  const n = values.length;
  if (n < 30) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const periodsPerYear = 365 / HOLD;
  return {
    n, mean, sd,
    t: mean / (sd / Math.sqrt(n)),
    annual: mean * periodsPerYear,
    sharpe: (mean / sd) * Math.sqrt(periodsPerYear),
  };
}

function run(signalName) {
  const signal = SIGNALS[signalName];
  const periods = [];
  for (let i = 100; i < days.length - HOLD; i += HOLD) {
    const d = days[i];
    const exit = days[i + HOLD];
    const rows = [];
    for (const [sym, s] of series) {
      const today = s.byDay.get(d);
      if (!today || today.q < MIN_TURNOVER) continue;
      const value = signal(sym, d);
      if (value === null || !Number.isFinite(value)) continue;
      const fwd = ret(sym, d, exit);
      if (fwd === null) continue;
      let fund = 0;
      for (let k = 1; k <= HOLD; k++) fund += s.fundByDay.get(d + k) ?? 0;
      rows.push({ sym, value, fwd, fund });
    }
    if (rows.length < BASKET * 2 + 10) continue;
    rows.sort((a, b) => b.value - a.value);
    const longs = rows.slice(0, BASKET);
    const shorts = rows.slice(-BASKET);
    const longPnl = longs.reduce((s, r) => s + r.fwd - r.fund, 0) / BASKET;
    const shortPnl = shorts.reduce((s, r) => s + -r.fwd + r.fund, 0) / BASKET;
    const cost = 2 * (TAKER + SLIP) * 2;
    periods.push({ gross: (longPnl + shortPnl) / 2, net: (longPnl + shortPnl) / 2 - cost });
  }
  return periods;
}

console.log(`\nbasket ${BASKET}/side, hold ${HOLD}d, min turnover $${MIN_TURNOVER.toLocaleString()}`);
console.log('');
console.log('signal        periods   net/period   annualised   t-stat   Sharpe   verdict');
for (const name of Object.keys(SIGNALS)) {
  const periods = run(name);
  const net = stats(periods.map((p) => p.net));
  if (!net) { console.log(name.padEnd(13) + 'insufficient data'); continue; }
  const verdict = Math.abs(net.t) > 2 ? (net.t > 0 ? 'SIGNIFICANT +' : 'SIGNIFICANT -') : 'noise';
  console.log(
    name.padEnd(14) + String(net.n).padStart(6) +
    (net.mean * 100).toFixed(4).padStart(12) + '%' +
    (net.annual * 100).toFixed(1).padStart(12) + '%' +
    net.t.toFixed(2).padStart(9) + net.sharpe.toFixed(2).padStart(9) + '   ' + verdict,
  );
}
