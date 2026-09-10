import { BybitRest } from './bybit/rest.js';
import { KlineStream } from './bybit/stream.js';
import { LiveBroker } from './broker/live.js';
import { PaperBroker } from './broker/paper.js';
import type { Broker } from './broker/types.js';
import { createStrategy, type Strategy } from './strategy/index.js';
import { RiskManager } from './risk.js';
import { StateStore, emptyState, rollDay, type BotState } from './state.js';
import { Notifier } from './notify.js';
import { startHealthServer, type HealthSnapshot } from './health.js';
import { log } from './logger.js';
import { floorToStep, roundToStep, sleep, tradingDayKey, usd } from './util.js';
import type { Config } from './config.js';
import type { Candle } from './bybit/types.js';

const TICK_MS = 15_000;

/**
 * The bot's control loop.
 *
 * Two clocks drive it. Closed candles drive strategy decisions and trade
 * management, so entries are never based on a half-formed bar. A 15-second timer
 * drives the account-level work — reconciling closures, refreshing equity,
 * enforcing the daily stop and rolling the trading day — so a position moving
 * against the account trips the daily loss limit within seconds rather than
 * waiting for the next candle.
 */
export class Engine {
  private readonly rest: BybitRest;
  private readonly broker: Broker;
  private readonly stream: KlineStream;
  private readonly strategy: Strategy;
  private readonly risk: RiskManager;
  private readonly store: StateStore;
  private readonly notifier: Notifier;
  private state: BotState;
  private equity = 0;
  private lastBarAt: number | null = null;
  private running = false;
  private busy = false;
  private healthServer: ReturnType<typeof startHealthServer> = null;
  private readonly startedAt = Date.now();

  constructor(private readonly cfg: Config) {
    this.rest = new BybitRest({
      network: cfg.network,
      apiKey: cfg.apiKey,
      apiSecret: cfg.apiSecret,
      recvWindow: cfg.recvWindow,
      host: cfg.restHost,
    });
    this.broker = cfg.mode === 'live'
      ? new LiveBroker(this.rest)
      : new PaperBroker(this.rest, {
          startingEquity: cfg.startingEquity,
          takerFeeRate: cfg.takerFeeRate,
          slippagePct: cfg.slippagePct,
        });
    this.strategy = createStrategy(cfg.strategy);
    this.risk = new RiskManager(cfg);
    this.store = new StateStore(cfg.stateFile);
    this.notifier = new Notifier(cfg.telegramToken, cfg.telegramChatId);
    this.stream = new KlineStream({
      network: cfg.network,
      symbols: cfg.symbols,
      interval: cfg.interval,
      rest: this.rest,
      historyBars: Math.max(300, this.strategy.warmupBars + 50),
    });
    this.state = emptyState(tradingDayKey(Date.now(), cfg.dayResetHourUtc), cfg.startingEquity);
  }

  async start(): Promise<void> {
    log.info('Starting bot', {
      mode: this.cfg.mode,
      network: this.cfg.network,
      strategy: this.strategy.name,
      symbols: this.cfg.symbols.join(','),
      interval: `${this.cfg.interval}m`,
    });

    await this.broker.init(this.cfg.symbols, this.cfg.leverage);
    const balance = await this.broker.balance();
    this.equity = balance.equity;

    const day = tradingDayKey(Date.now(), this.cfg.dayResetHourUtc);
    this.state = this.store.load(day, this.equity);
    if (this.state.day !== day) {
      this.state = rollDay(this.state, day, this.equity);
      log.info('New trading day', { day, startEquity: usd(this.equity) });
    }
    // A restart mid-day must not reset the loss baseline, or the daily stop is
    // trivially bypassed by restarting the process.
    if (this.state.dayStartEquity <= 0) this.state.dayStartEquity = this.equity;
    this.store.save(this.state);

    log.info('Account ready', {
      equity: usd(this.equity),
      dayStartEquity: usd(this.state.dayStartEquity),
      dailyLossLimit: usd(this.cfg.maxDailyLossUsd),
    });

    this.stream.on('bar', (symbol: string, candle: Candle) => {
      this.lastBarAt = Date.now();
      this.broker.onCandle?.(symbol, candle);
      void this.onBar(symbol);
    });
    await this.stream.start();

    this.healthServer = startHealthServer(this.cfg.healthPort, () => this.snapshot());
    await this.notifier.send(
      `🤖 Bot started\nMode: ${this.cfg.mode} (${this.cfg.network})\nStrategy: ${this.strategy.name}\n` +
      `Equity: ${usd(this.equity)}\nDaily loss limit: ${usd(this.cfg.maxDailyLossUsd)}`,
    );

    this.running = true;
    void this.tickLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stream.stop();
    this.healthServer?.close();
    this.store.save(this.state);
    log.info('Bot stopped', { totalTrades: this.state.totalTrades, totalPnl: usd(this.state.totalPnl) });
  }

  // ------------------------------------------------------------- timer clock

