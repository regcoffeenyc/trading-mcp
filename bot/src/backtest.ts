import { BybitRest } from './bybit/rest.js';
import { fetchOkxHistory } from './data/okx.js';
import { createStrategy, strategyWindow } from './strategy/index.js';
import { RiskManager } from './risk.js';
import { loadEnvFile } from './env.js';
import { isMainModule } from './cli.js';
import { loadConfig, type Config } from './config.js';
import { configureLogger, log } from './logger.js';
import { emptyState } from './state.js';
import { tradingDayKey, usd } from './util.js';
import type { Candle, Instrument, Side } from './bybit/types.js';

/**
 * Historical simulation of exactly the rules the live engine runs: same strategy,
 * same ATR sizing, same daily loss stop, same fees and slippage.
 *
 * Signals are taken from a bar's close and filled at the NEXT bar's open, so the
 * backtest cannot see data the live bot would not have had. When a bar's range
 * covers both stop and target, the stop is assumed to fill first.
 */

interface OpenTrade {
  side: Side;
  qty: number;
  entry: number;
  stop: number;
  target: number;
  risk: number;
  atr: number;
  openedAt: number;
  movedToBreakeven: boolean;
}

interface ClosedTrade {
  symbol: string;
  side: Side;
  entry: number;
  exit: number;
  pnl: number;
  rMultiple: number;
  bars: number;
  openedAt: number;
  closedAt: number;
  reason: string;
}

export interface BacktestResult {
  symbol: string;
  bars: number;
  from: string;
  to: string;
  days: number;
  startEquity: number;
  endEquity: number;
  trades: ClosedTrade[];
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  expectancyR: number;
  maxDrawdownPct: number;
  maxDrawdownUsd: number;
  dailyStopDays: number;
  totalReturnPct: number;
  monthlyReturnPct: number;
  avgTradesPerDay: number;
  feesPaid: number;
}

export type DataSource = 'bybit' | 'okx';

/**
 * Bybit's own linear-perp filters. Used only when the instrument endpoint is
 * unreachable (geo-block), so a proxy-data backtest still sizes against the
 * constraint that actually matters on a small account: the $5 minimum order.
 */
const BYBIT_LINEAR_DEFAULTS: Omit<Instrument, 'symbol'> = {
  tickSize: '0.0001',
  // Deliberately fine, so lot granularity does not become a fake constraint and
  // silently exclude a symbol. On a $50 account the constraint that actually
  // binds is Bybit's $5 minimum order value, which is uniform across its linear
  // perpetuals and is modelled exactly.
  qtyStep: '0.000001',
  minOrderQty: '0.000001',
  maxOrderQty: '1000000',
  minNotionalValue: 5,
  maxLeverage: 25,
};

export async function runBacktest(
  cfg: Config, symbol: string, bars: number, source: DataSource = 'bybit',
): Promise<BacktestResult & { source: DataSource }> {
  if (source === 'okx') {
    const candles = await fetchOkxHistory(symbol, cfg.interval, bars);
    return { ...simulate(cfg, symbol, candles, { symbol, ...BYBIT_LINEAR_DEFAULTS }), source };
  }
  // Testnet history is thin and unrepresentative, so backtests always read
  // mainnet public data regardless of where the bot itself is pointed.
  const rest = new BybitRest({
    network: cfg.network === 'testnet' ? 'mainnet' : cfg.network,
    apiKey: '', apiSecret: '', recvWindow: cfg.recvWindow, host: cfg.restHost,
  });
  const candles = await rest.klineHistory(symbol, cfg.interval, bars);
  const instrument = await rest.instrument(symbol);
  return { ...simulate(cfg, symbol, candles, instrument), source };
}

