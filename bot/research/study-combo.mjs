// Study: can cheaper execution and signal combination turn a zero into an edge?
//
// Two things the earlier screens never tested:
//
//   1. Maker execution. Every previous test charged Bybit's taker fee
//      (0.055%/side). The maker fee is 0.02% — a 64% cut. With fees measured at
//      roughly a third of any edge, this is arithmetic rather than hope.
//
//   2. Combination. Several signals were individually insignificant but
//      positive. Averaging weakly-positive, imperfectly-correlated signals is
//      the standard way a tradeable composite gets built. Each leg is z-scored
//      cross-sectionally per day so no single one dominates by scale.
//
// Run from bot/ after fetch-universe.mjs.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('data/research');
const DAY = 86400000;

const TAKER = 0.00055;
const MAKER = 0.0002;
const SLIP_TAKER = 0.0002;
const SLIP_MAKER = 0;   // a resting limit order does not cross the spread

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

const ret = (sym, from, to) => {
  const a = series.get(sym).byDay.get(from);
  const b = series.get(sym).byDay.get(to);
  return a && b ? (b.c - a.c) / a.c : null;
};

const SIGNALS = {
  mom30: (sym, d) => ret(sym, d - 30, d),
  mom90: (sym, d) => ret(sym, d - 90, d),
  funding: (sym, d) => {
    const f = series.get(sym).fundByDay;
    let sum = 0, seen = 0;
    for (let k = 0; k < 3; k++) { const v = f.get(d - k); if (v !== undefined) { sum += v; seen++; } }
    return seen === 3 ? -sum : null;
  },
  lowvol: (sym, d) => {
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

/** Cross-sectional z-score, so signals on different scales combine fairly. */
function zscore(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) || 1;
  return values.map((v) => (v - mean) / sd);
}

function run({ legs, hold, basket, minTurnover, maker, from = 0, to = 1 }) {
  const fee = maker ? MAKER : TAKER;
  const slip = maker ? SLIP_MAKER : SLIP_TAKER;
  const cost = 2 * 0.5 * 2 * (fee + slip);

  const start = Math.max(100, Math.floor(days.length * from));
  const end = Math.floor(days.length * to) - hold;
  const periods = [];

  for (let i = start; i < end; i += hold) {
    const d = days[i];
    const exit = days[i + hold];
    const rows = [];
    for (const [sym, s] of series) {
      const today = s.byDay.get(d);
      if (!today || today.q < minTurnover) continue;
      const raw = legs.map((name) => SIGNALS[name](sym, d));
      if (raw.some((v) => v === null || !Number.isFinite(v))) continue;
      const fwd = ret(sym, d, exit);
      if (fwd === null) continue;
      let fund = 0;
      for (let k = 1; k <= hold; k++) fund += s.fundByDay.get(d + k) ?? 0;
      rows.push({ raw, fwd, fund });
    }
    if (rows.length < basket * 2 + 10) continue;

    // z-score each leg across today's cross-section, then average.
    const zs = legs.map((_, j) => zscore(rows.map((r) => r.raw[j])));
    rows.forEach((r, k) => { r.score = zs.reduce((sum, z) => sum + z[k], 0) / legs.length; });

    rows.sort((a, b) => b.score - a.score);
    const longs = rows.slice(0, basket);
    const shorts = rows.slice(-basket);
    const longPnl = longs.reduce((s, r) => s + r.fwd - r.fund, 0) / basket;
    const shortPnl = shorts.reduce((s, r) => s + -r.fwd + r.fund, 0) / basket;
    periods.push((longPnl + shortPnl) / 2 - cost);
  }

  const n = periods.length;
  if (n < 20) return null;
  const mean = periods.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(periods.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { n, mean, t: mean / (sd / Math.sqrt(n)), annual: mean * (365 / hold), sharpe: (mean / sd) * Math.sqrt(365 / hold) };
}

const show = (label, r) => {
  if (!r) { console.log('  ' + label.padEnd(34) + 'insufficient data'); return; }
  console.log('  ' + label.padEnd(34) + String(r.n).padStart(5) +
    (r.mean * 100).toFixed(3).padStart(10) + '%' +
    (r.annual * 100).toFixed(1).padStart(10) + '%' +
    r.t.toFixed(2).padStart(8) + r.sharpe.toFixed(2).padStart(8));
};

const base = { hold: 7, basket: 10, minTurnover: 2_000_000 };
console.log('                                    periods   net/per   annual   t-stat  Sharpe');

console.log('\n--- 1. DOES CHEAPER EXECUTION RESCUE A SINGLE SIGNAL? ---');
for (const legs of [['mom30'], ['mom90'], ['funding'], ['lowvol']]) {
  show(legs[0] + '  taker', run({ ...base, legs, maker: false }));
  show(legs[0] + '  maker', run({ ...base, legs, maker: true }));
}

console.log('\n--- 2. COMBINATIONS (maker fees) ---');
const COMBOS = [
  ['mom30', 'funding'],
  ['mom30', 'lowvol'],
  ['mom30', 'mom90'],
  ['mom30', 'funding', 'lowvol'],
  ['mom30', 'mom90', 'funding', 'lowvol'],
];
for (const legs of COMBOS) show(legs.join('+'), run({ ...base, legs, maker: true }));

console.log('\n--- 3. BEST COMBO, HOLD SWEEP (maker) ---');
const best = ['mom30', 'funding', 'lowvol'];
for (const hold of [5, 7, 10, 14, 21]) show(best.join('+') + ' hold ' + hold + 'd', run({ ...base, legs: best, hold, maker: true }));

console.log('\n--- 4. OUT OF SAMPLE (maker, hold 10) ---');
show('full sample', run({ ...base, legs: best, hold: 10, maker: true }));
show('first half', run({ ...base, legs: best, hold: 10, maker: true, from: 0, to: 0.5 }));
show('second half (held out)', run({ ...base, legs: best, hold: 10, maker: true, from: 0.5, to: 1 }));

const tested = 8 + 5 + 5 + 3;
console.log('\nCombinations examined: ' + tested + '. Corrected 5% bar is about |t| > ' +
  (1.96 + Math.log(tested) / 2).toFixed(1) + '.');
console.log('Maker fees assume limit orders actually fill. At a weekly rebalance on liquid');
console.log('perps that is realistic, but a missed fill is a missed trade, not a free one.');
