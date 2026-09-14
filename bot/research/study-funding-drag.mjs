// What does funding cost the strategy that is actually running?
//
// The bot has never once considered funding. It holds perpetual positions for
// days on 12-hour bars, and a perpetual charges or pays funding every hour on
// this venue - so every trade has been settling a cash flow the backtest never
// modelled and the live bot cannot see.
//
// The reason this is not a rounding error is the units. Funding is charged on
// NOTIONAL; the strategy measures in R, where R is the risk, and risk is
// 1.8 ATR of distance. The conversion is therefore
//
//     funding in R  =  funding rate x notional / risk
//                   =  funding rate x entry / (1.8 x ATR)
//
// and that multiplier is large precisely where ATR is small. On a 2%-ATR symbol
// it is about 28x, so a tenth of a percent of accumulated funding is 0.028 R
// against a measured mean of 0.046 R. A cost that size is not a detail; it is
// most of the result.
//
// Unlike every other study here, this one is not looking for an edge. It is
// measuring a cost, and a cost avoided is return kept with certainty rather
// than by forecast. That is the only kind of improvement left that does not
// require predicting anything.
//
//   node research/study-funding-drag.mjs
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('data/research');
const INTERVAL = process.env.INTERVAL ?? '720';
const MAKER = 0.0002;
const FAST = 21, SLOW = 55, TREND = 200, STOP_ATR = 1.8, TP_R = 2, MIN_ATR_PCT = 0.15;

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
 * Funding settled between two instants, as a signed rate total.
 *
 * A long pays when the rate is positive and receives when it is negative; a
 * short is the mirror. Returned unsigned here and signed by the caller, so the
 * sign convention lives in one place.
 */
function fundingBetween(rates, fromMs, toMs) {
  let total = 0;
  for (const f of rates) {
    if (f.t > fromMs && f.t <= toMs) total += f.r;
  }
  return total;
}

function tradeSymbol(candles, rates) {
  const closes = candles.map((c) => c.c);
  const f = ema(closes, FAST), s = ema(closes, SLOW), t = ema(closes, TREND);
  const a = atr(candles, 14);
  const out = [];
  let pos = null;

  for (let i = TREND + 1; i < candles.length - 1; i++) {
    const bar = candles[i], next = candles[i + 1];

    if (pos) {
      const dir = pos.side === 'long' ? 1 : -1;
      const hitStop = pos.side === 'long' ? bar.l <= pos.stop : bar.h >= pos.stop;
      const hitTp = pos.side === 'long' ? bar.h >= pos.tp : bar.l <= pos.tp;
      if (hitStop || hitTp) {
        const exit = hitStop ? pos.stop : pos.tp;
        const gross = (exit - pos.entry) * dir;
        const costs = (pos.entry + exit) * MAKER;
        // Funding is charged on notional; convert to R by the same divisor the
        // rest of the result uses.
        const rateTotal = fundingBetween(rates, pos.at, bar.t);
        const fundingR = (-dir * rateTotal * pos.entry) / pos.risk;
        out.push({
          r: (gross - costs) / pos.risk,
          fundingR,
          hours: (bar.t - pos.at) / 3_600_000,
          atrPct: (pos.atr / pos.entry) * 100,
          day: new Date(pos.at).toISOString().slice(0, 10),
        });
        pos = null;
      }
    }
    if (pos) continue;
    if (f[i] == null || s[i] == null || t[i] == null || a[i] == null) continue;
    const crossUp = f[i - 1] <= s[i - 1] && f[i] > s[i];
    const crossDn = f[i - 1] >= s[i - 1] && f[i] < s[i];
    if ((a[i] / bar.c) * 100 < MIN_ATR_PCT) continue;

    const risk = a[i] * STOP_ATR;
    if (crossUp && bar.c > t[i]) {
      pos = { side: 'long', entry: next.o, stop: next.o - risk, tp: next.o + risk * TP_R, risk, atr: a[i], at: next.t };
    } else if (crossDn && bar.c < t[i]) {
      pos = { side: 'short', entry: next.o, stop: next.o + risk, tp: next.o - risk * TP_R, risk, atr: a[i], at: next.t };
    }
  }
  return out;
}

function stats(xs) {
  const n = xs.length;
  if (n < 10) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { n, mean, sd, t: sd === 0 ? 0 : mean / (sd / Math.sqrt(n)) };
}

