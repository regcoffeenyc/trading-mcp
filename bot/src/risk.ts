import type { Config } from './config.js';
import { usd } from './util.js';
import type { BotState } from './state.js';
import type { Instrument } from './bybit/types.js';

/** Discriminated so callers must handle the refusal case explicitly. */
export type SizingResult =
  | { ok: true; qty: number; notional: number; riskUsd: number }
  | { ok: false; reason: string };

export interface RiskVerdict {
  allowed: boolean;
  reason: string;
  /** True when the bot should also close whatever is already open. */
  flatten?: boolean;
  /**
   * Set when the only thing stopping trading is that the account holds no
   * money yet. This is a hold, not a halt: no kill switch, no daily stop, and
   * trading begins by itself once a deposit lands.
   */
  waitingForFunding?: boolean;
}

export interface AccountSnapshot {
  equity: number;
  available: number;
  openPositions: number;
}

/**
 * Every rule that can stop a trade, in one place.
 *
 * Ordered most-severe first so the reported reason is the most important one.
 * `canOpen` is consulted before every entry; `checkGuards` runs on each loop tick
 * and can force a flatten.
 */
export class RiskManager {
  constructor(private readonly cfg: Config) {}

  /** Mark-to-market loss for the day, including open positions. Positive = losing. */
  dailyLoss(state: BotState, equity: number): number {
    return state.dayStartEquity - equity;
  }

  dailyProfit(state: BotState, equity: number): number {
    return equity - state.dayStartEquity;
  }

  /**
   * Account-level guards. These run continuously, not just at entry time, so a
   * position moving against the bot trips the daily stop while it is still open.
   */
  checkGuards(state: BotState, equity: number): RiskVerdict {
    if (state.killSwitch) {
      return { allowed: false, reason: `Kill switch active: ${state.killSwitchReason}`, flatten: true };
    }

    if (equity <= this.cfg.equityFloorUsd) {
      // An account that has never held capital is not in drawdown — it is
      // simply not funded yet. Latching the kill switch there would mean the
      // operator deposits money into a bot that has already refused to trade.
      if (!state.everFunded) {
        return {
          allowed: false,
          reason: `Waiting for funding: equity ${usd(equity)} is below the ${usd(this.cfg.equityFloorUsd)} floor. ` +
            'Trading starts on its own once the account is funded.',
          flatten: false,
          waitingForFunding: true,
        };
      }
      return {
        allowed: false,
        reason: `Equity ${usd(equity)} at or below floor ${usd(this.cfg.equityFloorUsd)}. Halting permanently.`,
        flatten: true,
      };
    }

    const loss = this.dailyLoss(state, equity);
    if (loss >= this.cfg.maxDailyLossUsd) {
      return {
        allowed: false,
        reason: `Daily loss ${usd(loss)} reached the ${usd(this.cfg.maxDailyLossUsd)} limit. No more trading today.`,
        flatten: this.cfg.flattenOnDailyStop,
      };
    }

    if (this.cfg.maxDailyProfitUsd > 0) {
      const profit = this.dailyProfit(state, equity);
      if (profit >= this.cfg.maxDailyProfitUsd) {
        return {
          allowed: false,
          reason: `Daily profit target ${usd(profit)} reached. Stopping for the day.`,
          flatten: this.cfg.flattenOnDailyStop,
        };
      }
    }

    return { allowed: true, reason: 'ok' };
  }

