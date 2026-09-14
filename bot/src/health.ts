import http from 'node:http';
import { log } from './logger.js';

export interface HealthSnapshot {
  status: 'ok' | 'halted';
  mode: string;
  network: string;
  strategy: string;
  equity: number;
  dayStartEquity: number;
  dailyPnl: number;
  openPositions: number;
  /** True once every symbol holds enough closed candles for the strategy to act. */
  warmedUp: boolean;
  /** Closed candles buffered per symbol, against the number required. */
  bars: Record<string, number>;
  barsRequired: number;
  tradesToday: number;
  dailyStopHit: boolean;
  killSwitch: boolean;
  lastBarAt: string | null;
  uptimeSeconds: number;
}

/** Requests are cheap; anything slower than this means something is wrong. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Shrinks the per-symbol bar counts to what a reader actually needs.
 *
 * At 87 symbols the full map is most of the payload and none of the meaning:
 * the question is "is everything warm", and if not, "what isn't". The detail is
 * still available with ?verbose=1 for when that question matters.
 */
function summarise(data: HealthSnapshot, verbose: boolean): Record<string, unknown> {
  const entries = Object.entries(data.bars);
  const cold = entries.filter(([, n]) => n < data.barsRequired);
  const { bars, ...rest } = data;
  return {
    ...rest,
    symbols: entries.length,
    symbolsWarm: entries.length - cold.length,
    ...(cold.length > 0 ? { notWarm: Object.fromEntries(cold) } : {}),
    ...(verbose ? { bars } : {}),
  };
}

/**
 * Minimal health endpoint so an uptime monitor (or systemd, or a phone) can tell
 * whether a 24/7 process is alive and still trading. Returns 503 once halted,
 * which is what makes it useful as an alert source.
 *
 * Every path through the handler ends in a response. That sounds like it should
 * go without saying, and it is the whole point of the try/catch: this process
 * installs an uncaughtException handler so that a stray error cannot kill a bot
 * holding open risk, and that policy turns a throw inside a request handler into
 * a socket that is never answered. The caller then waits for its own timeout
 * against a process that is alive, listening, and healthy in every other
 * respect. Observed exactly that way — port open, log current, state file
 * advancing, and curl hanging. A 500 is a worse answer than a snapshot and an
 * enormously better one than silence.
 *
 * Bound to loopback by default: the payload carries equity, open positions and
 * P&L, which has no business being readable by anything else on a café network.
 */
export function startHealthServer(
  port: number,
  snapshot: () => HealthSnapshot,
  host = process.env.HEALTH_HOST ?? '127.0.0.1',
): http.Server | null {
  if (!port) return null;
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/health' && url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const data = snapshot();
      const body = JSON.stringify(summarise(data, url.searchParams.has('verbose')), null, 2);
      res.writeHead(data.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (err) {
      // Reading the snapshot failed. Say so, loudly and quickly, rather than
      // leaving the monitor to guess from a connection that never answers.
      log.error('Health snapshot failed', { error: err instanceof Error ? err.stack ?? err.message : String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: String(err) }));
      } else {
        res.destroy();
      }
    }
  });

  // A client that opens a socket and stops talking must not hold one forever.
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  server.on('clientError', (_err, socket) => socket.destroy());

  server.listen(port, host, () => log.info('Health endpoint listening', { host, port }));
  server.on('error', (err) => log.warn('Health server error', { error: String(err) }));
  return server;
}
