import { adx, atr, closes, ema, rsi } from '../indicators.js';
import type { Signal, Strategy, StrategyContext } from './types.js';

const EMA_FAST = 21;
const EMA_SLOW = 55;
const EMA_TREND = 200;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
const ADX_PERIOD = 14;
const ADX_MIN = 20;

/**
 * Trend-following breakout.
 *
 * Takes a position only when three things agree: the higher-timeframe bias (price
 * vs EMA200), the medium-term trend (EMA21/EMA55 cross), and trend strength
 * (ADX above 20). RSI is used as a veto against entering into an exhausted move,
 * and a minimum-ATR filter keeps the bot out of dead ranges where fees dominate.
 *
 * The edge such a system has, when it has one, comes from cutting losers at 1 ATR
 * and letting winners run to a multiple of that — not from a high win rate.
 * Expect roughly 35-45% winners.
 */
export class TrendStrategy implements Strategy {
  readonly name = 'trend';
  readonly warmupBars = EMA_TREND + 10;

  evaluate(ctx: StrategyContext): Signal | null {
    const { candles } = ctx;
    if (candles.length < this.warmupBars) return null;

    const price = closes(candles);
    const i = candles.length - 1;
    const prev = i - 1;

    const fast = ema(price, EMA_FAST);
    const slow = ema(price, EMA_SLOW);
    const trend = ema(price, EMA_TREND);
    const rsiSeries = rsi(price, RSI_PERIOD);
    const atrSeries = atr(candles, ATR_PERIOD);
    const adxSeries = adx(candles, ADX_PERIOD);

    const f = fast[i], fPrev = fast[prev];
    const s = slow[i], sPrev = slow[prev];
    const t = trend[i];
    const r = rsiSeries[i];
    const a = atrSeries[i];
    const dx = adxSeries[i];
    const close = price[i]!;

    if (f == null || fPrev == null || s == null || sPrev == null || t == null || r == null || a == null || dx == null) {
      return null;
    }

    // Volatility floor: below it, the stop distance is so tight that fees and
    // spread eat the whole expected move.
    const atrPct = (a / close) * 100;
    if (atrPct < ctx.minAtrPct) return null;
    if (dx < ADX_MIN) return null;

    const crossedUp = fPrev <= sPrev && f > s;
    const crossedDown = fPrev >= sPrev && f < s;

    if (crossedUp && close > t && r < 72) {
      const stopLoss = close - a * ctx.stopAtrMult;
      return {
        side: 'Buy',
        price: close,
        stopLoss,
        takeProfit: close + (close - stopLoss) * ctx.takeProfitR,
        atr: a,
        reason: `EMA${EMA_FAST}>EMA${EMA_SLOW} above EMA${EMA_TREND}, ADX ${dx.toFixed(1)}, RSI ${r.toFixed(1)}`,
      };
    }

    if (crossedDown && close < t && r > 28) {
      const stopLoss = close + a * ctx.stopAtrMult;
      return {
        side: 'Sell',
        price: close,
        stopLoss,
        takeProfit: close - (stopLoss - close) * ctx.takeProfitR,
        atr: a,
        reason: `EMA${EMA_FAST}<EMA${EMA_SLOW} below EMA${EMA_TREND}, ADX ${dx.toFixed(1)}, RSI ${r.toFixed(1)}`,
      };
    }

    return null;
  }
}
