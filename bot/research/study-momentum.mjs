// Focused examination of the one signal that survived the first screen:
// 30-day cross-sectional momentum, weekly rebalance.
//
// A single t of 2.40 found among fifteen tested combinations is not evidence —
// that is how the first false positive in this project was produced. Before
// believing it, three things have to hold:
//
//   1. Out of sample. Split the history; the effect must appear in the second
//      half without being fitted there.
//   2. Parameter robustness. A real effect degrades smoothly as lookback,
//      holding period and basket size change. A fitted one has a single lucky
//      cell surrounded by noise.
//   3. Multiple-testing honesty. With N combinations tested, the bar is
//      |t| > 2 corrected for N, not the nominal 1.96.
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

const ret = (sym, from, to) => {
  const a = series.get(sym).byDay.get(from);
  const b = series.get(sym).byDay.get(to);
  return a && b ? (b.c - a.c) / a.c : null;
};

function run({ lookback, hold, basket, minTurnover, from = 0, to = 1 }) {
  const start = Math.max(120, Math.floor(days.length * from));
  const end = Math.floor(days.length * to) - hold;
  const periods = [];
  for (let i = start; i < end; i += hold) {
    const d = days[i];
    const exit = days[i + hold];
    const rows = [];
    for (const [sym, s] of series) {
      const today = s.byDay.get(d);
      if (!today || today.q < minTurnover) continue;
      const value = ret(sym, d - lookback, d);
      if (value === null || !Number.isFinite(value)) continue;
      const fwd = ret(sym, d, exit);
      if (fwd === null) continue;
      let fund = 0;
      for (let k = 1; k <= hold; k++) fund += s.fundByDay.get(d + k) ?? 0;
      rows.push({ value, fwd, fund });
    }
    if (rows.length < basket * 2 + 10) continue;
    rows.sort((a, b) => b.value - a.value);
    const longs = rows.slice(0, basket);
    const shorts = rows.slice(-basket);
    const longPnl = longs.reduce((s, r) => s + r.fwd - r.fund, 0) / basket;
    const shortPnl = shorts.reduce((s, r) => s + -r.fwd + r.fund, 0) / basket;
    const cost = 2 * 0.5 * 2 * (TAKER + SLIP);
    periods.push((longPnl + shortPnl) / 2 - cost);
  }
  const n = periods.length;
  if (n < 20) return null;
  const mean = periods.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(periods.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return {
    n, mean, t: mean / (sd / Math.sqrt(n)),
    annual: mean * (365 / hold),
    sharpe: (mean / sd) * Math.sqrt(365 / hold),
  };
}

const base = { lookback: 30, hold: 7, basket: 10, minTurnover: 2_000_000 };
const show = (label, r) => {
  if (!r) { console.log(label.padEnd(30) + 'insufficient data'); return; }
  console.log(
    label.padEnd(30) + String(r.n).padStart(5) +
    (r.mean * 100).toFixed(3).padStart(10) + '%' +
    (r.annual * 100).toFixed(1).padStart(10) + '%' +
    r.t.toFixed(2).padStart(8) + r.sharpe.toFixed(2).padStart(8),
  );
};

console.log('                              periods  net/per   annual   t-stat  Sharpe');
console.log('\n--- 1. OUT OF SAMPLE ---');
show('full sample', run(base));
show('first half', run({ ...base, from: 0, to: 0.5 }));
show('second half (held out)', run({ ...base, from: 0.5, to: 1 }));
show('last third only', run({ ...base, from: 0.667, to: 1 }));

console.log('\n--- 2. LOOKBACK ROBUSTNESS (hold 7) ---');
for (const lookback of [10, 20, 30, 45, 60, 90]) show(`lookback ${lookback}d`, run({ ...base, lookback }));

console.log('\n--- 3. HOLDING PERIOD ROBUSTNESS (lookback 30) ---');
for (const hold of [3, 5, 7, 10, 14, 21]) show(`hold ${hold}d`, run({ ...base, hold }));

console.log('\n--- 4. BASKET SIZE ROBUSTNESS ---');
for (const basket of [5, 10, 15, 20, 30]) show(`basket ${basket}/side`, run({ ...base, basket }));

console.log('\n--- 5. LIQUIDITY FILTER ROBUSTNESS ---');
for (const minTurnover of [500_000, 2_000_000, 10_000_000, 50_000_000]) {
  show(`min turnover $${(minTurnover / 1e6).toFixed(1)}M`, run({ ...base, minTurnover }));
}

const tested = 6 + 6 + 5 + 4 + 5;
console.log(`\nCombinations examined here: ${tested}. With that many looks, the`);
console.log(`5% threshold is roughly |t| > ${(1.96 + Math.log(tested) / 2).toFixed(1)}, not 1.96.`);
console.log('A real effect shows a broad plateau of positive t across neighbouring');
console.log('parameters. A fitted one shows a single spike. Read the shape, not the peak.');
