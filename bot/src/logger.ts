import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = 'info';
let logStream: fs.WriteStream | null = null;

export function configureLogger(opts: { level: LogLevel; file?: string }): void {
  minLevel = opts.level;
  if (opts.file) {
    fs.mkdirSync(path.dirname(opts.file), { recursive: true });
    logStream = fs.createWriteStream(opts.file, { flags: 'a' });
  }
}

function write(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const ts = new Date().toISOString();
  const suffix = extra && Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
  const line = `${ts} [${level.toUpperCase()}] ${msg}${suffix}`;
  // stderr for warn/error so `bot > out.log` keeps alerts visible on the console.
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
  logStream?.write(`${line}\n`);
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => write('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => write('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => write('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write('error', msg, extra),
};

/** Never let a credential reach the log file. */
export function redact(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
