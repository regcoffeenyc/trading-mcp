import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BybitRest } from './bybit/rest.js';

/**
 * The host clock these tests simulate is the one the bot was found running on:
 * its time service was stopped and it lost about five seconds an hour, which is
 * the entire recv window. Syncing once at startup is only correct for the first
 * hour, and after that every signed request is rejected as expired.
 */
const SERVER_NOW = 1_700_000_000_000;

interface Call { url: string; headers: Record<string, string> }

/**
 * Stands in for Bybit. `localSkewMs` is how far this machine's clock sits ahead
 * of the exchange's; `now()` is the fake local clock the test drives.
 */
function fakeBybit(localSkewMs: number, now: () => number) {
  const calls: Call[] = [];
  const fetchImpl = async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    const result = url.includes('/v5/market/time')
      // Server time is the local clock minus the skew: the truth we should converge on.
      ? { timeNano: String((now() - localSkewMs) * 1e6) }
      : { list: [] };
    return { ok: true, status: 200, async json() { return { retCode: 0, retMsg: 'OK', result }; } };
  };
  return {
    calls,
    timeCalls: () => calls.filter((c) => c.url.includes('/v5/market/time')).length,
    fetchImpl,
  };
}

/** Runs `fn` with the clock and fetch replaced, and always puts them back. */
async function withFakes(
  localSkewMs: number,
  fn: (ctx: { advance(ms: number): void; timeCalls(): number; calls: Call[]; rest: BybitRest }) => Promise<void>,
): Promise<void> {
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  let offset = 0;
  const now = () => SERVER_NOW + localSkewMs + offset;
  const bybit = fakeBybit(localSkewMs, now);
  Date.now = now;
  globalThis.fetch = bybit.fetchImpl as unknown as typeof fetch;
  try {
    const rest = new BybitRest({ network: 'mainnet', apiKey: 'k', apiSecret: 's', recvWindow: '5000' });
    await fn({ advance: (ms) => { offset += ms; }, timeCalls: bybit.timeCalls, calls: bybit.calls, rest });
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
  }
}

function timestampOf(call: Call): number {
  return Number(call.headers['X-BAPI-TIMESTAMP']);
}

test('the first signed request reads server time before signing', async () => {
  await withFakes(6000, async ({ rest, timeCalls, calls }) => {
    await rest.positions();
    assert.equal(timeCalls(), 1, 'synced once');

    const signed = calls.find((c) => c.url.includes('/v5/position/list'));
    assert.ok(signed, 'the signed request went out');
    // Signed with corrected time, not the local clock's six-second lie.
    assert.ok(
      Math.abs(timestampOf(signed) - SERVER_NOW) < 1000,
      `timestamp ${timestampOf(signed)} should sit near server time ${SERVER_NOW}`,
    );
  });
});

test('back-to-back requests do not re-read server time', async () => {
  await withFakes(0, async ({ rest, timeCalls }) => {
    await rest.positions();
    await rest.positions();
    await rest.positions();
    assert.equal(timeCalls(), 1, 'one reading covers a burst of calls');
  });
});

test('concurrent first requests share a single reading', async () => {
  await withFakes(0, async ({ rest, timeCalls }) => {
    await Promise.all([rest.positions(), rest.positions(), rest.positions()]);
    assert.equal(timeCalls(), 1, 'the in-flight sync is shared, not stampeded');
  });
});

test('a stale reading is refreshed before the next signed request', async () => {
  await withFakes(0, async ({ rest, timeCalls, advance }) => {
    await rest.positions();
    assert.equal(timeCalls(), 1);

    advance(4 * 60_000);
    await rest.positions();
    assert.equal(timeCalls(), 1, 'four minutes on, the reading still holds');

    advance(2 * 60_000);
    await rest.positions();
    assert.equal(timeCalls(), 2, 'past the window, it is re-read');
  });
});

test('a clock drifting past the recv window never signs with a stale offset', async () => {
  // Five seconds an hour, against a 5000ms window: without a refresh the third
  // hour signs almost fifteen seconds out and every request is rejected.
  const DRIFT_PER_HOUR = 5000;
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  let elapsed = 0;
  const drift = () => (elapsed / 3_600_000) * DRIFT_PER_HOUR;
  const now = () => SERVER_NOW + elapsed + drift();

  const seen: number[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (url.includes('/v5/position/list')) seen.push(Number(headers['X-BAPI-TIMESTAMP']) - (SERVER_NOW + elapsed));
    const result = url.includes('/v5/market/time')
      ? { timeNano: String((now() - drift()) * 1e6) }
      : { list: [] };
    return { ok: true, status: 200, async json() { return { retCode: 0, retMsg: 'OK', result }; } };
  }) as unknown as typeof fetch;
  Date.now = now;

  try {
    const rest = new BybitRest({ network: 'mainnet', apiKey: 'k', apiSecret: 's', recvWindow: '5000' });
    for (let minute = 0; minute <= 180; minute += 10) {
      elapsed = minute * 60_000;
      await rest.positions();
    }
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
  }

  const worst = Math.max(...seen.map(Math.abs));
  assert.ok(worst < 1000, `worst signed error over three hours was ${worst}ms; the window is 5000ms`);
});

test('a rejected request corrects the clock without another network call', async () => {
  const realNow = Date.now;
  const realFetch = globalThis.fetch;

  // The host clock is 8.5s behind the exchange — the skew actually observed —
  // and the network is down, so reading /v5/market/time cannot save us.
  const SKEW = -8500;
  const now = () => SERVER_NOW + SKEW;
  Date.now = now;

  let timeReads = 0;
  const signedAt: number[] = [];
  let firstCall = true;

  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.includes('/v5/market/time')) {
      timeReads++;
      throw new TypeError('fetch failed');
    }
    const ts = Number((init.headers ?? {})['X-BAPI-TIMESTAMP']);
    signedAt.push(ts);
    // Bybit refuses anything more than recvWindow from its own clock, and says
    // so with both timestamps in the message.
    if (Math.abs(ts - SERVER_NOW) > 5000) {
      if (firstCall) {
        firstCall = false;
        return {
          ok: true, status: 200,
          async json() {
            return {
              retCode: 10002,
              retMsg: `invalid request, please check your server timestamp or recv_window param: ` +
                `req_timestamp[${ts}],server_timestamp[${SERVER_NOW}],recv_window[5000]`,
              result: {},
            };
          },
        };
      }
      throw new Error('signed out of window twice — the correction did not take');
    }
    return { ok: true, status: 200, async json() { return { retCode: 0, retMsg: 'OK', result: { list: [] } }; } };
  }) as unknown as typeof fetch;

  try {
    const rest = new BybitRest({ network: 'mainnet', apiKey: 'k', apiSecret: 's', recvWindow: '5000' });
    await rest.positions();
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
  }

  assert.equal(signedAt.length, 2, 'one rejection, then one accepted retry');
  assert.ok(
    Math.abs(signedAt[1]! - SERVER_NOW) < 5,
    `retry signed at ${signedAt[1]}, should land on server time ${SERVER_NOW}`,
  );
});
