import type { LogLevel } from './logger.js';

export type Mode = 'live' | 'paper';
export type StrategyName = 'trend' | 'meanrev';

export interface Config {
  /** live = real orders on Bybit. paper = simulated fills against the live feed. */
  mode: Mode;
  /** Point the REST/WS clients at testnet or demo trading instead of mainnet. */
  network: 'mainnet' | 'testnet' | 'demo';
  apiKey: string;
  apiSecret: string;
  recvWindow: string;
  /** Optional REST host override for regions where api.bybit.com is blocked. */
  restHost?: string;

  symbols: string[];
  interval: string;
  strategy: StrategyName;
  leverage: number;

  /** Risk limits — the part that decides whether the account survives. */
  startingEquity: number;
  riskPerTradePct: number;
  maxDailyLossUsd: number;
  maxDailyProfitUsd: number;
  equityFloorUsd: number;
  maxConcurrentPositions: number;
  maxTradesPerDay: number;
  maxConsecutiveLosses: number;
  cooldownMinutes: number;
  dayResetHourUtc: number;
  flattenOnDailyStop: boolean;

  /** Trade management. */
  stopAtrMult: number;
  takeProfitR: number;
  breakevenAtR: number;
  trailAtrMult: number;
  maxSpreadPct: number;
  minAtrPct: number;
  maxHoldMinutes: number;
  takerFeeRate: number;
  slippagePct: number;

  stateFile: string;
  logLevel: LogLevel;
  logFile?: string;
  healthPort: number;
  telegramToken?: string;
  telegramChatId?: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} must be a number, got "${raw}"`);
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = (process.env[name] ?? fallback) as T;
  if (!allowed.includes(raw)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${raw}"`);
  }
  return raw;
}

