import { BybitRest } from './bybit/rest.js';
import { loadConfig, riskWarnings } from './config.js';
import { configureLogger } from './logger.js';
import { RiskManager } from './risk.js';
import { usd } from './util.js';

/**
 * Pre-flight check. Verifies connectivity, credentials, symbol tradability and
 * that the risk configuration can actually place a trade on this account size —
 * all before a single order is sent.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  configureLogger({ level: 'info' });
  const rest = new BybitRest({
    network: cfg.network, apiKey: cfg.apiKey, apiSecret: cfg.apiSecret,
    recvWindow: cfg.recvWindow, host: cfg.restHost,
  });
  const results: Array<[string, boolean, string]> = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    try { results.push([name, true, await fn()]); }
    catch (err) { results.push([name, false, err instanceof Error ? err.message : String(err)]); }
  };

  await check('Bybit reachable', async () => {
    const offset = await rest.syncClock();
    return `clock offset ${offset}ms`;
  });

  if (cfg.apiKey && cfg.apiSecret) {
    await check('API credentials', async () => {
      const balance = await rest.walletBalance();
      return `equity ${usd(balance.equity)}, available ${usd(balance.available)}`;
    });
    await check('Positions readable', async () => `${(await rest.positions()).length} open`);
  } else {
    results.push(['API credentials', true, 'not set (paper mode only)']);
  }

  const risk = new RiskManager(cfg);
  let equity = cfg.startingEquity;
  try {
    if (cfg.apiKey) equity = (await rest.walletBalance()).equity || cfg.startingEquity;
  } catch { /* fall back to the configured starting equity */ }

  for (const symbol of cfg.symbols) {
    await check(`Symbol ${symbol}`, async () => {
      const inst = await rest.instrument(symbol);
      const ticker = await rest.ticker(symbol);
      const candles = await rest.klines(symbol, cfg.interval, 5);
      if (candles.length === 0) throw new Error('no candle data');

      // Can a trade even be sized here, given the account and a typical stop?
      const assumedStopPct = 1.0;
      const stopPrice = ticker.lastPrice * (1 - assumedStopPct / 100);
      const sizing = risk.sizePosition({
        equity, available: equity, entryPrice: ticker.lastPrice, stopPrice, instrument: inst,
      });
      const sizingNote = sizing.ok
        ? `tradable: qty ${sizing.qty.toFixed(6)}, notional ${usd(sizing.notional)}, risk ${usd(sizing.riskUsd)}`
        : `NOT TRADABLE at this account size — ${sizing.reason}`;
      return `price ${ticker.lastPrice}, spread ${ticker.spreadPct.toFixed(3)}%, ` +
        `min notional ${usd(inst.minNotionalValue)}, max lev ${inst.maxLeverage}x | ${sizingNote}`;
    });
  }

  console.log('\nPre-flight check');
  console.log('='.repeat(72));
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} ${detail}`);
  }

  const warnings = riskWarnings(cfg);
  if (warnings.length) {
    console.log('\nRisk warnings');
    console.log('='.repeat(72));
    for (const w of warnings) console.log(`  !  ${w}`);
  }

  console.log('\nConfiguration');
  console.log('='.repeat(72));
  console.log(`  Mode              ${cfg.mode} on ${cfg.network}`);
  console.log(`  Strategy          ${cfg.strategy} @ ${cfg.interval}m`);
  console.log(`  Risk per trade    ${cfg.riskPerTradePct}%  (${usd((equity * cfg.riskPerTradePct) / 100)} at current equity)`);
  console.log(`  Daily loss stop   ${usd(cfg.maxDailyLossUsd)}`);
  console.log(`  Equity floor      ${usd(cfg.equityFloorUsd)}`);
  console.log(`  Max positions     ${cfg.maxConcurrentPositions}`);
  console.log(`  Leverage          ${cfg.leverage}x`);

  const failed = results.filter(([, ok]) => !ok).length;
  if (failed > 0) {
    console.log(`\n${failed} check(s) failed. Fix them before running live.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
