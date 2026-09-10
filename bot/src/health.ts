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

/**
 * Minimal health endpoint so an uptime monitor (or systemd, or a phone) can tell
 * whether a 24/7 process is alive and still trading. Returns 503 once halted,
 * which is what makes it useful as an alert source.
 */
export function startHealthServer(port: number, snapshot: () => HealthSnapshot): http.Server | null {
  if (!port) return null;
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const data = snapshot();
      res.writeHead(data.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data, null, 2));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, () => log.info('Health endpoint listening', { port }));
  server.on('error', (err) => log.warn('Health server error', { error: String(err) }));
  return server;
}
