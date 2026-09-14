// Does the strategy earn its money in high-volatility names, and can that be
// used honestly?
//
// The funding study, which was looking for something else, showed mean R by ATR
// band at entry: +0.065 below 2%, +0.074 from 2-4%, +0.021 from 4-7%, and
// +0.173 above 7% on 804 trades. There is a mechanism behind that shape - a
// trend has to travel 2R to pay, and 2R is 3.6 ATR, so a symbol that barely
// moves has to trend for a very long time to get there - which is why the
// number is worth a test rather than a shrug.
//
// It is also exactly how this project has been fooled before. A subgroup found
// by looking at the data is not evidence about that subgroup; it is evidence
// that subgroups vary. Four bands were examined and the best one was noticed,
// so the best one is expected to look good whether or not anything is there.
//
// The test that answers it: choose the threshold using only the first half of
// the sample, then apply it, once, to the second half the choice never saw.
// Nothing about the second half informs the decision, so its result is an
// honest estimate rather than a restatement of the search.
//
// Reported on the second half:
//   clustered t   grouped by day, because crypto moves together
//   lift          filtered mean R against unfiltered, on the same trades
//
// A threshold that only works in-sample is the null result this is designed to
// produce cleanly.
//
//   node research/study-vol-filter.mjs
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('data/research');
const INTERVAL = process.env.INTERVAL ?? '720';
const MAKER = 0.0002;
const FAST = 21, SLOW = 55, TREND = 200, STOP_ATR = 1.8, TP_R = 2, MIN_ATR_PCT = 0.15;
const CANDIDATES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10];

function ema(v, p) {
  const out = new Array(v.length).fill(null);
  if (v.length < p) return out;
  const k = 2 / (p + 1);
  let prev = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = prev;
  for (let i = p; i < v.length; i++) { prev = v[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

function atr(c, p) {
  const tr = c.map((x, i) => i === 0 ? x.h - x.l
    : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c)));
  const out = new Array(c.length).fill(null);
  if (c.length < p) return out;
  let prev = tr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = prev;
  for (let i = p; i < c.length; i++) { prev = (prev * (p - 1) + tr[i]) / p; out[i] = prev; }
  return out;
}

function tradeSymbol(candles) {
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
        out.push({
          r: (gross - costs) / pos.risk,
          atrPct: pos.atrPct,
          at: pos.at,
          day: new Date(pos.at).toISOString().slice(0, 10),
        });
        pos = null;
      }
    }
    if (pos) continue;
    if (f[i] == null || s[i] == null || t[i] == null || a[i] == null) continue;
    const atrPct = (a[i] / bar.c) * 100;
    if (atrPct < MIN_ATR_PCT) continue;
    const crossUp = f[i - 1] <= s[i - 1] && f[i] > s[i];
    const crossDn = f[i - 1] >= s[i - 1] && f[i] < s[i];
    const risk = a[i] * STOP_ATR;
    if (crossUp && bar.c > t[i]) {
      pos = { side: 'long', entry: next.o, stop: next.o - risk, tp: next.o + risk * TP_R, risk, atrPct, at: next.t };
    } else if (crossDn && bar.c < t[i]) {
      pos = { side: 'short', entry: next.o, stop: next.o + risk, tp: next.o - risk * TP_R, risk, atrPct, at: next.t };
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

function clustered(trades) {
  const byDay = new Map();
  for (const tr of trades) {
    if (!byDay.has(tr.day)) byDay.set(tr.day, []);
    byDay.get(tr.day).push(tr.r);
  }
  return stats([...byDay.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length));
}

const universe = JSON.parse(fs.readFileSync(path.join(DIR, 'universe.json'), 'utf8'));
const all = [];
for (const u of universe) {
  const kf = path.join(DIR, 'klines-' + INTERVAL, u.symbol + '.json');
  if (!fs.existsSync(kf)) continue;
  const candles = JSON.parse(fs.readFileSync(kf, 'utf8'));
  if (candles.length < TREND + 50) continue;
  all.push(...tradeSymbol(candles));
}

all.sort((a, b) => a.at - b.at);
const cut = Math.floor(all.length / 2);
const early = all.slice(0, cut);
const late = all.slice(cut);

console.log(`${all.length} trades; ${early.length} to choose from, ${late.length} held back`);
console.log(`split at ${new Date(late[0].at).toISOString().slice(0, 10)}\n`);

console.log('CHOOSING on the first half only');
console.log('  min ATR%   trades    mean R   clustered t');
let best = null;
for (const threshold of CANDIDATES) {
  const kept = early.filter((x) => x.atrPct >= threshold);
  const st = stats(kept.map((x) => x.r));
  const cl = clustered(kept);
  if (!st || !cl) continue;
  console.log('  ' + String(threshold).padStart(7) + '%' + String(kept.length).padStart(9) +
    ((st.mean >= 0 ? '   +' : '   ') + st.mean.toFixed(4)).padStart(11) + cl.t.toFixed(2).padStart(14));
  // Chosen on mean R alone, deliberately: picking on the t-statistic would be
  // selecting on the same quantity the held-out half is about to be judged by.
  if (!best || st.mean > best.mean) best = { threshold, mean: st.mean, n: kept.length };
}

console.log(`\nchosen: ATR >= ${best.threshold}%  (mean R ${best.mean.toFixed(4)} in-sample)\n`);

console.log('APPLYING to the held-out half, once');
const keptLate = late.filter((x) => x.atrPct >= best.threshold);
const allLate = stats(late.map((x) => x.r));
const filtered = stats(keptLate.map((x) => x.r));
const clAll = clustered(late);
const clFiltered = clustered(keptLate);

console.log('                    trades    mean R      t    clustered t');
console.log('  unfiltered      ' + String(allLate.n).padStart(8) +
  ((allLate.mean >= 0 ? '   +' : '   ') + allLate.mean.toFixed(4)).padStart(11) +
  allLate.t.toFixed(2).padStart(8) + clAll.t.toFixed(2).padStart(14));
console.log('  ATR >= ' + String(best.threshold) + '%       ' + String(filtered.n).padStart(8) +
  ((filtered.mean >= 0 ? '   +' : '   ') + filtered.mean.toFixed(4)).padStart(11) +
  filtered.t.toFixed(2).padStart(8) + clFiltered.t.toFixed(2).padStart(14));

const lift = filtered.mean - allLate.mean;
console.log('\n  lift from the filter: ' + (lift >= 0 ? '+' : '') + lift.toFixed(4) + ' R per trade');
console.log('  trades kept: ' + ((filtered.n / allLate.n) * 100).toFixed(0) + '%');

const verdict = clFiltered.t > 2 && lift > 0
  ? 'HOLDS OUT OF SAMPLE — worth a walk-forward before it goes live'
  : lift > 0
    ? 'positive but not significant — the lift is real-looking and could still be luck'
    : 'DOES NOT HOLD — the band was an artefact of where it was found';
console.log('\n  verdict: ' + verdict);
