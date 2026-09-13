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
//   continuous Bybit lists tokenized equity perpetuals - AAPLUSDT, SOXLUSDT,
//              MRVLUSDT - alongside the crypto ones, and AAPLUSDT is currently
//              the eighth most traded contract on the venue, so this is not a
//              corner case. They stop trading at the closing bell and reopen
//              somewhere else, and a stop sitting inside that gap is not a stop:
//              price never touches it, it opens through it. The whole risk model
//              assumes a market that always prints. Detected from the candles
//              themselves rather than from a list of tickers to maintain.
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
// A crypto perpetual prints every interval forever; 1% slack covers an outage.
const MAX_GAP_RATIO = Number(process.env.MAX_GAP_RATIO ?? 0.01);

const res = await fetch(`${BASE}/v5/market/tickers?category=linear`);
const json = await res.json();
if (json.retCode !== 0) throw new Error(`${json.retCode} ${json.retMsg}`);

const cacheDir = path.join(DIR, 'klines-' + INTERVAL);
const history = new Map();
const gapRatio = new Map();
const stepMs = Number(INTERVAL) * 60_000;
if (fs.existsSync(cacheDir)) {
  for (const f of fs.readdirSync(cacheDir)) {
    try {
      const bars = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8'));
      history.set(f.replace('.json', ''), bars.length);
      // A continuously traded contract steps by exactly one interval every bar.
      // Anything that closes for the weekend leaves a run of missing bars, and
      // the share of oversized steps separates the two cleanly — no ticker list
      // to keep up to date as the venue adds names.
      let gaps = 0;
      for (let i = 1; i < bars.length; i += 1) {
        if (bars[i].t - bars[i - 1].t > stepMs * 1.5) gaps += 1;
      }
      gapRatio.set(f.replace('.json', ''), bars.length > 1 ? gaps / (bars.length - 1) : 1);
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
    gaps: gapRatio.get(t.symbol) ?? 1,
  }))
  .filter((t) => Number.isFinite(t.turnover) && t.turnover >= MIN_TURNOVER)
  .filter((t) => t.bars >= MIN_BARS)
  .filter((t) => t.gaps <= MAX_GAP_RATIO)
  .sort((a, b) => b.turnover - a.turnover)
  .slice(0, MAX_SYMBOLS);

const usd = (n) => '$' + (n / 1e6).toFixed(0) + 'M';

// Which filter is doing the cutting? A list far shorter than expected is
// usually a bad filter rather than a thin market, and the two are easy to
// confuse when only the survivors are printed.
{
  const usdt = (json.result.list ?? []).filter((t) => t.symbol.endsWith('USDT'));
  const liquid = usdt.filter((t) => Number(t.turnover24h) >= MIN_TURNOVER);
  const cached = usdt.filter((t) => (history.get(t.symbol) ?? 0) >= MIN_BARS);
  console.log('universe                ' + usdt.length + ' USDT perpetuals');
  console.log('  clear turnover floor  ' + liquid.length);
  console.log('  have enough history   ' + cached.length + '  (of ' + history.size + ' cached)');
  const withHistory = liquid.filter((t) => (history.get(t.symbol) ?? 0) >= MIN_BARS);
  console.log('  trade continuously    ' + withHistory.filter((t) => (gapRatio.get(t.symbol) ?? 1) <= MAX_GAP_RATIO).length);
  const discontinuous = withHistory.filter((t) => (gapRatio.get(t.symbol) ?? 1) > MAX_GAP_RATIO);
  if (discontinuous.length > 0) {
    console.log('  dropped, they close and gap: ' +
      discontinuous.slice(0, 10).map((t) => t.symbol + '(' +
        ((gapRatio.get(t.symbol) ?? 1) * 100).toFixed(0) + '% gaps)').join(' '));
  }
  const lost = liquid.filter((t) => (history.get(t.symbol) ?? 0) < MIN_BARS);
  if (lost.length > 0) {
    console.log('  liquid but short of history: ' +
      lost.slice(0, 8).map((t) => t.symbol + '(' + (history.get(t.symbol) ?? 0) + ')').join(' '));
  }
  console.log('');
}
console.log(`${rows.length} symbols clear ${usd(MIN_TURNOVER)} turnover with ${MIN_BARS}+ bars of ${INTERVAL}m history\n`);
console.log('  thinnest 5 that made the cut:');
for (const r of rows.slice(-5)) {
  console.log('    ' + r.symbol.padEnd(14) + usd(r.turnover).padStart(8) + '   ' + r.bars + ' bars');
}
console.log('\nSYMBOLS=' + rows.map((r) => r.symbol).join(','));