  /** Entry-level gates, checked after `checkGuards` passes. */
  canOpen(state: BotState, account: AccountSnapshot, symbol: string, now = Date.now()): RiskVerdict {
    const guard = this.checkGuards(state, account.equity);
    if (!guard.allowed) return guard;

    if (state.dailyStopHit) {
      return { allowed: false, reason: 'Daily stop already hit; waiting for the next trading day.' };
    }
    if (state.positions[symbol]) {
      return { allowed: false, reason: `Already holding ${symbol}.` };
    }
    if (account.openPositions >= this.cfg.maxConcurrentPositions) {
      return { allowed: false, reason: `At the ${this.cfg.maxConcurrentPositions}-position limit.` };
    }
    if (state.tradesToday >= this.cfg.maxTradesPerDay) {
      return { allowed: false, reason: `Hit the ${this.cfg.maxTradesPerDay}-trade daily cap.` };
    }
    if (now < state.cooldownUntil) {
      const mins = Math.ceil((state.cooldownUntil - now) / 60_000);
      return { allowed: false, reason: `Cooling down after ${state.consecutiveLosses} losses (${mins} min left).` };
    }

    // Refuse to open a trade whose worst case would breach the daily limit.
    const riskUsd = this.riskBudgetUsd(account.equity);
    const remaining = this.cfg.maxDailyLossUsd - this.dailyLoss(state, account.equity);
    if (riskUsd > remaining) {
      return {
        allowed: false,
        reason: `Trade risks ${usd(riskUsd)} but only ${usd(remaining)} of the daily loss budget is left.`,
      };
    }

    return { allowed: true, reason: 'ok' };
  }

  /** Dollars to put at risk on the next trade. */
  riskBudgetUsd(equity: number): number {
    return (equity * this.cfg.riskPerTradePct) / 100;
  }

  /**
   * Converts a risk budget and a stop distance into a position size.
   *
   * Returns why it refused rather than silently sizing to zero — with a $50
   * account the exchange minimum is frequently the binding constraint, and the
   * operator needs to know that is what happened.
   */
  sizePosition(args: {
    equity: number;
    available: number;
    entryPrice: number;
    stopPrice: number;
    instrument: Instrument;
  }): SizingResult {
    const { equity, available, entryPrice, stopPrice, instrument } = args;
    const stopDistance = Math.abs(entryPrice - stopPrice);
    if (stopDistance <= 0) return { ok: false, reason: 'Stop distance is zero.' };

    const riskUsd = this.riskBudgetUsd(equity);
    let qty = riskUsd / stopDistance;

    // Never let the notional exceed what the configured leverage allows.
    const maxNotional = available * this.cfg.leverage;
    if (qty * entryPrice > maxNotional) {
      qty = maxNotional / entryPrice;
    }

    const minQty = Number(instrument.minOrderQty);
    const minNotionalQty = instrument.minNotionalValue / entryPrice;
    const requiredQty = Math.max(minQty, minNotionalQty);

    if (qty < requiredQty) {
      // Bumping to the minimum would risk more than the budget allows. Refuse.
      const riskAtMin = requiredQty * stopDistance;
      if (riskAtMin > riskUsd * 1.25) {
        return {
          ok: false,
          reason:
            `Exchange minimum for ${instrument.symbol} is ${requiredQty.toFixed(6)} ` +
            `(risking ${usd(riskAtMin)}) but the budget is ${usd(riskUsd)}. ` +
            'Use a lower-priced symbol or accept a wider risk per trade.',
        };
      }
      qty = requiredQty;
    }

    const maxQty = Number(instrument.maxOrderQty);
    if (qty > maxQty) qty = maxQty;

    const notional = qty * entryPrice;
    if (notional > maxNotional) {
      return {
        ok: false,
        reason: `Required size needs ${usd(notional)} notional but only ${usd(maxNotional)} is available at ${this.cfg.leverage}x.`,
      };
    }

    return { ok: true, qty, notional, riskUsd: qty * stopDistance };
  }

  /** Called after every close so streak-based cooldowns stay current. */
  recordOutcome(state: BotState, pnl: number, now = Date.now()): void {
    state.tradesToday += 1;
    state.totalTrades += 1;
    state.totalPnl += pnl;
    state.dayRealisedPnl += pnl;
    if (pnl < 0) {
      state.consecutiveLosses += 1;
      if (state.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
        state.cooldownUntil = now + this.cfg.cooldownMinutes * 60_000;
        state.consecutiveLosses = 0;
      }
    } else {
      state.consecutiveLosses = 0;
    }
  }
}
