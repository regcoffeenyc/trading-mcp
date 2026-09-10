import { adx, atr, bollinger, closes, ema, rsi } from '../indicators.js';
import type { Signal, Strategy, StrategyContext } from './types.js';

const BB_PERIOD = 20;
const BB_MULT = 2.2;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
const ADX_PERIOD = 14;
const ADX_MAX = 22;
const EMA_TREND = 200;

/**
 * Range mean-reversion.
 *
 * The mirror image of the trend strategy: it fades stretched moves back to the
 * Bollinger midline, and only in a range regime (ADX below 22), because fading a
 * genuine trend is how small accounts die. Entries require price outside the band
 * AND an RSI extreme AND a rejection wick, so a single stretched bar is not enough.
 *
 * Wins often, loses big when wrong — which is exactly why the ATR stop is
 * non-negotiable and sits on the exchange rather than in this process.
 */
export class MeanReversionStrategy implements Strategy {
  readonly name = 'meanrev';
  readonly warmupBars = EMA_TREND + 10;

  evaluate(ctx: StrategyContext): Signal | null {
    const { candles } = ctx;
    if (candles.length < this.warmupBars) return null;

    const price = closes(candles);
    const i = candles.length - 1;
    const bar = candles[i]!;

    const bands = bollinger(price, BB_PERIOD, BB_MULT);
    const rsiSeries = rsi(price, RSI_PERIOD);
    const atrSeries = atr(candles, ATR_PERIOD);
    const adxSeries = adx(candles, ADX_PERIOD);
    const trendSeries = ema(price, EMA_TREND);

    const upper = bands.upper[i];
    const lower = bands.lower[i];
    const middle = bands.middle[i];
    const r = rsiSeries[i];
    const a = atrSeries[i];
    const dx = adxSeries[i];
    const trend = trendSeries[i];
    const close = price[i]!;

    if (upper == null || lower == null || middle == null || r == null || a == null || dx == null || trend == null) {
      return null;
    }

    const atrPct = (a / close) * 100;
    if (atrPct < ctx.minAtrPct) return null;
    // Only fade inside a range. A strong ADX means the "extreme" is a trend leg.
    if (dx > ADX_MAX) return null;

    const range = bar.high - bar.low;
    if (range <= 0) return null;
    const lowerWick = (Math.min(bar.open, bar.close) - bar.low) / range;
    const upperWick = (bar.high - Math.max(bar.open, bar.close)) / range;

    // Long: pierced the lower band, oversold, and buyers rejected the low.
    if (bar.low < lower && r < 30 && lowerWick > 0.3) {
      const stopLoss = Math.min(bar.low, close - a * ctx.stopAtrMult);
      const target = Math.max(middle, close + (close - stopLoss) * ctx.takeProfitR);
      return {
        side: 'Buy',
        price: close,
        stopLoss,
        takeProfit: target,
        atr: a,
        reason: `Lower band pierce, RSI ${r.toFixed(1)}, ADX ${dx.toFixed(1)}, wick ${(lowerWick * 100).toFixed(0)}%`,
      };
    }

    if (bar.high > upper && r > 70 && upperWick > 0.3) {
      const stopLoss = Math.max(bar.high, close + a * ctx.stopAtrMult);
      const target = Math.min(middle, close - (stopLoss - close) * ctx.takeProfitR);
      return {
        side: 'Sell',
        price: close,
        stopLoss,
        takeProfit: target,
        atr: a,
        reason: `Upper band pierce, RSI ${r.toFixed(1)}, ADX ${dx.toFixed(1)}, wick ${(upperWick * 100).toFixed(0)}%`,
      };
    }

    return null;
  }
}
