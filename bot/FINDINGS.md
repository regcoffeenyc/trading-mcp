# Backtest findings

> **VERIFIED ON BYBIT 2026-09-10 — THE EDGE DID NOT REPLICATE.**
> Re-running the headline test against Bybit's own candles on the operator's
> machine gives **+0.012 R per trade over 314 trades (t = 0.37, 95% CI −0.052
> to +0.077 R)** — statistically indistinguishable from zero. The OKX-derived
> +0.253 R below did not survive contact with the exchange the bot actually
> trades on. See "Bybit verification" at the end. **Do not fund this strategy.**

Measured 2026-09-10 over OKX candles for the same USDT perpetuals Bybit lists
(Bybit's REST API was geo-blocked from the machine that ran this). Prices track
Bybit within a few basis points, Bybit's 0.055% taker fee and a $5 minimum order
value were applied, and the run used the shipped risk settings: $50 equity, 3%
risk per trade, $15 daily loss stop, $20 equity floor.

**Re-run this on your own machine against Bybit before acting on it**
(`BACKTEST_SOURCE=bybit npm run backtest`).

## Headline: the timeframe decides the sign

Roughly 2,450 trades across 5 symbols, both strategies, five timeframes and two
stop/target pairs. Grouping by timeframe rather than reading any single cell,
because with ~100 configurations the best cell is noise:

| Timeframe | Configs profitable | Expectancy | Trades |
|---|---|---|---|
| 15m | 2 / 20 | **−0.142 R** | 865 |
| 1H | 6 / 20 | −0.086 R | 950 |
| 4H | 9 / 20 | **+0.071 R** | 242 |
| 12H | 10 / 20 | **+0.051 R** | 275 |
| 1D | 8 / 18 | **+0.124 R** | 122 |

Split by strategy, one of the two holds up and the other does not:

| Strategy | 15m | 1H | 4H | 12H | 1D |
|---|---|---|---|---|---|
| **trend** | −0.105 | −0.082 | +0.063 | **+0.214** | **+0.343** |
| **meanrev** | −0.229 | −0.095 | +0.086 | −0.212 | −0.251 |

**Trend-following improves monotonically across all five timeframes.** That is
not a cherry-picked cell; it is a consistent gradient with a mechanism behind
it — a round trip costs 0.11% of notional no matter how long the trade lasts,
so the longer the hold and the larger the move captured, the less the fee
matters. Median drawdown falls the same way, from 48% at 15m to 8.8% at 1D.

**Mean-reversion does not hold up.** It is positive at 4H and negative either
side of it. A result that flips sign as a parameter moves, with no mechanism to
explain it, is noise.

## Frequency is the lever, and it scales with the universe

Positive expectancy did not become a return on five symbols, because long
timeframes trade rarely — roughly one entry per symbol per quarter. So the
obvious question is whether trading more symbols multiplies the trades without
diluting the edge. Tested on 30 established perpetuals listed on both Bybit and
OKX, 12H trend-following, 2.5 ATR stop and 3R target, 316 trades over ~3.7 years:

| | |
|---|---|
| Symbols with positive expectancy | **19 / 30** |
| Trade-weighted expectancy | **+0.253 R** |
| Trades | 316 (~10.5 per symbol) |
| Portfolio rate | ~85 trades/year |

The per-trade edge held while the trade count nearly doubled (+0.253 R across 30
symbols against +0.214 R across five). That is what a real edge looks like when
you widen the sample, and the opposite of what overfitting looks like.

At 3% risk per trade and 85 trades a year, that is roughly **65% a year before
compounding** — about **$2.69 a month on $50**, and **$250/month at around
$5,000** of capital.

## Walk-forward: the edge survives out-of-sample

Everything above chose its parameters by looking at the whole history, which is
how backtests flatter themselves. The proper test is to choose on one slice and
measure on another the choice never saw.

Parameters were selected on the **first 60%** of each symbol's 12H history, then
evaluated on the **last 40%**:

| | Out-of-sample expectancy | Trades |
|---|---|---|
| All 32 grid points (baseline) | +0.081 R | 2,603 |
| Config chosen on in-sample only (`trend` 1.8/4) | **+0.402 R** | 119 |
| Shipped config (`trend` 2.5/3) | **+0.438 R** | 110 |

Three things pass at once:

1. **No decay.** The chosen configuration scored +0.324 R in-sample and +0.402 R
   out-of-sample. Overfitting produces the opposite — a strong in-sample number
   that collapses on unseen data.
2. **The selection carried information.** +0.402 R against a grid-wide baseline
   of +0.081 R. Choosing on the first 60% genuinely predicted what worked in the
   last 40%, rather than picking a lucky cell.
3. **The whole space is positive.** The baseline itself — every parameter
   combination averaged, good and bad — is +0.081 R over 2,603 trades. The
   result does not depend on finding one magic setting.

Every one of the top eight in-sample configurations was `trend`; mean-reversion
did not place, consistent with it flipping sign across timeframes earlier.

This is about as much validation as a backtest can give. It does not remove the
survivorship caveat below, and it cannot model outages, funding costs, or a
regime the data never contained.

### Read that with four caveats

1. **Survivorship bias, and it is the big one.** These are the 30 perpetuals that
   exist today with years of history. Coins that were delisted or collapsed are
   not in the sample, and a trend system would have taken losses in them.
   Expect the live figure to be materially below +0.253 R.
2. **The sample is still modest.** 316 trades sounds like a lot until you split
   it 30 ways: ~10 trades per symbol. Individual symbol rows mean little.
3. **Position slots cap the return.** 85 trades a year holding several days each
   needs more concurrent capacity than the config allows; with a small number of
   slots you will simply miss signals, and the realised return falls below the
   arithmetic above.
4. **Crypto is correlated.** Several open positions is not diversification when
   everything sells off together. More slots means more risk in exactly the
   moment it hurts.

## What the data does say

**1. Short timeframes are where the money goes.** Every 15m configuration lost
money, and 1H barely improved on it. The shipped default is now `INTERVAL=720`
(12H) with `STRATEGY=trend`, which is where expectancy is both positive and
supported by a reasonable number of trades.

**2. Drawdowns shrink as the timeframe lengthens.** Median peak-to-trough falls
from 48% at 15m to 8.8% at 1D. Several short-timeframe configurations breached
the $20 equity floor and halted — the kill switch worked, but the account was
down 60% by the time it fired.

**3. Target width depends on the timeframe.** At 15m and 1H, `TAKE_PROFIT_R=2`
beat 3 and 4 — the wider targets were not reached often enough to pay for the
extra losers. At 4H and above the ordering reverses and `2.5/3` tends to win,
which is what trend-following theory predicts once fees stop dominating.

**4. Moving to breakeven at 1R is roughly neutral.** It slightly improves win
rate and slightly reduces expectancy — it converts small winners into scratches
about as often as it saves a loser. Keep it for the drawdown reduction, not for
returns.

## Recommendation

**Do not fund $50 yet** — the reason has changed twice, so here is where it
landed. The first sweep found a fee-driven bleed. Extending the timeframe found
a positive, consistent edge in slow trend-following. Widening the universe found
that the edge survives and the frequency scales.

What has not changed is that $50 is the wrong amount. At ~65%/year before
survivorship bias, $50 returns a few dollars a month, and the exchange's $5
minimum order means a 3% risk budget ($1.50) cannot always be expressed at all.
The account is too small for the strategy to run properly, never mind hit $250.

The number that matters: **$250/month needs roughly $5,000**, and only if the
edge survives out-of-sample. Prove that on paper first.

Two honest paths from here:

1. **Paper-trade the best-supported configuration** — `trend` on 12H across the
   30-symbol universe — and compare live results against the backtest. This is
   what `.env.paper.example` now sets up. The wide universe matters practically
   as well as statistically: five symbols would produce about 14 trades a year,
   far too few to learn anything from a paper run, while thirty produce roughly
   seven a month.
2. **Correct for survivorship before believing the number.** This is now the
   single largest open question, since the walk-forward test has ruled out
   overfitting as an explanation. Re-running over a universe that includes
   delisted perpetuals would give an honest expectancy. Until that is done,
   treat the measured figures as an optimistic ceiling.

What would move the needle on the $250/month target is capital, not parameters.
The strategy's measured rate is around 5%/month at best and probably less; the
gap to $250 on $50 is a capital gap, and tuning cannot close it.

## Raw sweep: 15m and 1H

The original short-timeframe sweep, kept because it is the evidence for the
central claim that fees dominate at these speeds. Ranked by compounded monthly
return; `expR` is expectancy in R (risk units) per trade.

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


---

# Bybit verification (2026-09-10)

Everything above was measured on OKX candles because Bybit's REST API was
geo-blocked from the machine that ran it. This section re-runs the headline
configuration on **Bybit's own data**, on the operator's Windows machine, using
the shipped settings (12H trend, $50 equity, 3% risk, $15 daily stop, 0.055%
taker fee, 0.02% slippage) over 3,000 bars per symbol — 2022-11-16 to
2026-09-10.

## The result

| Metric | OKX (earlier) | **Bybit (verified)** |
|---|---|---|
| Trades | 316 | **314** |
| Expectancy | +0.253 R | **+0.012 R** |
| Symbols positive | 19 / 30 | **12 / 28** |
| t statistic vs zero | not computed | **0.372** |
| 95% confidence interval | — | **−0.052 to +0.077 R** |

Standard deviation of R was 0.582, giving a standard error of 0.033. A t of
0.37 is nowhere near the 1.96 needed for significance: the true expectancy
could just as easily be negative as positive.

12 of 28 symbols positive is 43% — a coin flip. The per-symbol spread runs from
+0.429 R (BTCUSDT, on 3 trades) to −0.154 R (BNBUSDT, 15 trades), which is
exactly the dispersion you get from noise around zero.

## What this means

The edge reported above was an artefact of the OKX dataset. The most likely
cause is the one already flagged as the largest open doubt: **survivorship
bias**. The symbol universe was assembled from coins that still trade today,
which quietly selects for assets that trended up over the sample.

Consequences, stated plainly:

1. **The strategy has no demonstrated edge on Bybit.** Not a small edge — an
   edge indistinguishable from zero, before any of the live-trading costs a
   backtest cannot model (outages, funding, slippage beyond the 0.02% assumed).
2. **Funding it would be gambling with extra steps.** At +0.012 R on a $1.50
   risk budget, the expected return is $0.018 per trade, or roughly four-tenths
   of a cent a day across the whole 30-symbol universe. That number is noise.
3. **The bot itself is not the problem.** Installation, credentials, order
   sizing, risk gates and the exchange connection all verified clean on the
   operator's machine. What is missing is a signal worth trading.

## What would have to change first

A strategy worth funding needs a t statistic above 2 on out-of-sample data from
the exchange it will trade on — not a promising backtest on a different venue.
Concretely, before any money goes in:

- Build the symbol universe from what was listed *at the start* of the sample,
  not what survives today, so survivorship bias is removed rather than assumed
  away.
- Find an effect large enough to clear costs at a size the account can express.
  Bybit's $5 minimum order against a $1.50 risk budget is a real constraint at
  $50.
- Re-verify on Bybit data, out-of-sample, and require significance.

Until then the honest position is that this is a working bot with nothing
profitable to run.

---

# Edge search on the full universe (2026-09-10)

After the shipped strategy came back at zero, the search widened: every Bybit
USDT perpetual (758 contracts, 479 with usable history), daily candles and
funding history from 2021-11-09 to 2026-09-10, five signals compared under one
cost model.

## Why the universe was rebuilt

The failed test used 30 symbols chosen from memory. Bybit lists 758. Picking
recognisable names selects for coins that did well enough to stay recognisable —
survivorship bias applied by hand, and the most likely source of the phantom
+0.253 R. One of those 30, MATICUSDT, returned zero bars because it has since
been delisted: the bias visible in miniature.

## First screen — five signals, three holding periods

Long the top basket, short the bottom, equal weight, funding accounted for,
0.055% taker plus 0.02% slippage per side.

Gross t statistics (before costs, which are a separable drag):

| Signal | hold 1d | hold 7d | hold 30d |
|---|---|---|---|
| momentum 30d | 0.98 | **2.40** | 0.34 |
| momentum 90d | 1.41 | 1.85 | 0.33 |
| reversal 3d | −0.28 | −2.18 | −1.02 |
| funding carry | 0.61 | −1.72 | — |
| low volatility | −1.14 | −0.04 | −0.45 |

One cell cleared 2. Fifteen were examined, so that is roughly what chance
produces — precisely the mistake that generated the first false positive.

Worth noting separately: a **daily** rebalance costs 55% a year in fees alone at
taker rates. No signal in this family survives that, independent of whether it
works.

## Second screen — trying to break the survivor

30-day momentum, weekly rebalance, examined across 26 parameter combinations:

- **Out of sample:** first half t = 0.02, second half t = 1.54, last third
  t = 1.63. The effect exists only in recent data and is not significant even
  there.
- **Lookback:** 10d t = 0.64, 20d **−0.11**, 30d 1.31, 45d **−0.70**, 60d 1.04,
  90d 0.74. The sign alternates between neighbouring parameters. A real effect
  degrades smoothly; this is the shape of noise.
- **Holding period:** consistently positive, 0.76 to 2.17, peaking at 10 days.
  The one dimension that behaves.
- **Basket size:** consistently positive, 1.31 to 1.74.
- **Liquidity:** t falls from 1.31 to 0.61 as the turnover floor rises. The
  effect lives in thinner names, where the fills a backtest assumes are least
  likely to exist.

Best t anywhere: **2.17**. Threshold after 26 looks: **≈3.6**.

## Conclusion

**No signal tested clears the bar.** Not momentum, not reversal, not funding
carry, not low volatility — on any holding period, before or after costs.

This is a real result rather than a failure to find one. Simple price-and-funding
signals on crypto perpetuals, tested against the full universe with a
significance threshold and honest costs, do not show an exploitable edge. The
strategies that appear to work in a small hand-picked backtest are the same ones
that stop working when the selection bias is removed.

## What this implies for a $50 account

Even had momentum survived, it needs 20 simultaneous positions. At Bybit's $5
minimum order that is $100 of notional against $50 of equity, and roughly 11% of
the account per year in rebalancing fees. The strategies with a plausible edge in
crypto need infrastructure (market making, latency), capital (spot-perp basis at
scale), or information (order flow, on-chain) — none of which a $50 retail API
account has.

The bot is sound and the harness now tells the truth quickly. What it does not
have is something profitable to run, and no amount of further parameter search
on this data will produce one.

## The live configuration, measured (2026-09-12)

Everything above tested candidate signals. This tests the rule the bot is
actually running, at the interval it is actually running, so the answer is
about this bot rather than about a family of ideas.

Shipped rules unchanged — EMA 21/55, 200-EMA regime filter, 1.8 ATR stop, 2R
target, maker fees both sides, a bar spanning stop and target read as the stop —
across all 758 Bybit linear USDT perpetuals, 2000 bars each.

| interval | trades | mean R | naive t | clustered t | 1st half | 2nd half |
|---|---|---|---|---|---|---|
| 360m (6h, 4/day)  | 7339 | +0.0208 | 1.25 | **−1.17** | +0.0506 (t 1.08) | −0.1624 (**t −3.91**) |
| 720m (12h, 2/day) | 5156 | +0.0460 | 2.31 | **−0.13** | +0.0301 (t 0.56) | −0.0447 (t −0.98) |

Two conclusions, and the second is the uncomfortable one.

**A faster bar is worse, not merely no better.** Going to 6h raises the trade
count by 42% and cuts mean R by more than half, and the second half of the
sample is significantly negative at t −3.91. That is not an absence of evidence;
it is evidence of a losing rule at that speed. The instinct that more trades
means more profit is exactly backwards here — the extra trades are paid for at
full price and returned at a worse expectancy.

**The 12h configuration running live has no demonstrated edge.** Its naive t of
2.31 is the number a backtest reports and it is an artefact: thirty symbols
crossing on one morning is close to one observation, not thirty, and clustering
by day collapses it to −0.13. Mean R stays positive, which is why this survived
casual inspection for as long as it did; positive mean with a clustered t of
zero is what a coin flip looks like.

So the honest description of the live bot is a correctly built, correctly
risk-limited execution of a rule whose expectation cannot be distinguished from
zero, minus fees. The engineering is sound — the missed-bar and clock-drift
defects found the same day were real and are fixed — and none of that makes the
strategy profitable. Those are separate questions and only one of them is
answered.

## Breakout, and fading it (2026-09-12)

Two more families, on the cached 6h and 12h candles across ~580 and ~490
symbols. Both mechanisms are genuinely different from the moving-average cross
tested earlier — a cross is a smoother disagreeing with itself and is late by
construction; a breakout is price itself making a new extreme.

**Following breakouts loses, significantly.** Nineteen of twenty configurations
are negative in the recent half, several clearing the corrected threshold in the
losing direction: Donchian 40 on 6h at clustered t −4.22, the squeeze variant at
mean R −0.198 with naive t −8.72. This is a finding rather than a null: over
this sample new extremes revert, and anything chasing them is fed.

**Fading them does not therefore win.** The clustered statistic flips positive,
peaking at 3.08 (12h, Donchian 20, 3R target, both halves positive) against a
corrected bar of 3.2 — and that row's mean R is +0.011. A hundredth of a risk
unit per trade is smaller than the slippage the backtest does not model.

Two readings worth keeping, because both are ways to be fooled:

**Mean R negative while clustered t is positive.** `Fade 40, 2R` on 6h: mean R
−0.030, clustered t +2.64. The average trade loses while the average day wins,
which happens when losing days carry many simultaneous trades and winning days
carry few. Clustering is the right correction for correlation, but it answers
"was this day good" and the bot holds one position at a time — it samples
trades, not days. For this bot, per-trade mean R is what becomes money, and it
is zero or negative in every row of both studies.

**Naive 4.10, clustered 0.01.** `Fade 20 + squeeze, 2R` on 12h. That single row
is the entire methodological point of this file: the number a standard backtest
reports, next to the number that survives the observation that crypto moves
together.

## Standing conclusion

Seven families now: momentum, reversal, funding carry, low volatility, EMA-cross
trend, breakout, fade-the-breakout. Across timeframes from 15m to daily, on the
full Bybit universe, with honest costs and a corrected threshold. Nothing has an
exploitable edge, and the live configuration measures at clustered t −0.13.

The bot is not the problem and improving it further will not fix this. It
executes correctly, sizes correctly, and stops out correctly; it has nothing
worth executing.
