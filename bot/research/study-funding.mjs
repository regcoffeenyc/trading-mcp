// Study: funding-rate carry on Bybit USDT perpetuals, in detail.
//
// Why this and not another price pattern: funding is a structural cash flow,
// not a chart shape. When a perpetual trades above spot, longs pay shorts every
// 8 hours to pull it back. Being paid to hold the unpopular side is an effect
// with an economic reason to exist, which is more than an EMA cross can say.
//
// Design: each day, rank symbols by trailing funding. Short the most expensive
// (highest funding, where longs pay most), long the most negative. Hold one day,
// equal weight, rebalance daily, costs charged on every rebalance.
//
// Run from the bot/ directory, after fetch-universe.mjs.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('data/research');
const TAKER = 0.00055;
const SLIP = 0.0002;
const DAY = 86400000;

const universe = JSON.parse(fs.readFileSync(path.join(DIR, 'universe.json'), 'utf8'));

const data = new Map();
for (const inst of universe) {
  const kFile = path.join(DIR, 'klines', inst.symbol + '.json');
  const fFile = path.join(DIR, 'funding', inst.symbol + '.json');
  if (!fs.existsSync(kFile) || !fs.existsSync(fFile)) continue;
  const candles = JSON.parse(fs.readFileSync(kFile, 'utf8'));
  const funding = JSON.parse(fs.readFileSync(fFile, 'utf8'));
  if (candles.length < 120 || funding.length < 120) continue;

  const byDay = new Map();
  for (const c of candles) byDay.set(Math.floor(c.t / DAY), { close: c.c, turnover: c.q });
  const fundByDay = new Map();
  for (const f of funding) {
    const d = Math.floor(f.t / DAY);
    fundByDay.set(d, (fundByDay.get(d) ?? 0) + f.r);
  }
  data.set(inst.symbol, { byDay, fundByDay });
}

console.log(`symbols with usable data: ${data.size}`);

const dayCounts = new Map();
for (const { byDay } of data.values()) {
  for (const d of byDay.keys()) dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
}
const days = [...dayCounts.entries()].filter(([, n]) => n >= 30).map(([d]) => d).sort((a, b) => a - b);
console.log(`trading days with >=30 symbols: ${days.length}`);
console.log(`from ${new Date(days[0] * DAY).toISOString().slice(0, 10)} to ${new Date(days.at(-1) * DAY).toISOString().slice(0, 10)}`);

const LOOKBACK = Number(process.env.LOOKBACK ?? 3);
const BASKET = Number(process.env.BASKET ?? 10);
const MIN_TURNOVER = Number(process.env.MIN_TURNOVER ?? 2_000_000);

const dailyReturns = [];

for (let i = LOOKBACK; i < days.length - 1; i++) {
  const day = days[i];
  const next = days[i + 1];
  if (next - day !== 1) continue;

  const candidates = [];
  for (const [symbol, { byDay, fundByDay }] of data) {
    const today = byDay.get(day);
    const tomorrow = byDay.get(next);
    if (!today || !tomorrow || today.turnover < MIN_TURNOVER) continue;

    let trailing = 0, seen = 0;
    for (let k = 0; k < LOOKBACK; k++) {
      const f = fundByDay.get(day - k);
      if (f !== undefined) { trailing += f; seen++; }
    }
    if (seen < LOOKBACK) continue;

    candidates.push({
      symbol,
      trailing,
      priceReturn: (tomorrow.close - today.close) / today.close,
      fundingPaid: fundByDay.get(next) ?? 0,
    });
  }

  if (candidates.length < BASKET * 2 + 10) continue;
  candidates.sort((a, b) => b.trailing - a.trailing);

  const shorts = candidates.slice(0, BASKET);
  const longs = candidates.slice(-BASKET);
  const shortPnl = shorts.reduce((s, c) => s + (-c.priceReturn + c.fundingPaid), 0) / BASKET;
  const longPnl = longs.reduce((s, c) => s + (c.priceReturn - c.fundingPaid), 0) / BASKET;
  const cost = 2 * (TAKER + SLIP) * 2;

  dailyReturns.push({ day, gross: (shortPnl + longPnl) / 2, net: (shortPnl + longPnl) / 2 - cost });
}

function stats(values, label) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const t = mean / (sd / Math.sqrt(n));
  console.log('');
  console.log(label);
  console.log(`  days                 ${n}`);
  console.log(`  mean daily return    ${(mean * 100).toFixed(4)}%`);
  console.log(`  annualised           ${(mean * 365 * 100).toFixed(1)}%`);
  console.log(`  daily volatility     ${(sd * 100).toFixed(3)}%`);
  console.log(`  t statistic          ${t.toFixed(2)}`);
  console.log(`  Sharpe (annualised)  ${((mean / sd) * Math.sqrt(365)).toFixed(2)}`);
  console.log(`  verdict              ${Math.abs(t) > 2 ? 'SIGNIFICANT' : 'not distinguishable from zero'}`);
}

console.log(`\nlookback ${LOOKBACK}d, basket ${BASKET} per side, min turnover $${MIN_TURNOVER.toLocaleString()}`);
stats(dailyReturns.map((r) => r.gross), 'GROSS (before costs)');
stats(dailyReturns.map((r) => r.net), 'NET (after fees and slippage)');

const half = Math.floor(dailyReturns.length / 2);
stats(dailyReturns.slice(0, half).map((r) => r.net), 'NET — first half');
stats(dailyReturns.slice(half).map((r) => r.net), 'NET — second half (out of sample)');