export function loadConfig(): Config {
  const mode = oneOf('MODE', ['live', 'paper'] as const, 'paper');
  const network = oneOf('NETWORK', ['mainnet', 'testnet', 'demo'] as const, 'testnet');

  // Paper mode reads public market data only, so keys stay optional there.
  const needsKeys = mode === 'live';
  const cfg: Config = {
    mode,
    network,
    apiKey: needsKeys ? req('BYBIT_API_KEY') : process.env.BYBIT_API_KEY ?? '',
    apiSecret: needsKeys ? req('BYBIT_API_SECRET') : process.env.BYBIT_API_SECRET ?? '',
    recvWindow: process.env.BYBIT_RECV_WINDOW ?? '5000',
    restHost: process.env.BYBIT_REST_HOST || undefined,

    symbols: (process.env.SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    // 60m by default: every 15m configuration backtested negative (FINDINGS.md).
    interval: process.env.INTERVAL ?? '60',
    strategy: oneOf('STRATEGY', ['trend', 'meanrev'] as const, 'trend'),
    leverage: num('LEVERAGE', 5),

    startingEquity: num('STARTING_EQUITY_USD', 50),
    riskPerTradePct: num('RISK_PER_TRADE_PCT', 3),
    maxDailyLossUsd: num('MAX_DAILY_LOSS_USD', 15),
    maxDailyProfitUsd: num('MAX_DAILY_PROFIT_USD', 0),
    equityFloorUsd: num('EQUITY_FLOOR_USD', 20),
    maxConcurrentPositions: num('MAX_CONCURRENT_POSITIONS', 1),
    maxTradesPerDay: num('MAX_TRADES_PER_DAY', 8),
    maxConsecutiveLosses: num('MAX_CONSECUTIVE_LOSSES', 3),
    cooldownMinutes: num('COOLDOWN_MINUTES', 60),
    dayResetHourUtc: num('DAY_RESET_HOUR_UTC', 0),
    flattenOnDailyStop: bool('FLATTEN_ON_DAILY_STOP', true),

    stopAtrMult: num('STOP_ATR_MULT', 1.8),
    takeProfitR: num('TAKE_PROFIT_R', 2),
    breakevenAtR: num('BREAKEVEN_AT_R', 1),
    trailAtrMult: num('TRAIL_ATR_MULT', 0),
    maxSpreadPct: num('MAX_SPREAD_PCT', 0.06),
    minAtrPct: num('MIN_ATR_PCT', 0.15),
    maxHoldMinutes: num('MAX_HOLD_MINUTES', 720),
    takerFeeRate: num('TAKER_FEE_RATE', 0.00055),
    slippagePct: num('SLIPPAGE_PCT', 0.02),

    stateFile: process.env.STATE_FILE ?? './data/state.json',
    logLevel: oneOf('LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
    logFile: process.env.LOG_FILE || undefined,
    healthPort: num('HEALTH_PORT', 0),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
  };

  validate(cfg);
  return cfg;
}

/**
 * Rejects configurations that are internally inconsistent or that would blow the
 * account up on the first bad day. These are hard errors, not warnings: a bot that
 * starts with a broken risk config is worse than one that refuses to start.
 */
export function validate(cfg: Config): void {
  const errors: string[] = [];

  if (cfg.symbols.length === 0) errors.push('SYMBOLS is empty.');
  if (cfg.leverage < 1 || cfg.leverage > 25) errors.push('LEVERAGE must be between 1 and 25.');
  if (cfg.riskPerTradePct <= 0 || cfg.riskPerTradePct > 10) {
    errors.push('RISK_PER_TRADE_PCT must be in (0, 10]. Above 10% of equity per trade, a normal losing streak ends the account.');
  }
  if (cfg.maxDailyLossUsd <= 0) errors.push('MAX_DAILY_LOSS_USD must be positive.');
  if (cfg.equityFloorUsd < 0) errors.push('EQUITY_FLOOR_USD cannot be negative.');
  if (cfg.maxConcurrentPositions < 1) errors.push('MAX_CONCURRENT_POSITIONS must be at least 1.');
  if (cfg.stopAtrMult <= 0) errors.push('STOP_ATR_MULT must be positive.');
  if (cfg.takeProfitR <= 0) errors.push('TAKE_PROFIT_R must be positive.');
  if (cfg.dayResetHourUtc < 0 || cfg.dayResetHourUtc > 23) errors.push('DAY_RESET_HOUR_UTC must be 0-23.');

  const riskUsd = (cfg.startingEquity * cfg.riskPerTradePct) / 100;
  if (riskUsd > cfg.maxDailyLossUsd) {
    errors.push(
      `A single trade risks ${riskUsd.toFixed(2)} USD but MAX_DAILY_LOSS_USD is ${cfg.maxDailyLossUsd}. ` +
      'One loss would already breach the daily limit — lower RISK_PER_TRADE_PCT.',
    );
  }
  if (cfg.equityFloorUsd >= cfg.startingEquity) {
    errors.push('EQUITY_FLOOR_USD must be below STARTING_EQUITY_USD, otherwise the bot halts immediately.');
  }

  if (errors.length) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
}

/** Non-fatal risk observations surfaced at startup so the operator sees them. */
export function riskWarnings(cfg: Config): string[] {
  const warnings: string[] = [];
  const dailyLossPct = (cfg.maxDailyLossUsd / cfg.startingEquity) * 100;
  if (dailyLossPct > 10) {
    warnings.push(
      `MAX_DAILY_LOSS_USD is ${dailyLossPct.toFixed(0)}% of starting equity. ` +
      'Professional risk desks stop at 1-3% a day; at this size a few bad days compound into a blown account.',
    );
  }
  const lossesToLimit = Math.floor(cfg.maxDailyLossUsd / ((cfg.startingEquity * cfg.riskPerTradePct) / 100));
  if (lossesToLimit < 3) {
    warnings.push(`Only ${lossesToLimit} losing trades reach the daily stop. Consider a lower RISK_PER_TRADE_PCT.`);
  }
  if (cfg.mode === 'live' && cfg.network === 'mainnet') {
    warnings.push('Running LIVE on mainnet with real funds.');
  }
  if (cfg.leverage > 10) {
    warnings.push(`Leverage ${cfg.leverage}x: liquidation sits close to entry and can trigger before your stop.`);
  }
  return warnings;
}
