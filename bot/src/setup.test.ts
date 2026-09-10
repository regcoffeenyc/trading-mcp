import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCredentials, renderEnv } from './setup.js';

const KEY = 'AbCdEfGhIjKlMnOpQr';
const SECRET = 'ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210';

test('parses a labelled note', () => {
  const creds = parseCredentials(`Bybit\nAPI Key: ${KEY}\nAPI Secret: ${SECRET}\n`);
  assert.deepEqual(creds, { apiKey: KEY, apiSecret: SECRET });
});

test('parses KEY=VALUE form', () => {
  const creds = parseCredentials(`BYBIT_API_KEY=${KEY}\nBYBIT_API_SECRET=${SECRET}`);
  assert.deepEqual(creds, { apiKey: KEY, apiSecret: SECRET });
});

test('does not mistake the key line for the secret', () => {
  const creds = parseCredentials(`api key ${KEY}\napi secret ${SECRET}`);
  assert.equal(creds?.apiKey, KEY);
  assert.equal(creds?.apiSecret, SECRET);
});

test('handles a note with surrounding prose and blank lines', () => {
  const creds = parseCredentials(
    `Bybit account\n\ncreated 2026-01-01\n\nkey:   ${KEY}\n\nsecret:   ${SECRET}\n\ndo not share`,
  );
  assert.deepEqual(creds, { apiKey: KEY, apiSecret: SECRET });
});

test('falls back to two bare tokens, longer one is the secret', () => {
  const creds = parseCredentials(`${KEY}\n${SECRET}`);
  assert.deepEqual(creds, { apiKey: KEY, apiSecret: SECRET });
});

test('refuses to guess when the note is ambiguous', () => {
  assert.equal(parseCredentials('no credentials here at all'), null);
  assert.equal(parseCredentials(`${KEY}\n${SECRET}\nAbCdEfGhIjKlMnOpQrSt`), null);
});

test('renderEnv substitutes values without dropping comments', () => {
  const template = '# comment\nMODE=paper\nBYBIT_API_KEY=\n# trailing note\n';
  const out = renderEnv(template, { BYBIT_API_KEY: 'abc', MODE: 'live' });
  assert.match(out, /^# comment$/m);
  assert.match(out, /^MODE=live$/m);
  assert.match(out, /^BYBIT_API_KEY=abc$/m);
  assert.match(out, /^# trailing note$/m);
});

test('renderEnv appends keys the template does not contain', () => {
  const out = renderEnv('MODE=paper\n', { NEW_SETTING: 'x' });
  assert.match(out, /^NEW_SETTING=x$/m);
});