export function simulate(cfg: Config, symbol: string, candles: Candle[], instrument: Instrument): BacktestResult {
  const strategy = createStrategy(cfg.strategy);
  const risk = new RiskManager(cfg);
  const window = strategyWindow(strategy.warmupBars);

  let equity = cfg.startingEquity;
  let peak = equity;
  let maxDdUsd = 0;
  let maxDdPct = 0;
  let feesPaid = 0;

  let open: OpenTrade | null = null;
  let openedIndex = 0;
  const closed: ClosedTrade[] = [];

  let day = tradingDayKey(candles[0]?.time ?? Date.now(), cfg.dayResetHourUtc);
  let dayStartEquity = equity;
  let dayTrades = 0;
  let dayStopped = false;
  const dailyStopDays = new Set<string>();
  const state = emptyState(day, equity);

  const feeOn = (notional: number) => notional * cfg.takerFeeRate;
  const slip = (price: number, side: Side, entering: boolean) => {
    const dir = entering ? (side === 'Buy' ? 1 : -1) : (side === 'Buy' ? -1 : 1);
    return price * (1 + dir * (cfg.slippagePct / 100));
  };

  const closeTrade = (t: OpenTrade, rawExit: number, bar: Candle, index: number, reason: string) => {
    const exit = slip(rawExit, t.side, false);
    const dir = t.side === 'Buy' ? 1 : -1;
    const gross = (exit - t.entry) * t.qty * dir;
    const exitFee = feeOn(t.qty * exit);
    feesPaid += exitFee;
    const pnl = gross - exitFee;
    equity += pnl;
    closed.push({
      symbol,
      side: t.side,
      entry: t.entry,
      exit,
      pnl,
      rMultiple: t.risk > 0 ? pnl / t.risk : 0,
      bars: index - openedIndex,
      openedAt: t.openedAt,
      closedAt: bar.time,
      reason,
    });
    risk.recordOutcome(state, pnl, bar.time);
    dayTrades += 1;
    if (equity > peak) peak = equity;
    const ddUsd = peak - equity;
    if (ddUsd > maxDdUsd) { maxDdUsd = ddUsd; maxDdPct = (ddUsd / peak) * 100; }
  };

  for (let i = strategy.warmupBars; i < candles.length - 1; i++) {
    const bar = candles[i]!;
    const next = candles[i + 1]!;

    // --- day roll -----------------------------------------------------------
    const barDay = tradingDayKey(bar.time, cfg.dayResetHourUtc);
    if (barDay !== day) {
      day = barDay;
      dayStartEquity = equity;
      dayTrades = 0;
      dayStopped = false;
      state.tradesToday = 0;
      state.cooldownUntil = 0;
    }

    // --- manage the open position on this bar -------------------------------
    if (open) {
      const dir = open.side === 'Buy' ? 1 : -1;
      const hitStop = open.side === 'Buy' ? bar.low <= open.stop : bar.high >= open.stop;
      const hitTarget = open.side === 'Buy' ? bar.high >= open.target : bar.low <= open.target;

      if (hitStop) {
        closeTrade(open, open.stop, bar, i, open.movedToBreakeven ? 'breakeven' : 'stop');
        open = null;
      } else if (hitTarget) {
        closeTrade(open, open.target, bar, i, 'target');
        open = null;
      } else {
        const moveInR = ((bar.close - open.entry) * dir) / (open.risk / open.qty);
        if (!open.movedToBreakeven && cfg.breakevenAtR > 0 && moveInR >= cfg.breakevenAtR) {
          open.stop = open.entry + open.entry * cfg.takerFeeRate * 2 * dir;
          open.movedToBreakeven = true;
        }
        if (cfg.trailAtrMult > 0 && moveInR >= cfg.breakevenAtR) {
          const trail = bar.close - dir * open.atr * cfg.trailAtrMult;
          if (dir === 1 ? trail > open.stop : trail < open.stop) open.stop = trail;
        }
        const heldMs = bar.time - open.openedAt;
        if (cfg.maxHoldMinutes > 0 && heldMs > cfg.maxHoldMinutes * 60_000) {
          closeTrade(open, bar.close, bar, i, 'max-hold');
          open = null;
        }
      }
    }

    // --- daily risk stop ----------------------------------------------------
    const dailyLoss = dayStartEquity - equity;
    if (!dayStopped && dailyLoss >= cfg.maxDailyLossUsd) {
      dayStopped = true;
      dailyStopDays.add(day);
      if (open && cfg.flattenOnDailyStop) {
        closeTrade(open, bar.close, bar, i, 'daily-stop');
        open = null;
      }
    }
    if (equity <= cfg.equityFloorUsd) {
      log.warn('Equity floor breached, simulation halted', { bar: new Date(bar.time).toISOString() });
      break;
    }

    // --- entries ------------------------------------------------------------
    if (open || dayStopped) continue;
    if (dayTrades >= cfg.maxTradesPerDay) continue;
    if (bar.time < state.cooldownUntil) continue;

    const signal = strategy.evaluate({
      symbol,
      // Exactly the history the live bot would hold at this bar.
      candles: candles.slice(Math.max(0, i + 1 - window), i + 1),
      stopAtrMult: cfg.stopAtrMult,
      takeProfitR: cfg.takeProfitR,
      minAtrPct: cfg.minAtrPct,
    });
    if (!signal) continue;

    // Fill at the next bar's open — the earliest price the live bot could get.
    const entry = slip(next.open, signal.side, true);
    const sizing = risk.sizePosition({
      equity,
      available: equity,
      entryPrice: entry,
      stopPrice: signal.stopLoss,
      instrument,
    });
    if (!sizing.ok) continue;

    const remainingBudget = cfg.maxDailyLossUsd - dailyLoss;
    if (sizing.riskUsd > remainingBudget) continue;

    const entryFee = feeOn(sizing.qty * entry);
    feesPaid += entryFee;
    equity -= entryFee;

    open = {
      side: signal.side,
      qty: sizing.qty,
      entry,
      stop: signal.stopLoss,
      target: signal.takeProfit,
      risk: sizing.riskUsd,
      atr: signal.atr,
      openedAt: next.time,
      movedToBreakeven: false,
    };
    openedIndex = i + 1;
  }

  const first = candles[strategy.warmupBars];
  const last = candles[candles.length - 1];
  const spanMs = (last?.time ?? 0) - (first?.time ?? 0);
  const days = Math.max(1, spanMs / 86_400_000);

  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalReturnPct = ((equity - cfg.startingEquity) / cfg.startingEquity) * 100;

  return {
    symbol,
    bars: candles.length,
    from: first ? new Date(first.time).toISOString().slice(0, 10) : '-',
    to: last ? new Date(last.time).toISOString().slice(0, 10) : '-',
    days: Math.round(days),
    startEquity: cfg.startingEquity,
    endEquity: equity,
    trades: closed,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancyR: closed.length ? closed.reduce((s, t) => s + t.rMultiple, 0) / closed.length : 0,
    maxDrawdownPct: maxDdPct,
    maxDrawdownUsd: maxDdUsd,
    dailyStopDays: dailyStopDays.size,
    totalReturnPct,
    // Compounded to a 30-day month, which is how the monthly target must be read.
    monthlyReturnPct: (Math.pow(1 + totalReturnPct / 100, 30 / days) - 1) * 100,
    avgTradesPerDay: closed.length / days,
    feesPaid,
  };
}

