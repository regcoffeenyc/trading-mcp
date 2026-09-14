import assert from 'node:assert/strict';
import { test } from 'node:test';
import net, { type AddressInfo } from 'node:net';
import { startHealthServer, type HealthSnapshot } from './health.js';

/**
 * Port 0 means "disabled" to startHealthServer, so a test cannot ask the OS for
 * an ephemeral one. Borrow a free port and hand back the number instead.
 */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function snapshotOf(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    status: 'ok', mode: 'live', network: 'mainnet', strategy: 'trend',
    equity: 70.9, dayStartEquity: 70.9, dailyPnl: 0, openPositions: 0,
    warmedUp: true, bars: { BTCUSDT: 300, ETHUSDT: 300 }, barsRequired: 210,
    tradesToday: 0, dailyStopHit: false, killSwitch: false,
    lastBarAt: null, uptimeSeconds: 5,
    ...over,
  };
}

/** Starts a server on an ephemeral port and always shuts it down. */
async function withServer(
  snapshot: () => HealthSnapshot,
  fn: (get: (path: string) => Promise<{ status: number; body: string }>) => Promise<void>,
): Promise<void> {
  const port = await freePort();
  const server = startHealthServer(port, snapshot)!;
  await new Promise<void>((resolve) => server.listening ? resolve() : server.once('listening', () => resolve()));
  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.text() };
  };
  try {
    await fn(get);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a healthy snapshot is served as 200', async () => {
  await withServer(() => snapshotOf(), async (get) => {
    const res = await get('/health');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.equity, 70.9);
  });
});

test('a halted bot answers 503, which is what makes it alertable', async () => {
  await withServer(() => snapshotOf({ status: 'halted', killSwitch: true }), async (get) => {
    const res = await get('/health');
    assert.equal(res.status, 503);
  });
});

test('a snapshot that throws answers 500 instead of hanging', async () => {
  // This is the bug the try/catch exists for. The process installs an
  // uncaughtException handler so a stray error cannot kill a bot holding open
  // risk; without the catch, a throw here escapes the handler, is swallowed by
  // that policy, and the socket is never answered. Live, that looked like a
  // healthy process — port listening, log current — with curl hanging forever.
  await withServer(() => { throw new Error('state file is half-written'); }, async (get) => {
    const res = await get('/health');
    assert.equal(res.status, 500, 'answered rather than hung');
    assert.match(res.body, /half-written/, 'and said what went wrong');
  });
});

test('the bar counts are summarised, not dumped', async () => {
  const bars: Record<string, number> = {};
  for (let i = 0; i < 87; i += 1) bars[`SYM${i}USDT`] = 300;
  await withServer(() => snapshotOf({ bars }), async (get) => {
    const body = JSON.parse((await get('/health')).body);
    assert.equal(body.symbols, 87);
    assert.equal(body.symbolsWarm, 87);
    assert.equal(body.bars, undefined, 'the 87-entry map is not the default payload');
    assert.equal(body.notWarm, undefined, 'nothing to report when everything is warm');
  });
});

test('symbols still warming up are named', async () => {
  await withServer(
    () => snapshotOf({ bars: { BTCUSDT: 300, NEWUSDT: 12 }, warmedUp: false }),
    async (get) => {
      const body = JSON.parse((await get('/health')).body);
      assert.equal(body.symbolsWarm, 1);
      assert.deepEqual(body.notWarm, { NEWUSDT: 12 }, 'the useful half of the map survives');
    },
  );
});

test('the full map is available when asked for', async () => {
  await withServer(() => snapshotOf(), async (get) => {
    const body = JSON.parse((await get('/health?verbose=1')).body);
    assert.deepEqual(body.bars, { BTCUSDT: 300, ETHUSDT: 300 });
  });
});

test('an unknown path is a 404, not a snapshot', async () => {
  await withServer(() => snapshotOf(), async (get) => {
    assert.equal((await get('/admin')).status, 404);
  });
});

test('a query string does not stop /health being recognised', async () => {
  // req.url carries the query, so matching it whole made /health?x a 404.
  await withServer(() => snapshotOf(), async (get) => {
    assert.equal((await get('/health?cachebust=1')).status, 200);
  });
});
