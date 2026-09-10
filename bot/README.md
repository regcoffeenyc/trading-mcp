# Bybit Trading Bot

A 24/7 automated trading bot for Bybit USDT perpetuals, built around hard risk
limits: a per-trade risk budget, a daily loss stop, an equity floor, and stops
that live on the exchange rather than in this process.

Zero runtime dependencies — Node 22's built-in `fetch` and `WebSocket` only.

---

## Read this before you start

You asked for a bot that turns **$50 into $250 profit per month**. That is
**+500% per month**, and it is not a target any bot can be built to hit. Here is
the arithmetic, so the decision is yours rather than mine:

**1. Compounding makes the number absurd.** 500% a month sustained for a year is
6¹² ≈ 2.2 billion×. A $50 account would become roughly $100 billion. Nobody in
the history of markets has compounded at that rate; the best funds in the world
target 2–3% *per month*.

**2. Fees are the binding constraint at $50.** Bybit's taker fee is 0.055% per
side, 0.11% per round trip. With a 3% risk budget ($1.50) and a typical 1.5%
stop distance, each trade carries about $100 of notional, so a round trip costs
about **$0.11**. A strategy with a genuinely good +0.2R expectancy earns $0.30
per trade — so fees take roughly **a third of the edge** before slippage. Trade
more often to "make it up" and the fees scale while the edge does not.

**3. Your daily stop is 30% of the account.** Losing $15 on $50 three days
running leaves about $16. The bot enforces the $15 limit exactly as you asked,
but it defaults `EQUITY_FLOOR_USD=20` so the account cannot be ground to zero
before you notice.

**What is actually achievable.** A systematic strategy that genuinely works on
crypto perps returns on the order of **3–10% a month** with 20–40% drawdowns,
and many months are negative. On $50 that is **$1.50–$5.00 a month**. To earn
$250 a month at those rates you need roughly **$2,500–$8,000 in capital** — the
return rate is the constraint, not the bot.

**So use the $50 as tuition, not as an engine.** Run it on paper, then testnet,
then live at $50 with these limits. If it is profitable across a few hundred
trades, the strategy is worth funding properly. If it is not — and most are not
— you learned that for $50 instead of $5,000.

No part of this is investment advice, and nothing here is a promise of profit.
Crypto perpetual futures are leveraged instruments; you can lose your entire
balance.

---

## What it does

- **Strategies.** `trend` (EMA 21/55 cross, gated by EMA200 bias and ADX > 20,
  with an RSI exhaustion veto) or `meanrev` (Bollinger fade with an RSI extreme
  and a rejection wick, only in a low-ADX range regime).
- **Sizing from risk, not from balance.** Position size is derived from the
  distance to the stop, so every trade risks the same percentage of equity
  regardless of the symbol's volatility.
- **Exchange-side protection.** Every entry ships with its stop and target
  attached to the order. If this process dies, the machine reboots, or the
  network drops, the position is still protected by Bybit.
- **Layered risk stops.** Daily loss limit, optional daily profit target, equity
  floor kill-switch, max concurrent positions, daily trade cap, and a cooldown
  after a losing streak. The daily limit is checked every 15 seconds against
  mark-to-market equity, so an open position moving against you trips it too.
- **Restart-safe.** The daily loss baseline persists to disk, so restarting the
  process does not reset the day's limit.
- **Trade management.** Move to breakeven (plus fees) at 1R, optional ATR
  trailing stop, and a max-hold timeout.
- **Paper mode.** Identical code path with simulated fills against the live
  feed, charging real fees and slippage.
- **Backtester.** Runs the same strategy, sizing and daily-stop rules over
  historical candles.
- **Operations.** Auto-reconnecting market data with a staleness watchdog,
  `/health` endpoint, optional Telegram alerts, Docker and systemd units.

---

## Quick start

```bash
cd bot
npm install
npm run build
npm test                    # 36 tests, no network needed

cp .env.example .env        # then edit it
```

### 1. See what the strategy actually did historically

```bash
BACKTEST_BARS=5000 npm run backtest
```

Prints trades, win rate, profit factor, expectancy in R, max drawdown, fees
paid, how many days would have hit your daily stop, and the compounded monthly
rate measured against the $250 goal. **Run this before anything else.** If the
expectancy is negative here, it will be worse live.

### 2. Pre-flight check

```bash
npm run doctor
```

Verifies connectivity, credentials, clock drift, and — critically — whether
each symbol can be traded at all with your account size. Bybit enforces a $5
minimum order, and on an expensive symbol that minimum can exceed your entire
risk budget. The doctor tells you which symbols are viable on $50.

### 3. Paper trade

```bash
MODE=paper NETWORK=mainnet npm start
```

Real market data, simulated fills, no orders sent, no keys needed. Leave it
running for at least two weeks.

### 4. Testnet

Create testnet keys at <https://testnet.bybit.com>, then:

```bash
MODE=live NETWORK=testnet npm start
```

This exercises the real order path — signing, fills, stop placement, closure
detection — with worthless coins.

### 5. Live

Only after the previous steps look right:

```bash
MODE=live NETWORK=mainnet npm start
```

