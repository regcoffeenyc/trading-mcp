# Research scripts

Standalone studies used to decide whether a strategy is worth funding. They are
deliberately outside `src/` — they are not part of the bot, they are the
evidence that determines what the bot should run.

Run them from the `bot/` directory, in order:

```bash
node research/fetch-universe.mjs     # caches the full universe to data/research
node research/study-cross.mjs        # cross-sectional signal comparison
node research/study-funding.mjs      # funding-rate carry in detail
node research/significance.mjs       # t-test on a shipped-strategy backtest
```

## Why they exist

The first version of this bot was configured from a backtest that reported
+0.253 R per trade. Re-run against Bybit's own data it gave +0.012 R with a
t statistic of 0.37 — indistinguishable from zero. Two mistakes produced that
gap, and these scripts exist to avoid repeating them:

**Symbol selection.** The original test used 30 symbols chosen from memory.
Bybit lists 758 USDT perpetuals. Choosing recognisable names selects for coins
that did well enough to stay recognisable — survivorship bias applied by hand.
`fetch-universe.mjs` takes every listed contract instead.

**No significance test.** A mean is not evidence. With ~300 trades and an R
standard deviation near 0.6, anything below roughly 0.07 R per trade is
indistinguishable from noise. Every study here reports a t statistic, and the
verdict line says "noise" unless |t| > 2.

## What still cannot be fixed from Bybit's API

Bybit's `instruments-info` only returns *currently listed* contracts. Symbols
that were delisted are unrecoverable, so the universe still tilts toward
survivors — just far less than a hand-picked list. Treat any positive result as
an upper bound, and size accordingly.