export function formatResult(r: BacktestResult, cfg: Config): string {
  const targetMonthly = 250;
  const lines = [
    '',
    `── ${r.symbol} · ${cfg.strategy} · ${cfg.interval}m ────────────────────────`,
    `Period            ${r.from} → ${r.to}  (${r.days} days, ${r.bars} bars)`,
    `Equity            ${usd(r.startEquity)} → ${usd(r.endEquity)}   (${r.totalReturnPct >= 0 ? '+' : ''}${r.totalReturnPct.toFixed(1)}%)`,
    `Trades            ${r.trades.length}  (${r.avgTradesPerDay.toFixed(2)}/day)`,
    `Win rate          ${r.winRate.toFixed(1)}%   (${r.wins}W / ${r.losses}L)`,
    `Profit factor     ${r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)}`,
    `Expectancy        ${r.expectancyR >= 0 ? '+' : ''}${r.expectancyR.toFixed(3)} R per trade`,
    `Max drawdown      ${usd(r.maxDrawdownUsd)}  (${r.maxDrawdownPct.toFixed(1)}%)`,
    `Fees paid         ${usd(r.feesPaid)}`,
    `Daily stop hit    ${r.dailyStopDays} day(s)`,
    `Monthly rate      ${r.monthlyReturnPct >= 0 ? '+' : ''}${r.monthlyReturnPct.toFixed(1)}% compounded`,
  ];

  const monthlyUsd = (r.monthlyReturnPct / 100) * cfg.startingEquity;
  lines.push(
    `Vs ${usd(targetMonthly)} target  ${usd(monthlyUsd)}/month at this rate on ${usd(cfg.startingEquity)} ` +
    `— ${monthlyUsd >= targetMonthly ? 'meets' : 'falls short of'} the goal`,
  );
  return lines.join('\n');
}

