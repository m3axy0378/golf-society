/**
 * WHS-style Handicap Index, recalculated automatically after every round.
 *
 * Real World Handicap System: Handicap Index = average of the best 8 Score
 * Differentials from a player's last 20 rounds. This app runs a scaled-down
 * version of the same idea: best 4 Score Differentials from a player's last
 * 8 rounds. Score Differential = (113 / Slope Rating) x (Gross Score -
 * Course Rating) — the same formula WHS uses, so it's fair across courses of
 * different difficulty.
 *
 * A player's Handicap Index starts as whatever was entered for them (at
 * signup, or by an admin) and is only overwritten once they have at least
 * one submitted round — from then on it's fully automatic.
 */

function scoreDifferential(grossTotal, courseRating, slopeRating) {
  return (113 / slopeRating) * (grossTotal - courseRating);
}

// With fewer than 8 rounds played, count roughly the best half (same
// sliding-scale idea WHS uses for new players): 1-2 rounds -> best 1,
// 3-4 -> best 2, 5-6 -> best 3, 7-8 -> best 4.
function bestCountFor(roundsAvailable) {
  return Math.min(4, Math.ceil(roundsAvailable / 2));
}

/**
 * @param {{grossTotal:number, courseRating:number, slopeRating:number}[]} recentRounds
 *   A player's most recent rounds, up to 8, in any order.
 * @returns {number|null} the new Handicap Index rounded to 1 decimal, or
 *   null if recentRounds is empty (caller should leave the existing value alone).
 */
function recalculateHandicapIndex(recentRounds) {
  if (recentRounds.length === 0) return null;

  const differentials = recentRounds
    .map((r) => scoreDifferential(r.grossTotal, r.courseRating, r.slopeRating))
    .sort((a, b) => a - b);

  const count = bestCountFor(differentials.length);
  const best = differentials.slice(0, count);
  const avg = best.reduce((a, b) => a + b, 0) / best.length;
  return Math.round(avg * 10) / 10;
}

// Recalculates and saves a player's Handicap Index from their most recent 8
// rounds. `query` is a (text, params) => Promise function — pass a
// transaction client's query when called alongside a round insert/update so
// it commits or rolls back together with it.
async function updatePlayerHandicap(query, playerId) {
  const { rows } = await query(
    `SELECT r.gross_total, co.course_rating, co.slope_rating
     FROM rounds r JOIN courses co ON co.id = r.course_id
     WHERE r.player_id = $1
     ORDER BY r.submitted_at DESC
     LIMIT 8`,
    [playerId]
  );

  const newIndex = recalculateHandicapIndex(
    rows.map((r) => ({ grossTotal: r.gross_total, courseRating: r.course_rating, slopeRating: r.slope_rating }))
  );
  if (newIndex === null) return null;

  await query('UPDATE players SET handicap_index = $1 WHERE id = $2', [newIndex, playerId]);
  return newIndex;
}

module.exports = { scoreDifferential, bestCountFor, recalculateHandicapIndex, updatePlayerHandicap };
