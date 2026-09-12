// Study: does the live trend rule survive on a faster bar?
//
// The bot trades 12-hour bars, which decide twice a day. The obvious way to
// trade more often is a shorter bar, and the obvious way to get that wrong is
// to shorten it and see more trades and call that better. More trades at a
// worse expectancy is a faster way to lose.
//
// So this runs the SHIPPED rules unchanged - EMA 21/55, 200-EMA regime filter,
// 1.8 ATR stop, 2R target, maker fees both sides - across the whole Bybit
// universe at each candidate interval, and judges them on the same three
// measures that caught the last false positive:
//
//   naive t       every trade treated as independent evidence. Flattering.
//   clustered t   trades grouped by calendar day first. Crypto moves together,
//                 so thirty symbols entering on one morning is closer to one
//                 observation than thirty. This is the number that matters; it
//                 turned an earlier t of 6.93 into -1.29.
//   split halves  first half against second. An edge that only exists in one
//                 of them is a period, not an edge.
//
// Run from the bot/ directory, on a host that can reach Bybit:
//   node research/study-interval.mjs
//   INTERVALS=240,360,720 BARS=2000 node research/study-interval.mjs
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BYBIT_REST_HOST ?? 'https://api.bybit.com';
const DIR = path.resolve('data/research');
const INTERVALS = (process.env.INTERVALS ?? '360,720').split(',').map((s) => s.trim());
const BARS = Number(process.env.BARS ?? 2000);
const CONCURRENCY = 4;
const MAKER = 0.0002;

// The live configuration, copied from .env rather than re-tuned. Re-tuning per
// interval would be fitting the answer to the question.
const FAST = 21, SLOW = 55, TREND = 200, STOP_ATR = 1.8, TP_R = 2, MIN_ATR_PCT = 0.15;

const universe = JSON.parse(fs.readFileSync(path.join(DIR, 'universe.json'), 'utf8'));

async function get(pathname, params, attempt = 0) {
  const qs = new URLSearchParams(params).toString();
  try {
    const res = await fetch(`${BASE}${pathname}?${qs}`);
    if (res.status === 429 || res.status >= 500) throw new Error('throttled ' + res.status);
    const json = await res.json();
    if (json.retCode === 10006 || json.retCode === 10016) throw new Error('rate limit');
    if (json.retCode !== 0) throw new Error(`${json.retCode} ${json.retMsg}`);
    return json.result;
  } catch (err) {
    if (attempt >= 5) throw err;
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return get(pathname, params, attempt + 1);
  }
}

/** Pages backwards until BARS candles are held, oldest first. Cached on disk. */
async function klines(symbol, interval) {
  const dir = path.join(DIR, 'klines-' + interval);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, symbol + '.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));

  const rows = [];
  let end;
  while (rows.length < BARS) {
    const r = await get('/v5/market/kline', {
      category: 'linear', symbol, interval, limit: 1000, ...(end ? { end } : {}),
    });
    const list = r.list ?? [];
    if (list.length === 0) break;
    // Bybit returns newest first; each page ends where the next must start.
    for (const k of list) {
      rows.push({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]) });
    }
    end = Number(list[list.length - 1][0]) - 1;
    if (list.length < 1000) break;
  }
  rows.sort((a, b) => a.t - b.t);
  fs.writeFileSync(file, JSON.stringify(rows));
  return rows;
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

