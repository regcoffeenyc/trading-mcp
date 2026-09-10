/** Small helpers shared across the bot. No dependencies, no side effects. */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Number of decimals implied by a Bybit step string such as "0.001". */
export function decimalsOf(step: string): number {
  const dot = step.indexOf('.');
  if (dot === -1) return 0;
  return step.length - dot - 1;
}

/**
 * Rounds `value` DOWN to a multiple of `step`, formatted with the step's precision.
 * Bybit rejects quantities/prices that are not exact multiples of the instrument
 * step, and floating point makes naive `Math.floor(v / step) * step` produce
 * artefacts like 0.30000000000000004, so we round through integers.
 */
export function floorToStep(value: number, step: string): string {
  const decimals = decimalsOf(step);
  const stepNum = Number(step);
  if (!(stepNum > 0)) return value.toFixed(decimals);
  const scale = 10 ** decimals;
  const stepUnits = Math.round(stepNum * scale);
  const units = Math.floor(snapToInteger(value * scale) / stepUnits);
  return ((units * stepUnits) / scale).toFixed(decimals);
}

/**
 * Floors need the input in integer units, but 0.3 * 10 is 2.9999999999999996 in
 * binary floating point and would floor to 2. Snap only when the value is within
 * float noise of an integer — a genuine 1.9 must still floor to 1.
 */
function snapToInteger(value: number): number {
  const nearest = Math.round(value);
  const tolerance = 1e-9 * Math.max(1, Math.abs(value));
  return Math.abs(value - nearest) < tolerance ? nearest : value;
}

/** Rounds `value` to the nearest multiple of `step` (used for prices, not sizes). */
export function roundToStep(value: number, step: string): string {
  const decimals = decimalsOf(step);
  const stepNum = Number(step);
  if (!(stepNum > 0)) return value.toFixed(decimals);
  const scale = 10 ** decimals;
  const stepUnits = Math.round(stepNum * scale);
  const units = Math.round(snapToInteger(value * scale) / stepUnits);
  return ((units * stepUnits) / scale).toFixed(decimals);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function usd(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export class RetryableError extends Error {}

/**
 * Retries `fn` with exponential backoff and jitter. Only retries transient
 * failures — a rejected order stays rejected, but a timeout is worth another go.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; label?: string; onRetry?: (err: unknown, attempt: number) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isTransient(err)) break;
      opts.onRetry?.(err, attempt);
      const delay = baseMs * 2 ** (attempt - 1);
      await sleep(delay + Math.random() * delay * 0.3);
    }
  }
  throw lastErr;
}

/** Network blips, timeouts, rate limits and Bybit 5xx/10016 are worth retrying. */
export function isTransient(err: unknown): boolean {
  if (err instanceof RetryableError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|HTTP 5\d\d|HTTP 429|retCode 10016|retCode 10006|retCode 10002/i.test(msg);
}

/** UTC-day key (YYYY-MM-DD) shifted by `resetHourUtc`, used to bucket daily P&L. */
export function tradingDayKey(now: number, resetHourUtc: number): string {
  const shifted = new Date(now - resetHourUtc * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}
