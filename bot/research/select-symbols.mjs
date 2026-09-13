// Chooses the symbol list the live bot trades.
//
// Thirty symbols on a 12-hour bar is a signal drought: entries need an EMA
// cross, crosses are rare, and four consecutive closes produced none. The
// answer is not a looser rule — a looser rule was measured and loses — it is
// more of the same rule. Each extra symbol is another independent draw from
// the distribution already measured across the full universe, at identical
// risk per trade.
//
// Two filters, both about whether a backtested fill could really happen:
//
//   turnover   a thin book pays the spread twice and slips on the stop. The
//              floor is 24h turnover, measured live rather than assumed.
//   history    the strategy needs 200 bars for its regime filter plus room
//              for the indicators, so a recent listing cannot be traded yet.
//
// Deliberately NOT filtered on past performance. Picking symbols that did well
// is the survivorship mistake this project already made once, when a hand-picked
// list turned +0.253 R into +0.012 R on honest data.
//
//   node research/select-symbols.mjs
//   MIN_TURNOVER_USD=100000000 MAX_SYMBOLS=80 node research/select-symbols.mjs
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BYBIT_REST_HOST ?? 'https://api.bybit.com';
const DIR = path.resolve('data/research');
const MIN_TURNOVER = Number(process.env.MIN_TURNOVER_USD ?? 50_000_000);
const MAX_SYMBOLS = Number(process.env.MAX_SYMBOLS ?? 120);
const MIN_BARS = Number(process.env.MIN_BARS ?? 260);
const INTERVAL = process.env.INTERVAL ?? '720';

const res = await fetch(`${BASE}/v5/market/tickers?category=linear`);
const json = await res.json();
if (json.retCode !== 0) throw new Error(`${json.retCode} ${json.retMsg}`);

const cacheDir = path.join(DIR, 'klines-' + INTERVAL);
const history = new Map();
if (fs.existsSync(cacheDir)) {
  for (const f of fs.readdirSync(cacheDir)) {
    try {
      const bars = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8')).length;
      history.set(f.replace('.json', ''), bars);
    } catch { /* unreadable cache entry */ }
  }
}

const rows = (json.result.list ?? [])
  .filter((t) => t.symbol.endsWith('USDT'))
  .map((t) => ({
    symbol: t.symbol,
    turnover: Number(t.turnover24h),
    price: Number(t.lastPrice),
    bars: history.get(t.symbol) ?? 0,
  }))
  .filter((t) => Number.isFinite(t.turnover) && t.turnover >= MIN_TURNOVER)
  .filter((t) => t.bars >= MIN_BARS)
  .sort((a, b) => b.turnover - a.turnover)
  .slice(0, MAX_SYMBOLS);

const usd = (n) => '$' + (n / 1e6).toFixed(0) + 'M';
console.log(`${rows.length} symbols clear ${usd(MIN_TURNOVER)} turnover with ${MIN_BARS}+ bars of ${INTERVAL}m history\n`);
console.log('  thinnest 5 that made the cut:');
for (const r of rows.slice(-5)) {
  console.log('    ' + r.symbol.padEnd(14) + usd(r.turnover).padStart(8) + '   ' + r.bars + ' bars');
}
console.log('\nSYMBOLS=' + rows.map((r) => r.symbol).join(','));
