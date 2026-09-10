import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { BybitRest } from './bybit/rest.js';
import { LiveBroker } from './broker/live.js';
import { MockBybit } from './testing/mock-bybit.js';
import { configureLogger } from './logger.js';

configureLogger({ level: 'error' });

const API_KEY = 'test-key';
const API_SECRET = 'test-secret';

let mock: MockBybit;
let host: string;
let rest: BybitRest;

before(async () => {
  mock = new MockBybit({ apiKey: API_KEY, apiSecret: API_SECRET, price: 100, equity: 50 });
  host = await mock.listen();
  rest = new BybitRest({ network: 'mainnet', apiKey: API_KEY, apiSecret: API_SECRET, recvWindow: '5000', host });
});

after(async () => { await mock.close(); });

test('signed requests are accepted — HMAC payload matches Bybit\'s scheme', async () => {
  const balance = await rest.walletBalance();
  assert.equal(balance.equity, 50);
  assert.equal(mock.signatureFailures, 0, 'the mock rejected our signature');
});

test('a wrong secret is rejected, proving the signature is actually checked', async () => {
  const bad = new BybitRest({ network: 'mainnet', apiKey: API_KEY, apiSecret: 'wrong', recvWindow: '5000', host });
  await assert.rejects(() => bad.walletBalance(), /10004|error sign/);
});

test('klines are returned oldest-first with only the last bar open', async () => {
  const candles = await rest.klines('BTCUSDT', '15', 50);
  assert.equal(candles.length, 50);
  for (let i = 1; i < candles.length; i++) {
    assert.ok(candles[i]!.time > candles[i - 1]!.time, 'candles must ascend in time');
  }
  assert.equal(candles.at(-1)!.closed, false, 'the newest bar is still forming');
  assert.equal(candles[0]!.closed, true);
});

test('kline history pages backwards and de-duplicates overlapping pages', async () => {
  const history = await rest.klineHistory('BTCUSDT', '15', 2500);
  assert.equal(history.length, 2500);
  const times = new Set(history.map((c) => c.time));
  assert.equal(times.size, history.length, 'paging produced duplicate bars');
  for (let i = 1; i < history.length; i++) {
    assert.ok(history[i]!.time > history[i - 1]!.time);
  }
});

test('instrument filters are parsed into the fields sizing depends on', async () => {
  const inst = await rest.instrument('BTCUSDT');
  assert.equal(inst.tickSize, '0.01');
  assert.equal(inst.qtyStep, '0.001');
  assert.equal(inst.minNotionalValue, 5);
  assert.equal(inst.maxLeverage, 25);
});

test('a non-zero retCode surfaces as an error rather than silent success', async () => {
  mock.failNextOrderWith = 110007; // insufficient balance
  await assert.rejects(
    () => rest.placeMarketOrder({ symbol: 'BTCUSDT', side: 'Buy', qty: '0.01' }),
    /110007/,
  );
});

test('entry orders carry the stop and target to the exchange', async () => {
  mock.positions = [];
  const broker = new LiveBroker(rest);
  await broker.init(['BTCUSDT'], 5);
  await broker.open({ symbol: 'BTCUSDT', side: 'Buy', qty: '0.010', stopLoss: '98.00', takeProfit: '104.00' });

  const order = mock.orders.at(-1)!;
  assert.equal(order.symbol, 'BTCUSDT');
  assert.equal(order.side, 'Buy');
  assert.equal(order.orderType, 'Market');
  assert.equal(order.reduceOnly, undefined);
  assert.equal(order.stopLoss, '98.00', 'stop must be attached at entry, not set afterwards');
  assert.equal(order.takeProfit, '104.00');
  assert.equal(order.slTriggerBy, 'MarkPrice');
});

test('a closed position is detected and its realised P&L read from the ledger', async () => {
  mock.positions = [];
  mock.orders.length = 0;
  const broker = new LiveBroker(rest);
  await broker.init(['BTCUSDT'], 5);
  await broker.open({ symbol: 'BTCUSDT', side: 'Buy', qty: '0.010', stopLoss: '98.00', takeProfit: '104.00' });
  assert.deepEqual(await broker.pollClosures(), [], 'an open position is not a closure');

  // Simulate the exchange stopping us out.
  mock.positions = [];
  mock.closedPnl = [{
    symbol: 'BTCUSDT', side: 'Buy', closedPnl: '-1.47', updatedTime: String(Date.now()), orderId: 'x',
  }];

  const closures = await broker.pollClosures();
  assert.equal(closures.length, 1);
  assert.equal(closures[0]!.symbol, 'BTCUSDT');
  assert.equal(closures[0]!.pnl, -1.47);
  assert.equal(closures[0]!.reason, 'stop/exit');
  assert.deepEqual(await broker.pollClosures(), [], 'a closure is reported exactly once');
});

test('an existing position is adopted on restart instead of being duplicated', async () => {
  mock.closedPnl = [];
  mock.positions = [{
    symbol: 'ETHUSDT', side: 'Sell', size: '0.05', avgPrice: '100', markPrice: '99',
    unrealisedPnl: '0.05', leverage: '5', stopLoss: '102', takeProfit: '96', createdTime: String(Date.now()),
  }];
  const broker = new LiveBroker(rest);
  await broker.init(['ETHUSDT'], 5);
  const positions = await broker.positions();
  assert.equal(positions.length, 1);
  assert.equal(positions[0]!.side, 'Sell');
  assert.equal(positions[0]!.stopLoss, 102);
  assert.deepEqual(await broker.pollClosures(), [], 'adopting must not look like a closure');
});

test('closing a position sends a reduce-only order on the opposite side', async () => {
  mock.orders.length = 0;
  mock.positions = [{
    symbol: 'BTCUSDT', side: 'Buy', size: '0.010', avgPrice: '100', markPrice: '100',
    unrealisedPnl: '0', leverage: '5', stopLoss: '98', takeProfit: '104', createdTime: String(Date.now()),
  }];
  const broker = new LiveBroker(rest);
  await broker.close('BTCUSDT', 'Buy', '0.010', 'daily-stop');
  const order = mock.orders.at(-1)!;
  assert.equal(order.side, 'Sell');
  assert.equal(order.reduceOnly, true);
  assert.equal(mock.positions.length, 0);
});

test('moving the stop hits the trading-stop endpoint with a mark-price trigger', async () => {
  mock.tradingStops.length = 0;
  const broker = new LiveBroker(rest);
  await broker.moveStop('BTCUSDT', '100.50');
  const stop = mock.tradingStops.at(-1)!;
  assert.equal(stop.symbol, 'BTCUSDT');
  assert.equal(stop.stopLoss, '100.50');
  assert.equal(stop.slTriggerBy, 'MarkPrice');
});

test('the clock offset is derived from server time', async () => {
  const offset = await rest.syncClock();
  assert.ok(Math.abs(offset) < 5000, `unexpected clock offset ${offset}`);
});
