const { test } = require('node:test');
const assert = require('node:assert/strict');
const { courseHandicap, strokesReceivedOnHole, stablefordPointsForHole, computeRound } = require('../lib/scoring');

test('courseHandicap matches the WHS formula', () => {
  // Real example: 12.5 index, Dullatur Antonine whites (par 69, CR 68.7, SR 129).
  assert.equal(courseHandicap(12.5, 129, 68.7, 69), 14);
  // Slope 113 (the "neutral" slope) and CR == par should give back the raw index untouched.
  assert.equal(courseHandicap(20, 113, 72, 72), 20);
});

test('strokesReceivedOnHole spreads strokes across holes by stroke index', () => {
  // Course handicap == holes played: exactly one stroke on every hole.
  assert.equal(strokesReceivedOnHole(18, 1, 18), 1);
  assert.equal(strokesReceivedOnHole(18, 18, 18), 1);

  // Course handicap 20 over 18 holes: the two hardest holes (SI 1-2) get a second stroke.
  assert.equal(strokesReceivedOnHole(20, 1, 18), 2);
  assert.equal(strokesReceivedOnHole(20, 2, 18), 2);
  assert.equal(strokesReceivedOnHole(20, 3, 18), 1);

  // Course handicap 9 over 18 holes: only the 9 hardest holes get a stroke.
  assert.equal(strokesReceivedOnHole(9, 9, 18), 1);
  assert.equal(strokesReceivedOnHole(9, 10, 18), 0);
});

test('strokesReceivedOnHole gives strokes back on the easiest holes for a plus handicap', () => {
  assert.equal(strokesReceivedOnHole(-3, 1, 18), 0); // hardest hole: nothing given back
  assert.equal(strokesReceivedOnHole(-3, 18, 18), -1); // easiest hole: a stroke given back
});

test('stablefordPointsForHole scores net par as 2, and floors at 0', () => {
  assert.equal(stablefordPointsForHole(4, 4, 0), 2); // net par
  assert.equal(stablefordPointsForHole(3, 4, 0), 3); // net birdie
  assert.equal(stablefordPointsForHole(5, 4, 0), 1); // net bogey
  assert.equal(stablefordPointsForHole(7, 4, 0), 0); // net triple+ floors at 0, never negative
  assert.equal(stablefordPointsForHole(6, 4, 1), 1); // a received stroke reduces net score
});

test('computeRound totals gross, net and stableford across a full round', () => {
  const holes = [
    { par: 4, strokeIndex: 1 },
    { par: 4, strokeIndex: 2 },
    { par: 4, strokeIndex: 3 },
  ];
  // Handicap index 9, slope 113 (no adjustment), CR == par (12) -> course handicap 9.
  // 9 strokes over 3 holes = exactly 3 strokes received on every hole.
  const result = computeRound({
    grossScores: [6, 5, 7],
    holes,
    handicapIndex: 9,
    slopeRating: 113,
    courseRating: 12,
    coursePar: 12,
  });

  assert.equal(result.courseHandicap, 9);
  assert.equal(result.grossTotal, 18);
  assert.equal(result.netTotal, 9); // 18 gross - 9 course handicap
  // Net per hole: 6-3=3 (birdie, 3pts), 5-3=2 (eagle, 4pts), 7-3=4 (par, 2pts) -> 9pts
  assert.equal(result.stablefordPoints, 9);
});

test('computeRound halves the course handicap for a genuine 9-hole round', () => {
  const holes = Array.from({ length: 9 }, (_, i) => ({ par: 4, strokeIndex: i + 1 }));
  // Handicap index 18, slope 113 (no adjustment), CR == par -> full 18-hole
  // course handicap is 18, so the 9-hole figure should be halved to 9.
  const result = computeRound({
    grossScores: Array(9).fill(4), // all pars
    holes,
    handicapIndex: 18,
    slopeRating: 113,
    courseRating: 36,
    coursePar: 36,
  });

  assert.equal(result.courseHandicap, 9);
  assert.equal(result.grossTotal, 36);
  assert.equal(result.netTotal, 27); // 36 gross - 9 (halved) course handicap
  // 9 handicap over 9 holes = 1 stroke every hole; net par-1 (birdie) = 3pts x 9 holes.
  assert.equal(result.stablefordPoints, 27);
});
