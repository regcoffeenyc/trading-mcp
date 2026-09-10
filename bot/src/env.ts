import fs from 'node:fs';
import path from 'node:path';

/**
 * Loads `.env` into process.env if present.
 *
 * Every entry point calls this, so `npm start`, `node dist/index.js`, a Windows
 * scheduled task and a systemd unit all behave identically. Real environment
 * variables always win, which is what lets Docker and CI override the file.
 */
export function loadEnvFile(file = '.env'): 'loaded' | 'absent' {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) return 'absent';

  // Snapshot what was set before, so the file cannot clobber a real env var.
  const preset = new Set(Object.keys(process.env));
  const before = new Map(Object.entries(process.env));

  process.loadEnvFile(resolved);

  for (const key of preset) {
    const original = before.get(key);
    if (original !== undefined) process.env[key] = original;
  }
  return 'loaded';
}