  private async tickLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        // A failed tick must never kill a 24/7 process; log and try again.
        log.error('Tick failed', { error: err instanceof Error ? err.stack ?? err.message : String(err) });
      }
      await sleep(TICK_MS);
    }
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.reconcileClosures();
      const balance = await this.broker.balance();
      this.equity = balance.equity;
      await this.maybeRollDay();
      await this.enforceGuards();
      this.store.save(this.state);
    } finally {
      this.busy = false;
    }
  }

  private async maybeRollDay(): Promise<void> {
    const day = tradingDayKey(Date.now(), this.cfg.dayResetHourUtc);
    if (day === this.state.day) return;
    const previousPnl = this.equity - this.state.dayStartEquity;
    log.info('Trading day rolled over', { from: this.state.day, to: day, pnl: usd(previousPnl) });
    await this.notifier.send(
      `📅 Day closed ${this.state.day}\nP&L: ${usd(previousPnl)}\nTrades: ${this.state.tradesToday}\n` +
      `New equity: ${usd(this.equity)}`,
    );
    this.state = rollDay(this.state, day, this.equity);
  }

  /** Applies the daily loss stop, profit target and equity floor. */
  private async enforceGuards(): Promise<void> {
    const verdict = this.risk.checkGuards(this.state, this.equity);
    if (verdict.allowed) return;

    const firstTrip = !this.state.dailyStopHit && !this.state.killSwitch;
    if (this.equity <= this.cfg.equityFloorUsd && !this.state.killSwitch) {
      this.state.killSwitch = true;
      this.state.killSwitchReason = `Equity ${usd(this.equity)} hit the floor.`;
    }
    this.state.dailyStopHit = true;

    if (firstTrip) {
      log.warn('Risk stop triggered', { reason: verdict.reason, equity: usd(this.equity) });
      await this.notifier.send(`🛑 Trading halted\n${verdict.reason}\nEquity: ${usd(this.equity)}`);
    }

    if (verdict.flatten) await this.flattenAll(verdict.reason);
  }

  private async flattenAll(reason: string): Promise<void> {
    const open = await this.broker.positions();
    for (const pos of open) {
      const inst = await this.broker.instrument(pos.symbol);
      await this.broker
        .close(pos.symbol, pos.side, floorToStep(pos.size, inst.qtyStep), reason)
        .catch((err) => log.error('Failed to flatten', { symbol: pos.symbol, error: String(err) }));
    }
  }

  /** Folds exchange-reported closures into streaks, daily P&L and state. */
  private async reconcileClosures(): Promise<void> {
    const closures = await this.broker.pollClosures();
    for (const trade of closures) {
      delete this.state.positions[trade.symbol];
      this.risk.recordOutcome(this.state, trade.pnl);
      this.state.recentTrades.push({
        symbol: trade.symbol,
        side: trade.side,
        qty: trade.qty,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        pnl: trade.pnl,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt,
        reason: trade.reason,
      });
      const emoji = trade.pnl >= 0 ? '✅' : '🔻';
      log.info('Trade closed', { symbol: trade.symbol, pnl: usd(trade.pnl), reason: trade.reason });
      await this.notifier.send(
        `${emoji} ${trade.symbol} ${trade.side} closed (${trade.reason})\nP&L: ${usd(trade.pnl)}\n` +
        `Day: ${usd(this.state.dayRealisedPnl)} | Trades today: ${this.state.tradesToday}`,
      );
    }
  }

  // -------------------------------------------------------------- bar clock

  private async onBar(symbol: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.managePosition(symbol);
      await this.considerEntry(symbol);
      this.store.save(this.state);
    } catch (err) {
      log.error('Bar handling failed', { symbol, error: err instanceof Error ? err.stack ?? err.message : String(err) });
    } finally {
      this.busy = false;
    }
  }

  /** Breakeven stop, ATR trailing stop and the maximum-hold timeout. */
  private async managePosition(symbol: string): Promise<void> {
    const managed = this.state.positions[symbol];
    if (!managed) return;
    const live = (await this.broker.positions()).find((p) => p.symbol === symbol);
    if (!live) return;

    const inst = await this.broker.instrument(symbol);
    const dir = managed.side === 'Buy' ? 1 : -1;
    const moveInR = ((live.markPrice - managed.entryPrice) * dir) / managed.riskPerUnit;

    if (this.cfg.maxHoldMinutes > 0 && Date.now() - managed.openedAt > this.cfg.maxHoldMinutes * 60_000) {
      log.info('Max hold reached, closing', { symbol, heldMinutes: Math.round((Date.now() - managed.openedAt) / 60_000) });
      await this.broker.close(symbol, managed.side, floorToStep(live.size, inst.qtyStep), 'max-hold');
      return;
    }

    if (!managed.movedToBreakeven && this.cfg.breakevenAtR > 0 && moveInR >= this.cfg.breakevenAtR) {
      // Breakeven plus the round-trip fee, so a "scratch" is genuinely flat.
      const feeBuffer = managed.entryPrice * this.cfg.takerFeeRate * 2 * dir;
      const newStop = managed.entryPrice + feeBuffer;
      await this.broker.moveStop(symbol, roundToStep(newStop, inst.tickSize));
      managed.movedToBreakeven = true;
      managed.stopLoss = newStop;
      log.info('Stop moved to breakeven', { symbol, atR: moveInR.toFixed(2) });
    }

    if (this.cfg.trailAtrMult > 0 && moveInR >= this.cfg.breakevenAtR) {
      const trailStop = live.markPrice - dir * managed.atr * this.cfg.trailAtrMult;
      const improves = dir === 1 ? trailStop > managed.stopLoss : trailStop < managed.stopLoss;
      if (improves) {
        await this.broker.moveStop(symbol, roundToStep(trailStop, inst.tickSize));
        managed.stopLoss = trailStop;
        log.debug('Trailing stop advanced', { symbol, stop: trailStop.toFixed(4) });
      }
    }
  }

  private async considerEntry(symbol: string): Promise<void> {
    const candles = this.stream.closedCandles(symbol);
    if (candles.length < this.strategy.warmupBars) {
      log.debug('Warming up', { symbol, have: candles.length, need: this.strategy.warmupBars });
      return;
    }

    const openPositions = (await this.broker.positions()).length;
    const verdict = this.risk.canOpen(this.state, { equity: this.equity, available: 0, openPositions }, symbol);
    if (!verdict.allowed) {
      log.debug('Entry blocked', { symbol, reason: verdict.reason });
      return;
    }

    const signal = this.strategy.evaluate({
      symbol,
      candles,
      stopAtrMult: this.cfg.stopAtrMult,
      takeProfitR: this.cfg.takeProfitR,
      minAtrPct: this.cfg.minAtrPct,
    });
    if (!signal) return;

    // Wide spreads mean the fill will be worse than the signal price; skip.
    const ticker = await this.broker.ticker(symbol);
    if (ticker.spreadPct > this.cfg.maxSpreadPct) {
      log.info('Skipping entry, spread too wide', { symbol, spreadPct: ticker.spreadPct.toFixed(3) });
      return;
    }

    const balance = await this.broker.balance();
    const inst = await this.broker.instrument(symbol);
    const sizing = this.risk.sizePosition({
      equity: balance.equity,
      available: balance.available,
      entryPrice: ticker.lastPrice,
      stopPrice: signal.stopLoss,
      instrument: inst,
    });

    if (!sizing.ok) {
      log.info('Signal skipped, cannot size safely', { symbol, reason: sizing.reason });
      return;
    }

    const qty = floorToStep(sizing.qty, inst.qtyStep);
    if (Number(qty) <= 0) {
      log.info('Signal skipped, size rounds to zero', { symbol });
      return;
    }

    const stopLoss = roundToStep(signal.stopLoss, inst.tickSize);
    const takeProfit = roundToStep(signal.takeProfit, inst.tickSize);

    log.info('Entering position', {
      symbol,
      side: signal.side,
      qty,
      entry: ticker.lastPrice.toFixed(4),
      stopLoss,
      takeProfit,
      riskUsd: usd(sizing.riskUsd),
      reason: signal.reason,
    });

    await this.broker.open({ symbol, side: signal.side, qty, stopLoss, takeProfit });

    this.state.positions[symbol] = {
      symbol,
      side: signal.side,
      qty: Number(qty),
      entryPrice: ticker.lastPrice,
      stopLoss: Number(stopLoss),
      takeProfit: Number(takeProfit),
      riskPerUnit: Math.abs(ticker.lastPrice - Number(stopLoss)),
      atr: signal.atr,
      openedAt: Date.now(),
      movedToBreakeven: false,
      reason: signal.reason,
    };
    this.store.save(this.state);

    await this.notifier.send(
      `📈 ${signal.side} ${symbol}\nQty: ${qty} @ ${ticker.lastPrice.toFixed(4)}\n` +
      `Stop: ${stopLoss} | Target: ${takeProfit}\nRisk: ${usd(sizing.riskUsd)}\n${signal.reason}`,
    );
  }

  private snapshot(): HealthSnapshot {
    return {
      status: this.state.killSwitch || this.state.dailyStopHit ? 'halted' : 'ok',
      mode: this.cfg.mode,
      network: this.cfg.network,
      strategy: this.strategy.name,
      equity: Number(this.equity.toFixed(4)),
      dayStartEquity: Number(this.state.dayStartEquity.toFixed(4)),
      dailyPnl: Number((this.equity - this.state.dayStartEquity).toFixed(4)),
      openPositions: Object.keys(this.state.positions).length,
      tradesToday: this.state.tradesToday,
      dailyStopHit: this.state.dailyStopHit,
      killSwitch: this.state.killSwitch,
      lastBarAt: this.lastBarAt ? new Date(this.lastBarAt).toISOString() : null,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }
}
