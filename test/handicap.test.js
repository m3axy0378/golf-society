const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreDifferential, bestCountFor, recalculateHandicapIndex } = require('../lib/handicap');

test('scoreDifferential applies the WHS formula', () => {
  // Neutral slope (113): differential is just gross - CR.
  assert.equal(scoreDifferential(72, 70, 113), 2);
  // Tougher-than-neutral slope scales the difference down.
  assert.equal(Math.round(scoreDifferential(80, 68.7, 129) * 100) / 100, 9.9);
});

test('bestCountFor is 0 below the minimum, then always 4', () => {
  assert.equal(bestCountFor(0), 0);
  assert.equal(bestCountFor(1), 0);
  assert.equal(bestCountFor(2), 0);
  assert.equal(bestCountFor(3), 0);
  assert.equal(bestCountFor(4), 4);
  assert.equal(bestCountFor(5), 4);
  assert.equal(bestCountFor(7), 4);
  assert.equal(bestCountFor(8), 4);
  assert.equal(bestCountFor(10), 4); // never more than 4, even with more rounds available
});

test('recalculateHandicapIndex returns null with no rounds played', () => {
  assert.equal(recalculateHandicapIndex([]), null);
});

test("recalculateHandicapIndex returns null below the minimum — a new player's handicap doesn't move yet", () => {
  // 3 rounds: one short of MIN_ROUNDS_FOR_AUTO_HANDICAP (4), regardless of
  // how good or bad they were.
  const rounds = [75, 80, 85].map((grossTotal) => ({ grossTotal, courseRating: 70, slopeRating: 113 }));
  assert.equal(recalculateHandicapIndex(rounds), null);
});

test('recalculateHandicapIndex averages the best 4 of 8 rounds', () => {
  // Slope 113 everywhere -> differential is just gross - CR (70).
  const rounds = [80, 82, 84, 86, 88, 90, 92, 94].map((grossTotal) => ({
    grossTotal,
    courseRating: 70,
    slopeRating: 113,
  }));
  // Differentials: 10,12,14,16,18,20,22,24 -> best 4 = 10,12,14,16 -> avg 13.0
  assert.equal(recalculateHandicapIndex(rounds), 13);
});

test('recalculateHandicapIndex averages all 4 rounds once exactly at the minimum', () => {
  const rounds = [80, 84, 88, 92].map((grossTotal) => ({ grossTotal, courseRating: 70, slopeRating: 113 }));
  // Differentials: 10, 14, 18, 22 -> best 4 of 4 = all of them -> avg 16.0
  assert.equal(recalculateHandicapIndex(rounds), 16);
});
