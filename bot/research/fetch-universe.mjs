// Downloads the full Bybit linear USDT perpetual universe and caches daily
// candles + funding history under data/research, so the studies that follow can
// run repeatedly without re-hitting the API.
//
// Using every listed contract rather than a hand-picked list removes the
// selection bias of choosing coins from memory — which selects for winners.
// Run from the bot/ directory.
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BYBIT_REST_HOST ?? 'https://api.bybit.com';
const OUT = path.resolve('data/research');
const PROGRESS = path.join(OUT, 'progress.txt');

fs.mkdirSync(path.join(OUT, 'klines'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'funding'), { recursive: true });

const log = (msg) => { fs.appendFileSync(PROGRESS, msg + '\n'); console.log(msg); };

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

async function fetchUniverse() {
  const out = [];
  let cursor;
  do {
    const r = await get('/v5/market/instruments-info', {
      category: 'linear', limit: 1000, ...(cursor ? { cursor } : {}),
    });
    for (const i of r.list ?? []) {
      if (i.quoteCoin !== 'USDT' || i.contractType !== 'LinearPerpetual') continue;
      out.push({
        symbol: i.symbol,
        launchTime: Number(i.launchTime),
        status: i.status,
        tickSize: i.priceFilter.tickSize,
        qtyStep: i.lotSizeFilter.qtyStep,
        minOrderQty: i.lotSizeFilter.minOrderQty,
        minNotionalValue: Number(i.lotSizeFilter.minNotionalValue ?? 5),
      });
    }
    cursor = r.nextPageCursor;
  } while (cursor);
  return out;
}

async function fetchDaily(symbol) {
  const all = [];
  let end;
  for (let page = 0; page < 4; page++) {
    const r = await get('/v5/market/kline', {
      category: 'linear', symbol, interval: 'D', limit: 1000,
      ...(end ? { end: String(end) } : {}),
    });
    const list = r.list ?? [];
    if (list.length === 0) break;
    all.push(...list);
    end = Number(list[list.length - 1][0]) - 1;
    if (list.length < 1000) break;
  }
  const seen = new Set();
  return all
    .map((r) => ({ t: Number(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], q: +r[6] }))
    .filter((c) => (seen.has(c.t) ? false : (seen.add(c.t), true)))
    .sort((a, b) => a.t - b.t);
}

async function fetchFunding(symbol) {
  const all = [];
  let end = Date.now();
  for (let page = 0; page < 6; page++) {
    const r = await get('/v5/market/funding/history', {
      category: 'linear', symbol, limit: 200, endTime: String(end),
    });
    const list = r.list ?? [];
    if (list.length === 0) break;
    all.push(...list.map((f) => ({ t: Number(f.fundingRateTimestamp), r: Number(f.fundingRate) })));
    end = Math.min(...list.map((f) => Number(f.fundingRateTimestamp))) - 1;
    if (list.length < 200) break;
  }
  const seen = new Set();
  return all.filter((f) => (seen.has(f.t) ? false : (seen.add(f.t), true))).sort((a, b) => a.t - b.t);
}

fs.writeFileSync(PROGRESS, '');
const universe = await fetchUniverse();
fs.writeFileSync(path.join(OUT, 'universe.json'), JSON.stringify(universe, null, 2));
log(`universe: ${universe.length} USDT perpetuals`);

let done = 0;
for (const inst of universe) {
  const kFile = path.join(OUT, 'klines', inst.symbol + '.json');
  const fFile = path.join(OUT, 'funding', inst.symbol + '.json');
  try {
    if (!fs.existsSync(kFile)) fs.writeFileSync(kFile, JSON.stringify(await fetchDaily(inst.symbol)));
    if (!fs.existsSync(fFile)) fs.writeFileSync(fFile, JSON.stringify(await fetchFunding(inst.symbol)));
  } catch (err) {
    log(`FAILED ${inst.symbol}: ${String(err)}`);
  }
  if (++done % 25 === 0) log(`fetched ${done}/${universe.length}`);
}
log(`DONE ${done}/${universe.length}`);