// ------------------------------------------------------------------ CLI entry

async function main(): Promise<void> {
  loadEnvFile(process.env.ENV_FILE ?? '.env');
  const cfg = loadConfig();
  configureLogger({ level: cfg.logLevel });
  const bars = Number(process.env.BACKTEST_BARS ?? 5000);
  const symbols = (process.env.BACKTEST_SYMBOLS ?? cfg.symbols.join(',')).split(',').map((s) => s.trim());
  const requested = (process.env.BACKTEST_SOURCE ?? 'bybit') as DataSource;

  console.log(`Backtesting ${cfg.strategy} on ${symbols.join(', ')} — ${bars} bars of ${cfg.interval}m data`);
  console.log(
    `Risk: ${cfg.riskPerTradePct}% per trade, daily stop ${usd(cfg.maxDailyLossUsd)}, ` +
    `fees ${(cfg.takerFeeRate * 100).toFixed(3)}%, slippage ${cfg.slippagePct}%`,
  );

  const results: BacktestResult[] = [];
  let source = requested;
  for (const symbol of symbols) {
    try {
      const result = await runBacktest(cfg, symbol, bars, source);
      results.push(result);
      console.log(formatResult(result, cfg));
    } catch (err) {
      // A geo-block or outage on Bybit should not end the run; OKX lists the
      // same perpetuals and answers the same question about strategy edge.
      if (source === 'bybit' && /restricted|blocked|403|CloudFront|fetch failed|HTTP 4/i.test(String(err))) {
        console.error(`\nBybit REST is unreachable from here (${String(err).slice(0, 100)}).`);
        console.error('Falling back to OKX data for the same perpetuals.\n');
        source = 'okx';
        try {
          const result = await runBacktest(cfg, symbol, bars, source);
          results.push(result);
          console.log(formatResult(result, cfg));
          continue;
        } catch (fallbackErr) {
          console.error(`OKX fallback also failed for ${symbol}: ${String(fallbackErr)}`);
          continue;
        }
      }
      console.error(`Backtest failed for ${symbol}: ${String(err)}`);
    }
  }
  if (source === 'okx') {
    console.log(
      '\nNOTE: these numbers come from OKX candles for the same USDT perpetuals, ' +
      'because Bybit REST was unreachable. Prices track Bybit within a few basis points, ' +
      'so the read on strategy edge is sound — but re-run with BACKTEST_SOURCE=bybit ' +
      'from a machine that can reach Bybit before trusting the exact figures.',
    );
  }

  if (results.length > 1) {
    const avgMonthly = results.reduce((s, r) => s + r.monthlyReturnPct, 0) / results.length;
    const totalTrades = results.reduce((s, r) => s + r.trades.length, 0);
    console.log('\n── Portfolio view ───────────────────────────────────────────');
    console.log(`Symbols tested    ${results.length}`);
    console.log(`Total trades      ${totalTrades}`);
    console.log(`Mean monthly rate ${avgMonthly >= 0 ? '+' : ''}${avgMonthly.toFixed(1)}%`);
    console.log(`On ${usd(cfg.startingEquity)} that is ${usd((avgMonthly / 100) * cfg.startingEquity)} per month.`);
  }

  console.log(
    '\nPast results do not predict future results. Backtests overstate live performance ' +
    'because they cannot model outages, funding costs, or a regime the data never contained.',
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
