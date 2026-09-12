import { Engine } from './engine.js';
import path from 'node:path';
import { loadEnvFile } from './env.js';
import { InstanceLock } from './lock.js';
import { loadConfig, riskWarnings } from './config.js';
import { configureLogger, log } from './logger.js';
import { usd } from './util.js';

async function main(): Promise<void> {
  loadEnvFile(process.env.ENV_FILE ?? '.env');
  const cfg = loadConfig();
  configureLogger({ level: cfg.logLevel, file: cfg.logFile });

  const warnings = riskWarnings(cfg);
  for (const warning of warnings) log.warn(warning);

  if (cfg.mode === 'live' && cfg.network === 'mainnet') {
    log.warn(
      `LIVE TRADING on mainnet. Real money at risk. Daily loss limit ${usd(cfg.maxDailyLossUsd)}, ` +
      `equity floor ${usd(cfg.equityFloorUsd)}. Starting in 10 seconds — Ctrl-C to abort.`,
    );
    await new Promise((r) => setTimeout(r, 10_000));
  }

  // Refuse to start alongside another instance: two bots on one account
  // double every position and halve every risk limit in effect.
  const lock = new InstanceLock(path.join(path.dirname(cfg.stateFile), 'bot.lock'));
  const owner = lock.tryAcquire();
  if (owner !== null) {
    log.error(
      `Another bot is already running on this account (PID ${owner}). Refusing to start a second one — ` +
      'two instances would open duplicate positions and both would size against the same limits. ' +
      `Stop it first, or delete the lock at ${path.join(path.dirname(cfg.stateFile), 'bot.lock')} if it is stale.`,
    );
    process.exit(1);
  }

  const engine = new Engine(cfg);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down`);
    // Open positions keep their exchange-side stop and target, so leaving them
    // is safe; closing them on every restart would churn fees instead.
    await engine.stop();
    lock.release();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // A stray rejection must not silently kill a process that holds open risk.
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
  });
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', { error: err.stack ?? err.message });
  });

  await engine.start();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