function clustered(trades, pick) {
  const byDay = new Map();
  for (const tr of trades) {
    if (!byDay.has(tr.day)) byDay.set(tr.day, []);
    byDay.get(tr.day).push(pick(tr));
  }
  return stats([...byDay.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length));
}

const universe = JSON.parse(fs.readFileSync(path.join(DIR, 'universe.json'), 'utf8'));
const trades = [];
let withFunding = 0;

for (const u of universe) {
  const kf = path.join(DIR, 'klines-' + INTERVAL, u.symbol + '.json');
  const ff = path.join(DIR, 'funding', u.symbol + '.json');
  if (!fs.existsSync(kf) || !fs.existsSync(ff)) continue;
  const candles = JSON.parse(fs.readFileSync(kf, 'utf8'));
  if (candles.length < TREND + 50) continue;
  const rates = JSON.parse(fs.readFileSync(ff, 'utf8'));
  if (rates.length === 0) continue;
  withFunding += 1;
  trades.push(...tradeSymbol(candles, rates));
}

// Only trades whose whole life is covered by the funding history can be judged;
// a trade older than the first funding row would look free rather than unknown.
const firstRate = Math.min(...universe
  .map((u) => path.join(DIR, 'funding', u.symbol + '.json'))
  .filter((p) => fs.existsSync(p))
  .map((p) => { const d = JSON.parse(fs.readFileSync(p, 'utf8')); return d.length ? d[0].t : Infinity; }));
const covered = trades.filter((x) => new Date(x.day).getTime() > firstRate);

console.log(`${trades.length} trades across ${withFunding} symbols; ` +
  `${covered.length} fall inside the funding history\n`);

const gross = stats(covered.map((x) => x.r));
const net = stats(covered.map((x) => x.r + x.fundingR));
const drag = stats(covered.map((x) => x.fundingR));

console.log('                       mean R      sd      t');
console.log('  before funding     ' + (gross.mean >= 0 ? '+' : '') + gross.mean.toFixed(4) +
  gross.sd.toFixed(2).padStart(9) + gross.t.toFixed(2).padStart(8));
console.log('  funding itself     ' + (drag.mean >= 0 ? '+' : '') + drag.mean.toFixed(4) +
  drag.sd.toFixed(2).padStart(9) + drag.t.toFixed(2).padStart(8));
console.log('  after funding      ' + (net.mean >= 0 ? '+' : '') + net.mean.toFixed(4) +
  net.sd.toFixed(2).padStart(9) + net.t.toFixed(2).padStart(8));
console.log('\n  clustered t, after funding: ' + clustered(covered, (x) => x.r + x.fundingR).t.toFixed(2));

const paid = covered.filter((x) => x.fundingR < 0);
console.log('\n  trades that PAID funding: ' + paid.length + ' of ' + covered.length +
  '  (' + ((paid.length / covered.length) * 100).toFixed(0) + '%)');
console.log('  median hold: ' + covered.map((x) => x.hours).sort((a, b) => a - b)[Math.floor(covered.length / 2)].toFixed(0) + 'h');

// Where the divisor bites: the same funding rate costs far more R on a quiet
// symbol, because the stop is tight relative to price.
console.log('\n  funding drag by volatility of the symbol at entry');
console.log('    ATR band        trades   mean funding R   mean R before   mean R after');
for (const [lo, hi] of [[0, 2], [2, 4], [4, 7], [7, 100]]) {
  const band = covered.filter((x) => x.atrPct >= lo && x.atrPct < hi);
  if (band.length < 10) continue;
  const b = stats(band.map((x) => x.r)), d = stats(band.map((x) => x.fundingR));
  const a = stats(band.map((x) => x.r + x.fundingR));
  console.log('    ' + (lo + '-' + (hi === 100 ? '+' : hi) + '%').padEnd(16) + String(band.length).padStart(6) +
    ((d.mean >= 0 ? '   +' : '   ') + d.mean.toFixed(4)).padStart(17) +
    ((b.mean >= 0 ? '   +' : '   ') + b.mean.toFixed(4)).padStart(16) +
    ((a.mean >= 0 ? '   +' : '   ') + a.mean.toFixed(4)).padStart(15));
}
