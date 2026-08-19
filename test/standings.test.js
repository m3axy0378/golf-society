const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rankCompetition, computeSeasonStandings } = require('../lib/standings');

test('rankCompetition awards 5/3/1 to the clear top 3, 0 below that', () => {
  const rounds = [
    { id: 1, player_id: 1, player_name: 'A', gross_total: 70 },
    { id: 2, player_id: 2, player_name: 'B', gross_total: 75 },
    { id: 3, player_id: 3, player_name: 'C', gross_total: 80 },
    { id: 4, player_id: 4, player_name: 'D', gross_total: 85 },
  ];
  const ranked = rankCompetition('gross_stroke', rounds);
  const byPlayer = Object.fromEntries(ranked.map((r) => [r.player_id, r]));

  assert.equal(byPlayer[1].rank, 1);
  assert.equal(byPlayer[1].orderOfMeritPoints, 5);
  assert.equal(byPlayer[2].rank, 2);
  assert.equal(byPlayer[2].orderOfMeritPoints, 3);
  assert.equal(byPlayer[3].rank, 3);
  assert.equal(byPlayer[3].orderOfMeritPoints, 1);
  assert.equal(byPlayer[4].rank, 4);
  assert.equal(byPlayer[4].orderOfMeritPoints, 0);
});

test('rankCompetition splits points evenly for a tie with no hole data to count back', () => {
  const rounds = [
    { id: 1, player_id: 1, player_name: 'A', gross_total: 70 },
    { id: 2, player_id: 2, player_name: 'B', gross_total: 70 }, // tied for 1st/2nd
    { id: 3, player_id: 3, player_name: 'C', gross_total: 80 },
  ];
  const ranked = rankCompetition('gross_stroke', rounds);
  const byPlayer = Object.fromEntries(ranked.map((r) => [r.player_id, r]));

  assert.equal(byPlayer[1].rank, 1);
  assert.equal(byPlayer[1].orderOfMeritPoints, 4); // (5+3)/2
  assert.equal(byPlayer[2].rank, 1);
  assert.equal(byPlayer[2].orderOfMeritPoints, 4);
  assert.equal(byPlayer[3].rank, 3);
  assert.equal(byPlayer[3].orderOfMeritPoints, 1);
});

test('rankCompetition breaks a tie using a back-9 countback when hole data is available', () => {
  const courseHoles = Array.from({ length: 18 }, (_, i) => ({ hole_number: i + 1, par: 4, stroke_index: i + 1 }));
  // Both shoot 72 gross, but A's back 9 (36) beats B's back 9 (45).
  const holeScoresA = Array.from({ length: 18 }, (_, i) => ({ hole_number: i + 1, strokes: 4 }));
  const holeScoresB = Array.from({ length: 18 }, (_, i) => ({ hole_number: i + 1, strokes: i < 9 ? 3 : 5 }));

  const rounds = [
    { id: 1, player_id: 1, player_name: 'A', gross_total: 72, holeScores: holeScoresA, courseHoles },
    { id: 2, player_id: 2, player_name: 'B', gross_total: 72, holeScores: holeScoresB, courseHoles },
  ];
  const ranked = rankCompetition('gross_stroke', rounds);
  const byPlayer = Object.fromEntries(ranked.map((r) => [r.player_id, r]));

  assert.equal(byPlayer[1].rank, 1);
  assert.equal(byPlayer[1].orderOfMeritPoints, 5);
  assert.equal(byPlayer[2].rank, 2);
  assert.equal(byPlayer[2].orderOfMeritPoints, 3);
});

test('computeSeasonStandings doubles points for a major and sums across competitions', () => {
  const competitions = [
    { id: 1, format: 'gross_stroke', type: 'major' },
    { id: 2, format: 'gross_stroke', type: 'league' },
  ];
  const allRounds = [
    { competition_id: 1, player_id: 1, player_name: 'A', gross_total: 70 },
    { competition_id: 1, player_id: 2, player_name: 'B', gross_total: 80 },
    { competition_id: 2, player_id: 1, player_name: 'A', gross_total: 80 },
    { competition_id: 2, player_id: 2, player_name: 'B', gross_total: 70 },
  ];

  const standings = computeSeasonStandings(competitions, allRounds);
  const byPlayer = Object.fromEntries(standings.map((s) => [s.player_id, s]));

  // A: won the major (5*2=10) + came 2nd in the league (3) = 13
  assert.equal(byPlayer[1].totalPoints, 13);
  assert.equal(byPlayer[1].competitionsPlayed, 2);
  // B: 2nd in the major (3*2=6) + won the league (5) = 11
  assert.equal(byPlayer[2].totalPoints, 11);

  // Sorted best-first.
  assert.deepEqual(standings.map((s) => s.player_id), [1, 2]);
});
