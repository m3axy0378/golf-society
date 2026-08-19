const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreDifferential, bestCountFor, recalculateHandicapIndex } = require('../lib/handicap');

test('scoreDifferential applies the WHS formula', () => {
  // Neutral slope (113): differential is just gross - CR.
  assert.equal(scoreDifferential(72, 70, 113), 2);
  // Tougher-than-neutral slope scales the difference down.
  assert.equal(Math.round(scoreDifferential(80, 68.7, 129) * 100) / 100, 9.9);
});

test('bestCountFor counts roughly the best half, capped at 4', () => {
  assert.equal(bestCountFor(1), 1);
  assert.equal(bestCountFor(2), 1);
  assert.equal(bestCountFor(3), 2);
  assert.equal(bestCountFor(4), 2);
  assert.equal(bestCountFor(5), 3);
  assert.equal(bestCountFor(6), 3);
  assert.equal(bestCountFor(7), 4);
  assert.equal(bestCountFor(8), 4);
  assert.equal(bestCountFor(10), 4); // never more than 4, even with more rounds available
});

test('recalculateHandicapIndex returns null with no rounds played', () => {
  assert.equal(recalculateHandicapIndex([]), null);
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

test('recalculateHandicapIndex uses the sliding scale for fewer than 8 rounds', () => {
  const rounds = [75, 80, 85].map((grossTotal) => ({ grossTotal, courseRating: 70, slopeRating: 113 }));
  // Differentials: 5, 10, 15 -> best 2 (bestCountFor(3) === 2) -> avg 7.5
  assert.equal(recalculateHandicapIndex(rounds), 7.5);
});
