# Backtest findings

Measured 2026-09-10 over OKX candles for the same USDT perpetuals Bybit lists
(Bybit's REST API was geo-blocked from the machine that ran this). Prices track
Bybit within a few basis points, Bybit's 0.055% taker fee and a $5 minimum order
value were applied, and the run used the shipped risk settings: $50 equity, 3%
risk per trade, $15 daily loss stop, $20 equity floor.

**Re-run this on your own machine against Bybit before acting on it**
(`BACKTEST_SOURCE=bybit npm run backtest`).

## Result

60 configurations — 5 symbols × 2 strategies × 2 timeframes × 3 stop/target
pairs — over roughly 2,900 trades. 15m runs cover 154 days, 1H runs 616 days.

| | |
|---|---|
| Configurations profitable | **4 of 60** |
| Trade-weighted mean expectancy | **−0.134 R** |
| Best configuration | DOGEUSDT meanrev 1H, +2.1%/month (24 trades) |
| Best 15m configuration | SOLUSDT trend, −0.9%/month |

**Neither shipped strategy has a demonstrated edge.** The four profitable
configurations are what you would expect to find by chance when testing 60 of
them, and the best one rests on 24 trades over 20 months.

On $50, that best-case +2.1%/month is **$1.05 a month** — against a $250/month
goal. Even taking the cherry-picked number at face value, the gap is ~240×.

## What the data does say

**1. The hourly timeframe beats 15 minutes, decisively.** Every 15m
configuration lost money. This is the fee-drag argument made concrete: a round
trip costs 0.11% of notional regardless of how far price moves, so shorter bars
pay the same toll for a smaller move. The shipped default is now `INTERVAL=60`.

**2. Drawdowns are severe.** Many configurations show 40–60% peak-to-trough on a
$50 account. Two breached the $20 equity floor and halted — the kill switch
worked, but the account was down 60% by then.

**3. Tighter targets beat wider ones.** Across the board, `TAKE_PROFIT_R=2`
outperformed 3 and 4. Trend-following theory says let winners run; on these
symbols and this horizon, the wider targets were simply not reached often
enough to pay for the extra losers.

**4. Moving to breakeven at 1R is roughly neutral.** It slightly improves win
rate and slightly reduces expectancy — it converts small winners into scratches
about as often as it saves a loser. Keep it for the drawdown reduction, not for
returns.

## Recommendation

**Do not fund this yet.** A negative-expectancy system loses money faster with
more capital, not less. Funding $50 into a system measured at −0.134 R per trade
is buying a slow, fee-driven bleed.

Two honest paths from here:

1. **Paper-trade the least-bad configuration** (`meanrev`, 1H, DOGE/SOL) for a
   month and compare live results against the backtest. If they diverge sharply,
   the backtest is wrong; if they match, the answer is already known.
2. **Find an actual edge first.** The infrastructure — risk limits, sizing,
   exchange-side stops, reconnection, state persistence — is sound and reusable.
   The signal generator is the part that does not work. Testing a new strategy is
   now a matter of implementing one interface and running one command.

What would move the needle on the $250/month target is capital, not parameters.
At a *genuinely good* 5%/month, $250 requires $5,000. No configuration in this
sweep reached 5%/month even before accounting for the selection bias.

## Raw sweep

Ranked by compounded monthly return. `expR` is expectancy in R (risk units) per
trade — the number that decides whether a system makes money over time.

```
interval symbol    strategy stop  tp   days trades win%   PF     expR    maxDD%  monthly%
   60m DOGEUSDT  meanrev   1.5  1.5   616     24  70.8   4.07 +0.660     7.7 +2.1
   60m DOGEUSDT  meanrev   1.8    2   616     24  70.8   4.02 +0.587     8.0 +1.9
   60m DOGEUSDT  meanrev   2.5    3   616     24  75.0   3.82 +0.448     6.8 +1.4
   60m DOGEUSDT  trend     1.8    2   616     57  50.9   1.10 +0.058    16.7 +0.1
   60m SOLUSDT   trend     1.8    2   616     70  52.9   1.06 +0.041    20.8 -0.0
   60m DOGEUSDT  trend     2.5    3   616     57  52.6   1.06 +0.024    11.7 -0.0
   60m SOLUSDT   trend     2.5    3   616     70  50.0   1.05 +0.027    20.6 -0.1
   60m SOLUSDT   meanrev   2.5    3   616     32  53.1   1.03 +0.022     8.3 -0.1
   60m XRPUSDT   trend     1.8    2   616     70  47.1   1.03 +0.031    15.1 -0.2
   60m XRPUSDT   trend     2.5    3   616     70  47.1   0.98 +0.005    15.1 -0.3
   60m SOLUSDT   trend     1.5  1.5   616     70  54.3   1.00 +0.017    26.6 -0.3
   60m SOLUSDT   meanrev   1.8    2   616     32  53.1   0.79 -0.066    16.7 -0.5
   60m XRPUSDT   meanrev   1.5  1.5   616     28  42.9   0.80 -0.078    27.6 -0.6
   60m SOLUSDT   meanrev   1.5  1.5   616     32  50.0   0.75 -0.096    17.7 -0.7
   60m XRPUSDT   meanrev   1.8    2   616     28  39.3   0.72 -0.121    28.9 -0.7
   60m DOGEUSDT  trend     1.5  1.5   616     57  49.1   0.89 -0.046    19.9 -0.8
   60m XRPUSDT   meanrev   2.5    3   616     28  39.3   0.59 -0.174    28.2 -0.9
   15m SOLUSDT   trend     1.8    2   154     62  45.2   1.09 +0.062    25.1 -0.9
   60m XRPUSDT   trend     1.5  1.5   616     69  44.9   0.90 -0.040    27.4 -1.0
   60m BTCUSDT   meanrev   2.5    3   616     32  34.4   0.59 -0.179    32.5 -1.1
   60m BTCUSDT   trend     2.5    3   616     69  37.7   0.76 -0.065    38.0 -1.1
   60m ETHUSDT   meanrev   2.5    3   616     42  42.9   0.57 -0.175    28.1 -1.3
   60m BTCUSDT   meanrev   1.5  1.5   616     33  36.4   0.42 -0.360    34.1 -1.9
   60m ETHUSDT   meanrev   1.8    2   616     42  35.7   0.46 -0.288    34.7 -2.0
   60m ETHUSDT   meanrev   1.5  1.5   616     42  35.7   0.47 -0.303    37.0 -2.2
   60m BTCUSDT   meanrev   1.8    2   616     32  31.3   0.25 -0.450    39.4 -2.4
   15m ETHUSDT   trend     2.5    3   154     60  48.3   1.00 +0.022    32.9 -2.5
   60m BTCUSDT   trend     1.8    2   616     70  34.3   0.50 -0.206    53.8 -2.8
   15m ETHUSDT   meanrev   1.8    2   154     23  39.1   0.79 -0.151    15.1 -2.8
   15m ETHUSDT   trend     1.5  1.5   154     59  50.8   1.00 +0.015    20.1 -2.8
   60m BTCUSDT   trend     1.5  1.5   616     71  35.2   0.55 -0.209    54.9 -2.8
   60m ETHUSDT   trend     2.5    3   616     94  34.0   0.57 -0.201    49.3 -3.2
   15m XRPUSDT   meanrev   2.5    3   154     31  38.7   0.79 -0.123    23.2 -3.3
   15m DOGEUSDT  trend     2.5    3   154     75  46.7   0.94 -0.002    39.0 -3.5
   15m ETHUSDT   trend     1.8    2   154     60  45.0   0.96 -0.022    31.1 -3.6
   15m ETHUSDT   meanrev   1.5  1.5   154     23  39.1   0.66 -0.255    20.3 -3.8
   60m ETHUSDT   trend     1.5  1.5   616     97  32.0   0.58 -0.251    58.3 -4.2
   15m ETHUSDT   meanrev   2.5    3   154     23  39.1   0.60 -0.275    20.2 -4.2
   15m SOLUSDT   trend     1.5  1.5   154     68  47.1   0.96 -0.042    32.3 -4.2
   15m SOLUSDT   meanrev   1.5  1.5   154     25  36.0   0.62 -0.245    25.5 -4.3
   15m BTCUSDT   meanrev   2.5    3   154     26  38.5   0.66 -0.229    23.6 -4.4
   60m ETHUSDT   trend     1.8    2   616     98  31.6   0.51 -0.272    60.7 -4.4
   15m SOLUSDT   meanrev   1.8    2   154     24  37.5   0.53 -0.290    24.7 -5.0
   15m BTCUSDT   meanrev   1.8    2   154     26  34.6   0.59 -0.366    26.4 -5.0
   15m SOLUSDT   meanrev   2.5    3   154     25  36.0   0.45 -0.317    29.4 -5.5
   15m XRPUSDT   meanrev   1.8    2   154     31  35.5   0.61 -0.295    31.5 -6.1
   15m XRPUSDT   meanrev   1.5  1.5   154     30  40.0   0.51 -0.346    35.0 -6.4
   15m XRPUSDT   trend     1.5  1.5   154     69  43.5   0.83 -0.138    34.9 -6.9
   15m BTCUSDT   trend     1.5  1.5   154     54  42.6   0.69 -0.209    36.7 -7.1
   15m BTCUSDT   meanrev   1.5  1.5   154     26  34.6   0.26 -0.581    32.6 -7.4
   15m DOGEUSDT  meanrev   2.5    3   154     31  32.3   0.41 -0.385    35.2 -8.1
   15m SOLUSDT   trend     2.5    3   154     62  41.9   0.69 -0.154    42.3 -8.4
   15m DOGEUSDT  meanrev   1.8    2   154     30  30.0   0.42 -0.411    39.8 -8.5
   15m DOGEUSDT  meanrev   1.5  1.5   154     32  28.1   0.45 -0.406    40.3 -8.7
   15m BTCUSDT   trend     2.5    3   154     50  32.0   0.64 -0.259    44.1 -9.3
   15m XRPUSDT   trend     2.5    3   154     66  43.9   0.70 -0.198    48.3 -10.0
   15m DOGEUSDT  trend     1.5  1.5   154     77  41.6   0.68 -0.162    50.2 -10.5
   15m XRPUSDT   trend     1.8    2   154     68  38.2   0.68 -0.253    49.1 -11.2
   15m BTCUSDT   trend     1.8    2   154     54  33.3   0.53 -0.365    50.7 -11.7
   15m DOGEUSDT  trend     1.8    2   154     62  35.5   0.43 -0.412    60.8 -16.4
```
