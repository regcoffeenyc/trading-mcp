import fs from 'node:fs';
import { BybitRest } from './bybit/rest.js';
import { loadEnvFile } from './env.js';
import { loadConfig, riskWarnings } from './config.js';
import { configureLogger } from './logger.js';
import { RiskManager } from './risk.js';
import { usd } from './util.js';

/**
 * Symbols a previous run watched the exchange refuse with 110126, so the report
 * can say which of the gated contracts is known-blocked rather than only which
 * ones might be. Missing or unreadable state simply means nothing is known yet.
 */
function loadBlockedSymbols(file: string): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { blockedSymbols?: Record<string, number> };
    return new Set(Object.keys(parsed.blockedSymbols ?? {}));
  } catch {
    return new Set();
  }
}

/**
 * Pre-flight check. Verifies connectivity, credentials, symbol tradability and
 * that the risk configuration can actually place a trade on this account size —
 * all before a single order is sent.
 */
async function main(): Promise<void> {
  loadEnvFile(process.env.ENV_FILE ?? '.env');
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

    await check('API key can trade', async () => {
      const info = await rest.apiKeyInfo();
      const detail =
        `scopes [${info.contractScopes.join(', ') || 'none'}], ` +
        `readOnly=${info.readOnly}, ip=${info.ipRestriction}, expires ${info.expiresAt ?? 'never'}`;
      if (!info.canTrade) {
        throw new Error(
          `${detail} — this key CANNOT place orders. ` +
          'Create a key at bybit.com with Contract Orders+Positions and read-only OFF.',
        );
      }
      return detail;
    });

    await check('Account is Unified', async () => {
      // Read the account endpoint rather than the API key's `unified` flag,
      // which reports 0 on UTA 2.0 and would condemn a working account.
      const acct = await rest.accountInfo();
      const detail = `${acct.description} (status ${acct.unifiedMarginStatus}), margin ${acct.marginMode}`;
      if (!acct.isUnified) {
        throw new Error(`${detail} — this bot trades the Unified wallet. Upgrade at bybit.com.`);
      }
      return detail;
    });

  } else {
    results.push(['API credentials', true, 'not set (paper mode only)']);
  }

  const risk = new RiskManager(cfg);
  let equity = cfg.startingEquity;
  try {
    if (cfg.apiKey) equity = (await rest.walletBalance()).equity || cfg.startingEquity;
  } catch { /* fall back to the configured starting equity */ }

  // Contract classes Bybit gates behind an agreement, collected as the symbols
  // are checked and reported once at the end.
  const gated: Array<{ symbol: string; type: string; name: string }> = [];

  for (const symbol of cfg.symbols) {
    await check(`Symbol ${symbol}`, async () => {
      const inst = await rest.instrument(symbol);
      if (inst.symbolType) gated.push({ symbol, type: inst.symbolType, name: inst.fullName });
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
      const classNote = inst.symbolType ? ` | ${inst.symbolType} contract, agreement may be required` : '';
      return `price ${ticker.lastPrice}, spread ${ticker.spreadPct.toFixed(3)}%, ` +
        `min notional ${usd(inst.minNotionalValue)}, max lev ${inst.maxLeverage}x | ${sizingNote}${classNote}`;
    });
  }

  console.log('\nPre-flight check');
  console.log('='.repeat(72));
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} ${detail}`);
  }

  if (gated.length > 0) {
    // The gap this closes: on 2026-09-15 the first live signal this bot ever
    // produced was a short on NVDAUSDT, and Bybit refused the order with 110126
    // - "you must sign the required agreement before trading this contract".
    // Pre-flight had reported NVDAUSDT as PASS, because price, candles and
    // sizing were all fine; nothing asked whether the account was allowed to
    // trade it. There is no way to confirm the permission short of sending a
    // fillable order - price and quantity are validated before the agreement is
    // - so the honest report is the class, and which member of it has already
    // been refused.
    const blocked = loadBlockedSymbols(cfg.stateFile);
    console.log('\nContracts that may need an agreement');
    console.log('='.repeat(72));
    console.log('  Bybit gates some contract classes behind a one-off agreement signed at');
    console.log('  bybit.com. The order is refused with 110126 at entry time, so a signal is');
    console.log('  already lost by the time it shows up. Sign for them, or drop them from SYMBOLS.');
    console.log('');
    const byType = new Map<string, Array<{ symbol: string; name: string }>>();
    for (const g of gated) {
      if (!byType.has(g.type)) byType.set(g.type, []);
      byType.get(g.type)!.push({ symbol: g.symbol, name: g.name });
    }
    for (const [type, members] of [...byType].sort()) {
      console.log(`  ${type} (${members.length})`);
      for (const m of members) {
        const mark = blocked.has(m.symbol) ? '  REFUSED 110126 on this account' : '';
        console.log(`    ${m.symbol.padEnd(16)}${m.name}${mark}`);
      }
    }
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
