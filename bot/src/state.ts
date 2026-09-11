import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

export interface TradeRecord {
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  openedAt: number;
  closedAt: number;
  reason: string;
}

export interface ManagedPosition {
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** Risk in price terms at entry — one R. Drives breakeven and trailing logic. */
  riskPerUnit: number;
  atr: number;
  openedAt: number;
  movedToBreakeven: boolean;
  reason: string;
}

export interface BotState {
  /** Trading-day key (YYYY-MM-DD, shifted by DAY_RESET_HOUR_UTC). */
  day: string;
  /** Equity at the start of the trading day — the baseline for the daily loss stop. */
  dayStartEquity: number;
  dayRealisedPnl: number;
  tradesToday: number;
  consecutiveLosses: number;
  /** Epoch ms until which new entries are blocked (loss-streak cooldown). */
  cooldownUntil: number;
  /** Set when the daily stop trips; cleared at the next day roll. */
  dailyStopHit: boolean;
  /** Permanent halt (equity floor breach). Requires operator action to clear. */
  killSwitch: boolean;
  killSwitchReason: string;
  /**
   * True once equity has been seen above the floor. Distinguishes an account
   * that has never been funded from one that has been traded down to the floor
   * — the first should wait, the second must stop permanently.
   */
  everFunded: boolean;
  positions: Record<string, ManagedPosition>;
  recentTrades: TradeRecord[];
  totalTrades: number;
  totalPnl: number;
  startedAt: number;
  /**
   * Simulated cash balance, paper mode only. A paper run is meant to last weeks
   * and will be restarted — for a reboot, a config tweak, a crash — so the
   * equity curve has to survive that or the experiment measures nothing.
   */
  paperEquity?: number;
}

const MAX_RECENT_TRADES = 200;

export function emptyState(day: string, equity: number): BotState {
  return {
    day,
    dayStartEquity: equity,
    dayRealisedPnl: 0,
    tradesToday: 0,
    consecutiveLosses: 0,
    cooldownUntil: 0,
    dailyStopHit: false,
    killSwitch: false,
    killSwitchReason: '',
    everFunded: equity > 0,
    positions: {},
    recentTrades: [],
    totalTrades: 0,
    totalPnl: 0,
    startedAt: Date.now(),
  };
}

/**
 * JSON state on disk. Crash-safe via write-to-temp-then-rename, because a
 * truncated state file would lose the daily loss counter — the one number the
 * bot must never forget across a restart.
 */
export class StateStore {
  constructor(private readonly file: string) {}

  load(day: string, equity: number): BotState {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as BotState;
      return { ...emptyState(day, equity), ...parsed };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('State file unreadable, starting fresh', { error: String(err), file: this.file });
      }
      return emptyState(day, equity);
    }
  }

  save(state: BotState): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    if (state.recentTrades.length > MAX_RECENT_TRADES) {
      state.recentTrades = state.recentTrades.slice(-MAX_RECENT_TRADES);
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

/** Resets the per-day counters, keeping lifetime totals and the kill switch. */
export function rollDay(state: BotState, day: string, equity: number): BotState {
  return {
    ...state,
    day,
    dayStartEquity: equity,
    dayRealisedPnl: 0,
    tradesToday: 0,
    dailyStopHit: false,
    cooldownUntil: 0,
  };
}