/** Every trade for one symbol, as {r, day} — the day is what clusters on. */
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
      // Stop assumed first when one bar spans both — the pessimistic reading.
      if (hitStop || hitTp) {
        const exit = hitStop ? pos.stop : pos.tp;
        const gross = (exit - pos.entry) * dir;
        const costs = (pos.entry + exit) * MAKER;
        out.push({ r: (gross - costs) / pos.risk, day: pos.day, t: pos.at });
        pos = null;
      }
    }
    if (pos) continue;

    if (f[i] == null || s[i] == null || t[i] == null || a[i] == null) continue;
    const crossUp = f[i - 1] <= s[i - 1] && f[i] > s[i];
    const crossDn = f[i - 1] >= s[i - 1] && f[i] < s[i];
    if ((a[i] / bar.c) * 100 < MIN_ATR_PCT) continue;

    if (crossUp && bar.c > t[i]) {
      const entry = next.o, risk = a[i] * STOP_ATR;
      pos = { side: 'long', entry, stop: entry - risk, tp: entry + risk * TP_R, risk,
              day: new Date(next.t).toISOString().slice(0, 10), at: next.t };
    } else if (crossDn && bar.c < t[i]) {
      const entry = next.o, risk = a[i] * STOP_ATR;
      pos = { side: 'short', entry, stop: entry + risk, tp: entry - risk * TP_R, risk,
              day: new Date(next.t).toISOString().slice(0, 10), at: next.t };
    }
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

/** One observation per calendar day, so a correlated morning counts once. */
function clustered(trades) {
  const byDay = new Map();
  for (const tr of trades) {
    if (!byDay.has(tr.day)) byDay.set(tr.day, []);
    byDay.get(tr.day).push(tr.r);
  }
  return tStat([...byDay.values()].map((rs) => rs.reduce((a, b) => a + b, 0) / rs.length));
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out.push(await fn(items[idx])); } catch { /* symbol skipped */ }
    }
  }));
  return out;
}

const symbols = universe.map((u) => u.symbol);
console.log('universe: ' + symbols.length + ' symbols, ' + BARS + ' bars each\n');

for (const interval of INTERVALS) {
  process.stdout.write('fetching ' + interval + 'm ');
  let done = 0;
  const series = await mapLimit(symbols, CONCURRENCY, async (sym) => {
    const c = await klines(sym, interval);
    if (++done % 100 === 0) process.stdout.write('.');
    return c;
  });
  process.stdout.write(' done\n');

  const trades = [];
  let symbolsTested = 0, symbolsPositive = 0;
  for (const candles of series) {
    if (!candles || candles.length < TREND + 50) continue;
    const rs = tradeSymbol(candles);
    if (rs.length >= 3) {
      symbolsTested++;
      if (rs.reduce((a, b) => a + b.r, 0) > 0) symbolsPositive++;
    }
    trades.push(...rs);
  }

  trades.sort((a, b) => a.t - b.t);
  const half = Math.floor(trades.length / 2);
  const naive = tStat(trades.map((x) => x.r));
  const clust = clustered(trades);
  const first = clustered(trades.slice(0, half));
  const second = clustered(trades.slice(half));

  const hours = Number(interval) / 60;
  const decisionsPerDay = 24 / hours;

  console.log('=== ' + interval + 'm bars (' + hours + 'h, ' + decisionsPerDay + ' decisions/day) ===');
  if (!naive || !clust) { console.log('  too few trades to judge\n'); continue; }
  console.log('  trades              ' + naive.n + '  across ' + symbolsTested + ' symbols (' +
    symbolsPositive + ' profitable)');
  console.log('  mean R              ' + (naive.mean >= 0 ? '+' : '') + naive.mean.toFixed(4));
  console.log('  naive t             ' + naive.t.toFixed(2) + '   (flattering — assumes trades are independent)');
  console.log('  clustered t         ' + clust.t.toFixed(2) + '   over ' + clust.n + ' trading days  <<< the one that counts');
  if (first && second) {
    console.log('  first half  (clustered)  mean ' + (first.mean >= 0 ? '+' : '') + first.mean.toFixed(4) +
      '  t ' + first.t.toFixed(2));
    console.log('  second half (clustered)  mean ' + (second.mean >= 0 ? '+' : '') + second.mean.toFixed(4) +
      '  t ' + second.t.toFixed(2));
  }
  const verdict = Math.abs(clust.t) < 2 ? 'NO EDGE — indistinguishable from noise'
    : clust.t > 0 ? 'positive, and survives clustering' : 'NEGATIVE — this loses money';
  console.log('  verdict             ' + verdict + '\n');
}

console.log('A clustered |t| under 2 means the result is noise, however many trades it took.');
console.log('Trading more often on a rule with no edge just pays more fees.');
