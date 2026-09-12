// What would the bot have to be true of it to earn a stated monthly target?
//
// Written because "make me $50 a month from $250" is a specification, and a
// specification can be checked before anything is built around it. The check is
// arithmetic plus a simulation, not an opinion.
//
// Expected monthly return is roughly
//     trades per month  x  risk per trade  x  mean R
// so fixing the target fixes a curve through those three, and every point on
// that curve can be tested for how often it actually reaches the target and how
// often it destroys the account first. Those two are different questions: a
// setting can have the right average and still ruin most accounts that run it,
// because ruin is absorbing and the average is not.
//
//   node research/goal-feasibility.mjs
//   CAPITAL=250 TARGET=50 node research/goal-feasibility.mjs

const CAPITAL = Number(process.env.CAPITAL ?? 250);
const TARGET = Number(process.env.TARGET ?? 50);
const FLOOR = Number(process.env.FLOOR ?? 0.4);   // account considered dead below this fraction
const TRIALS = Number(process.env.TRIALS ?? 20000);
const MONTHS = Number(process.env.MONTHS ?? 12);

const targetPct = TARGET / CAPITAL;

// A 2R-target, 1.8-ATR-stop system wins less often than it loses and makes it
// back on size: mean R and win rate are tied together by the payoff.
const PAYOFF = 2;
const winRateFor = (meanR) => (meanR + 1) / (PAYOFF + 1);

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Runs TRIALS accounts for MONTHS months at a fixed fractional risk.
 * Risk is a fraction of *current* equity, which is how the bot sizes, so losses
 * shrink the next bet and the account decays rather than hitting zero cleanly.
 */
function simulate({ tradesPerMonth, riskFrac, meanR, seed = 12345 }) {
  const rand = mulberry32(seed);
  const p = winRateFor(meanR);
  let hitTargetMonths = 0, totalMonths = 0, ruined = 0;
  const finals = [];

  for (let trial = 0; trial < TRIALS; trial++) {
    let equity = CAPITAL;
    let dead = false;
    for (let m = 0; m < MONTHS && !dead; m++) {
      const start = equity;
      for (let k = 0; k < tradesPerMonth; k++) {
        const risk = equity * riskFrac;
        equity += rand() < p ? risk * PAYOFF : -risk;
        if (equity < CAPITAL * FLOOR) { dead = true; break; }
      }
      totalMonths++;
      if (!dead && equity - start >= TARGET) hitTargetMonths++;
    }
    if (dead) ruined++;
    finals.push(equity);
  }

  finals.sort((a, b) => a - b);
  return {
    winRate: p,
    monthlyHitRate: hitTargetMonths / totalMonths,
    ruinRate: ruined / TRIALS,
    median: finals[Math.floor(finals.length / 2)],
    p10: finals[Math.floor(finals.length * 0.1)],
  };
}

console.log('Goal: $' + TARGET + ' a month from $' + CAPITAL +
  '  =  ' + (targetPct * 100).toFixed(1) + '% monthly');
console.log('       compounding to ' + (((1 + targetPct) ** 12 - 1) * 100).toFixed(0) + '% a year\n');

// ---------------------------------------------------------------- what it demands

console.log('What the target demands, as mean R per trade');
console.log('(the bot currently takes roughly 4 trades a month on 12h bars)\n');
console.log('  trades/mo   risk/trade   required mean R   win rate needed');
for (const trades of [4, 8, 20, 60]) {
  for (const risk of [0.03, 0.10]) {
    const needed = targetPct / (trades * risk);
    const wr = winRateFor(needed);
    const flag = needed > 1 ? '   impossible (>1R average)'
      : wr > 0.75 ? '   implausible'
      : needed > 0.3 ? '   far above anything measured'
      : '';
    console.log('  ' + String(trades).padStart(8) + String((risk * 100).toFixed(0) + '%').padStart(12) +
      needed.toFixed(3).padStart(18) + (wr > 1 ? '     —' : (wr * 100).toFixed(0).padStart(16) + '%') + flag);
  }
}

// ---------------------------------------------------------------- what happens in practice

console.log('\n\nSimulated over ' + MONTHS + ' months, ' + TRIALS.toLocaleString() + ' accounts each.');
console.log('"Measured" is this bot\'s clustered result: no edge, mean R 0.\n');
console.log('  scenario                        risk   hit $' + TARGET + '/mo   account dead   median end');

const SCENARIOS = [
  { label: 'Measured edge (none)',        meanR: 0.00, risks: [0.03, 0.10, 0.25] },
  { label: 'A good real system (0.10R)',  meanR: 0.10, risks: [0.03, 0.10, 0.25] },
  { label: 'An excellent one (0.25R)',    meanR: 0.25, risks: [0.03, 0.10, 0.25] },
];

for (const s of SCENARIOS) {
  for (const risk of s.risks) {
    const r = simulate({ tradesPerMonth: 8, riskFrac: risk, meanR: s.meanR });
    console.log('  ' + s.label.padEnd(30) +
      String((risk * 100).toFixed(0) + '%').padStart(5) +
      (r.monthlyHitRate * 100).toFixed(1).padStart(13) + '%' +
      (r.ruinRate * 100).toFixed(1).padStart(14) + '%' +
      ('$' + r.median.toFixed(0)).padStart(13));
  }
}

console.log('\n"account dead" = equity fell below ' + (FLOOR * 100) + '% of the starting balance at any point.');
console.log('Raising risk raises the chance of a good month and raises ruin faster.');