The bot prints a warning and waits 10 seconds before starting.

---

## API key setup

At bybit.com → API → **System-generated API Keys**:

- Permissions: **Contract → Orders + Positions**, and **Read**.
- **Never** enable Withdrawal.
- Restrict the key to your server's IP address.
- Your account must be **Unified Trading (UTA)** — the bot reads
  `accountType=UNIFIED`.

Keep the secret in `.env` only. It is gitignored; keep it that way.

---

## Configuration

Every setting lives in `.env` — see `.env.example` for the full annotated list.
The ones that decide whether the account survives:

| Variable | Default | What it does |
|---|---|---|
| `MODE` | `paper` | `paper` simulates fills; `live` sends real orders |
| `NETWORK` | `testnet` | `mainnet`, `testnet` or `demo` |
| `SYMBOLS` | `SOLUSDT,XRPUSDT,DOGEUSDT` | Lower-priced symbols size better on a small account |
| `INTERVAL` | `15` | Minutes per candle. Below 15m, fees dominate |
| `RISK_PER_TRADE_PCT` | `3` | Percent of equity risked per trade |
| `MAX_DAILY_LOSS_USD` | `15` | Hard daily stop, mark-to-market |
| `EQUITY_FLOOR_USD` | `20` | Permanent halt below this equity |
| `MAX_TRADES_PER_DAY` | `6` | Fee brake |
| `MAX_CONSECUTIVE_LOSSES` | `3` | Losing streak triggers a cooldown |
| `LEVERAGE` | `5` | Higher leverage moves liquidation closer than your stop |

The bot **refuses to start** on an incoherent risk config — for example a
per-trade risk larger than the daily loss limit, or an equity floor above
starting equity.

### Symbol choice matters on $50

Bybit's $5 minimum order value means a single BTCUSDT trade can risk more than
your whole budget. `npm run doctor` reports, per symbol, whether a trade can be
sized within your risk budget. Prefer liquid, lower-priced perps.

---

## Running 24/7

**Docker (recommended):**

```bash
docker compose up -d --build
docker compose logs -f
```

**systemd:**

```bash
sudo useradd -r -s /usr/sbin/nologin bot
sudo mkdir -p /opt/bybit-bot && sudo cp -r dist package.json .env /opt/bybit-bot/
sudo chown -R bot:bot /opt/bybit-bot
sudo cp deploy/bybit-bot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now bybit-bot
journalctl -u bybit-bot -f
```

Both restart automatically on crash and on host reboot.

**Monitoring.** `GET /health` on `HEALTH_PORT` returns equity, daily P&L, open
positions and halt state — and **503 once halted**, so any uptime monitor can
alert you. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for push alerts on
every entry, exit and halt.

Host it somewhere that does not sleep — a $5/month VPS. A laptop is not a 24/7
host, and a bot that is offline when its stop should move is a bot with an
unmanaged position.

---

## How the risk stops interact

1. **Per trade** — `RISK_PER_TRADE_PCT` of equity, enforced by sizing from the
   stop distance. A trade that cannot be sized within budget is skipped, not
   shrunk to a meaningless size or inflated to the exchange minimum.
2. **Per day** — trading halts once `MAX_DAILY_LOSS_USD` is reached, measured
   against equity at the day's start. With `FLATTEN_ON_DAILY_STOP=true` open
   positions are closed too. Resets at `DAY_RESET_HOUR_UTC`.
3. **Per streak** — `MAX_CONSECUTIVE_LOSSES` triggers a `COOLDOWN_MINUTES` pause.
4. **Account** — below `EQUITY_FLOOR_USD` the kill switch latches and the bot
   will not trade again until you clear it in `data/state.json`.

A trade is also refused when its risk exceeds what is left of the daily budget,
so the bot cannot open a position that would breach the limit if it loses.

---

## Project layout

```
src/
  index.ts          entry point, signal handling, graceful shutdown
  engine.ts         control loop: bar clock for decisions, 15s clock for risk
  config.ts         env parsing plus refuse-to-start validation
  risk.ts           sizing and every rule that can stop a trade
  state.ts          crash-safe persistence of the daily loss baseline
  backtest.ts       historical simulation of the same rules
  doctor.ts         pre-flight connectivity and tradability check
  indicators.ts     EMA, SMA, RSI, ATR, ADX, Bollinger
  strategy/         trend and mean-reversion signal generators
  broker/           live and paper execution behind one interface
  bybit/            V5 REST client and auto-reconnecting kline stream
  testing/          mock Bybit server used by the integration tests
```

## Tests

```bash
npm run build && npm test
```

36 tests, no network required. They cover order-step rounding (where a rounding
bug means a rejected order or an oversized position), indicator correctness,
every risk gate, config validation, the backtest loop, HMAC request signing
verified against an independent checker, kline ordering and pagination, and the
live broker's order/closure/adoption paths against a mock Bybit.

## Extending it

Add a strategy by implementing the `Strategy` interface in `src/strategy/` and
registering it in `src/strategy/index.ts`. It receives closed candles only and
returns a side, a stop and a target; sizing, risk gates and execution are
handled for you. Backtest it before running it.
