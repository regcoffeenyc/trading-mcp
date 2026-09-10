import type { Candle } from './bybit/types.js';

/**
 * Indicator helpers. Every function returns an array aligned with the input
 * series, using `null` for leading positions where there is not yet enough data,
 * so callers can index by bar without tracking offsets.
 */

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values, the standard convention.
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    const up = diff > 0 ? diff : 0;
    const down = diff < 0 ? -diff : 0;
    gain = (gain * (period - 1) + up) / period;
    loss = (loss * (period - 1) + down) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function trueRange(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1]!.close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

/** Wilder's ATR — the volatility unit every stop and target in this bot is sized in. */
export function atr(candles: Candle[], period = 14): (number | null)[] {
  const tr = trueRange(candles);
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/** Average Directional Index — trend strength, used to gate trend entries. */
export function adx(candles: Candle[], period = 14): (number | null)[] {
  const len = candles.length;
  const out: (number | null)[] = new Array(len).fill(null);
  if (len < period * 2) return out;

  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  for (let i = 1; i < len; i++) {
    const up = candles[i]!.high - candles[i - 1]!.high;
    const down = candles[i - 1]!.low - candles[i]!.low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const tr = trueRange(candles);

  const smooth = (src: number[]): number[] => {
    const res: number[] = new Array(len).fill(0);
    let acc = src.slice(1, period + 1).reduce((a, b) => a + b, 0);
    res[period] = acc;
    for (let i = period + 1; i < len; i++) {
      acc = acc - acc / period + src[i]!;
      res[i] = acc;
    }
    return res;
  };

  const strP = smooth(plusDM);
  const strM = smooth(minusDM);
  const strTR = smooth(tr);

  const dx: number[] = new Array(len).fill(0);
  for (let i = period; i < len; i++) {
    const t = strTR[i]!;
    if (t === 0) continue;
    const pdi = (strP[i]! / t) * 100;
    const mdi = (strM[i]! / t) * 100;
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100;
  }

  let adxVal = dx.slice(period, period * 2).reduce((a, b) => a + b, 0) / period;
  out[period * 2 - 1] = adxVal;
  for (let i = period * 2; i < len; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]!) / period;
    out[i] = adxVal;
  }
  return out;
}

export interface Bands { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] }

export function bollinger(values: number[], period = 20, mult = 2): Bands {
  const middle = sma(values, period);
  const upper: (number | null)[] = new Array(values.length).fill(null);
  const lower: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const mean = middle[i];
    if (mean === null || mean === undefined) continue;
    const window = values.slice(i - period + 1, i + 1);
    const variance = window.reduce((acc, v) => acc + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { upper, middle, lower };
}

export function highest(values: number[], period: number, endIndex: number): number {
  const start = Math.max(0, endIndex - period + 1);
  return Math.max(...values.slice(start, endIndex + 1));
}

export function lowest(values: number[], period: number, endIndex: number): number {
  const start = Math.max(0, endIndex - period + 1);
  return Math.min(...values.slice(start, endIndex + 1));
}

export const closes = (candles: Candle[]): number[] => candles.map((c) => c.close);
export const highs = (candles: Candle[]): number[] => candles.map((c) => c.high);
export const lows = (candles: Candle[]): number[] => candles.map((c) => c.low);
