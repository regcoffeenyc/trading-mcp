// Study: time-series trend on the DAILY timeframe, Bybit data, maker fees.
//
// The earlier timeframe sweep that showed daily bars looking best ran on OKX
// candles with a hand-picked symbol list — the same sample that produced a
// +0.253 R phantom. This re-runs the question on Bybit's own data across the
// full universe, per-symbol, with a significance test on the pooled trades.
//
// Time-series (each symbol judged against itself) rather than cross-sectional,
// because that is what the live bot actually trades.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('data/research');
const DAY = 86400000;
const MAKER = 0.0002;
const TAKER = 0.00055;

const universe = JSON.parse(fs.readFileSync(path.join(DIR, 'universe.json'), 'utf8'));

/** Wilder ATR over daily candles. */
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

function ema(v, period) {
  const out = new Array(v.length).fill(null);
  if (v.length < period) return out;
  const k = 2 / (period + 1);
  let prev = v.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < v.length; i++) { prev = v[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

/** Returns every trade's R multiple for one symbol. */
function tradeSymbol(candles, { fast, slow, trendLen, stopAtr, tpR, fee }) {
  const closes = candles.map((c) => c.c);
  const f = ema(closes, fast), s = ema(closes, slow), t = ema(closes, trendLen);
  const a = atr(candles, 14);
  const out = [];
  let pos = null;

  for (let i = Math.max(trendLen, 20) + 1; i < candles.length - 1; i++) {
    const bar = candles[i], next = candles[i + 1];

    if (pos) {
      const dir = pos.side === 'long' ? 1 : -1;
      const hitStop = pos.side === 'long' ? bar.l <= pos.stop : bar.h >= pos.stop;
      const hitTp = pos.side === 'long' ? bar.h >= pos.tp : bar.l <= pos.tp;
      // Stop assumed first when a bar spans both — the pessimistic reading.
      if (hitStop || hitTp) {
        const exit = hitStop ? pos.stop : pos.tp;
        const gross = (exit - pos.entry) * dir;
        const costs = (pos.entry + exit) * fee;
        out.push((gross - costs) / pos.risk);
        pos = null;
      }
    }
    if (pos) continue;

    if (f[i] == null || s[i] == null || t[i] == null || a[i] == null) continue;
    const crossUp = f[i - 1] <= s[i - 1] && f[i] > s[i];
    const crossDn = f[i - 1] >= s[i - 1] && f[i] < s[i];
    const atrPct = (a[i] / bar.c) * 100;
    if (atrPct < 0.5) continue;   // dead tape on a daily bar

    if (crossUp && bar.c > t[i]) {
      const entry = next.o, risk = a[i] * stopAtr;
      pos = { side: 'long', entry, stop: entry - risk, tp: entry + risk * tpR, risk };
    } else if (crossDn && bar.c < t[i]) {
      const entry = next.o, risk = a[i] * stopAtr;
      pos = { side: 'short', entry, stop: entry + risk, tp: entry - risk * tpR, risk };
    }
  }
  return out;
}

function stats(rs) {
  const n = rs.length;
  if (n < 30) return null;
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { n, mean, sd, t: mean / (sd / Math.sqrt(n)) };
}

const candlesBySymbol = new Map();
for (const inst of universe) {
  const f = path.join(DIR, 'klines', inst.symbol + '.json');
  if (!fs.existsSync(f)) continue;
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (c.length >= 300) candlesBySymbol.set(inst.symbol, c);
}
console.log('symbols with >=300 daily bars: ' + candlesBySymbol.size);

const CONFIGS = [
  { label: 'EMA21/55 trend200  2R', fast: 21, slow: 55, trendLen: 200, stopAtr: 1.8, tpR: 2 },
  { label: 'EMA21/55 trend200  3R', fast: 21, slow: 55, trendLen: 200, stopAtr: 1.8, tpR: 3 },
  { label: 'EMA10/30 trend100  2R', fast: 10, slow: 30, trendLen: 100, stopAtr: 1.8, tpR: 2 },
  { label: 'EMA20/50 trend100  2R', fast: 20, slow: 50, trendLen: 100, stopAtr: 2.5, tpR: 2 },
  { label: 'EMA50/100 trend200 3R', fast: 50, slow: 100, trendLen: 200, stopAtr: 2.5, tpR: 3 },
];

for (const fee of [{ name: 'maker', v: MAKER }, { name: 'taker', v: TAKER }]) {
  console.log('\n=== DAILY bars, ' + fee.name + ' fees ===');
  console.log('  config                        trades   mean R    sd     t-stat   verdict');
  for (const cfg of CONFIGS) {
    const all = [];
    let positiveSymbols = 0, testedSymbols = 0;
    for (const [, candles] of candlesBySymbol) {
      const rs = tradeSymbol(candles, { ...cfg, fee: fee.v });
      if (rs.length >= 3) {
        testedSymbols++;
        if (rs.reduce((a, b) => a + b, 0) > 0) positiveSymbols++;
      }
      all.push(...rs);
    }
    const st = stats(all);
    if (!st) { console.log('  ' + cfg.label.padEnd(28) + 'too few trades'); continue; }
    const verdict = Math.abs(st.t) > 2 ? (st.t > 0 ? 'SIGNIFICANT +' : 'SIGNIFICANT -') : 'noise';
    console.log('  ' + cfg.label.padEnd(28) + String(st.n).padStart(6) +
      (st.mean >= 0 ? '   +' : '   ') + st.mean.toFixed(3) +
      st.sd.toFixed(2).padStart(7) + st.t.toFixed(2).padStart(9) + '   ' + verdict +
      '  (' + positiveSymbols + '/' + testedSymbols + ' symbols +)');
  }
}

console.log('\n10 configurations examined; the corrected 5% bar is about |t| > 3.1.');
