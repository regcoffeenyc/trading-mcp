import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { redact } from './logger.js';

/**
 * First-run setup: locates the note holding the Bybit API credentials, writes a
 * .env from the template, and reports what it did without ever printing the
 * secret. Run with `npm run setup`.
 */

const KEY_HINTS = ['api key', 'apikey', 'api_key', 'key'];
const SECRET_HINTS = ['api secret', 'apisecret', 'api_secret', 'secret'];

/** Bybit keys are ~18 chars and secrets ~36; both are URL-safe alphanumerics. */
const TOKEN = /[A-Za-z0-9_-]{15,80}/g;

export interface Credentials { apiKey: string; apiSecret: string }

/** Candidate paths for a note called "Api" on the desktop, across platforms. */
export function candidateNotePaths(home = os.homedir()): string[] {
  const desktops = [
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, 'OneDrive - Personal', 'Desktop'),
    home,
  ];
  const names = ['Api', 'api', 'API', 'Api.txt', 'api.txt', 'API.txt', 'Api.md', 'api.md',
                 'Api.rtf', 'api.rtf', 'Api.note', 'api.json', 'Api.json'];
  const out: string[] = [];
  for (const dir of desktops) for (const name of names) out.push(path.join(dir, name));
  return out;
}

export function findNote(explicit?: string): string | null {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  for (const candidate of candidateNotePaths()) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* unreadable candidate, keep looking */ }
  }
  return null;
}

/**
 * Pulls the key and secret out of free-form note text.
 *
 * Handles `KEY=value`, `API Key: value`, and a bare pair of tokens on their own
 * lines. Deliberately conservative: when it cannot tell which token is which it
 * returns nothing rather than guessing and writing a broken .env.
 */
export function parseCredentials(text: string): Credentials | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const labelled = (hints: string[], exclude: string[] = []): string | null => {
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (exclude.some((e) => lower.includes(e))) continue;
      if (!hints.some((h) => lower.includes(h))) continue;
      // Take the value after the first separator, then the first token in it.
      const value = line.split(/[:=]/).slice(1).join(':').trim();
      const match = (value || line).match(TOKEN);
      if (match && match.length > 0) {
        const candidate = match[match.length - 1]!;
        if (!hints.some((h) => candidate.toLowerCase() === h.replace(/[^a-z]/g, ''))) return candidate;
      }
    }
    return null;
  };

  // "secret" contains no "key", but a line labelled "api key" must not be read
  // as the secret, so the secret lookup excludes key-labelled lines and vice versa.
  const apiSecret = labelled(SECRET_HINTS);
  const apiKey = labelled(KEY_HINTS, ['secret']);
  if (apiKey && apiSecret && apiKey !== apiSecret) return { apiKey, apiSecret };

  // Fall back to two bare tokens: Bybit's secret is always the longer one.
  const bare = lines.filter((l) => /^[A-Za-z0-9_-]{15,80}$/.test(l));
  if (bare.length === 2) {
    const [a, b] = bare as [string, string];
    return a.length >= b.length ? { apiKey: b, apiSecret: a } : { apiKey: a, apiSecret: b };
  }
  return null;
}

/** Rewrites the template, substituting values and leaving comments intact. */
export function renderEnv(template: string, values: Record<string, string>): string {
  const applied = new Set<string>();
  const out = template.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) return line;
    const key = match[1]!;
    if (!(key in values)) return line;
    applied.add(key);
    return `${key}=${values[key]}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!applied.has(key)) out.push(`${key}=${value}`);
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  const root = process.cwd();
  const envPath = path.join(root, '.env');
  const templatePath = path.join(root, '.env.example');

  console.log('Bybit bot setup');
  console.log('='.repeat(72));

  if (fs.existsSync(envPath)) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('.env already exists. Overwrite it? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y') { console.log('Left the existing .env untouched.'); return; }
  }

  const notePath = findNote(process.env.API_NOTE_PATH);
  if (!notePath) {
    console.error('\nCould not find a note called "Api" on your Desktop.');
    console.error('Looked in:');
    for (const c of candidateNotePaths().slice(0, 8)) console.error(`  ${c}`);
    console.error('\nRun again pointing at the file directly, e.g.:');
    console.error('  API_NOTE_PATH="C:\\\\Users\\\\you\\\\Desktop\\\\Api.txt" npm run setup');
    process.exit(1);
  }
  console.log(`Found credentials note: ${notePath}`);

  const creds = parseCredentials(fs.readFileSync(notePath, 'utf8'));
  if (!creds) {
    console.error('\nCould not read an API key and secret from that note.');
    console.error('Make sure it contains two lines like:');
    console.error('  API_KEY=xxxxxxxxxxxxxxxxxx');
    console.error('  API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    process.exit(1);
  }
  // Only ever show a redacted form; the secret must not reach a terminal log.
  console.log(`Parsed API key:    ${redact(creds.apiKey)}`);
  console.log(`Parsed API secret: ${redact(creds.apiSecret)}`);

  const template = fs.readFileSync(templatePath, 'utf8');
  const env = renderEnv(template, {
    BYBIT_API_KEY: creds.apiKey,
    BYBIT_API_SECRET: creds.apiSecret,
    // Safe defaults: nothing real is risked until the operator changes these.
    MODE: 'paper',
    NETWORK: 'mainnet',
  });
  fs.writeFileSync(envPath, env, { mode: 0o600 });
  console.log(`\nWrote ${envPath} (permissions 600, gitignored).`);
  console.log('Defaults are MODE=paper on NETWORK=mainnet — real prices, simulated fills, no orders sent.');

  console.log('\nNext:');
  console.log('  npm run doctor      check connectivity, credentials and which symbols fit $50');
  console.log('  npm run backtest    see what the strategy actually did historically');
  console.log('  npm start           start paper trading');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
