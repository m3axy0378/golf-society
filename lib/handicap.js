/**
 * WHS-style Handicap Index, recalculated automatically after every round —
 * but only once a player has enough rounds behind them for an average to
 * mean anything.
 *
 * Real World Handicap System: Handicap Index = average of the best 8 Score
 * Differentials from a player's last 20 rounds. This app runs a scaled-down
 * version of the same idea: best 4 Score Differentials from a player's last
 * 8 rounds. Score Differential = (113 / Slope Rating) x (Gross Score -
 * Course Rating) — the same formula WHS uses, so it's fair across courses of
 * different difficulty.
 *
 * A player's Handicap Index starts as whatever was entered for them (at
 * signup, or by an admin) and stays exactly that — untouched by any round
 * they play — until they've submitted MIN_ROUNDS_FOR_AUTO_HANDICAP rounds.
 * A single good or bad round shouldn't be able to swing a brand new
 * player's number; once there's enough of a sample to average, it becomes
 * fully automatic and can move up or down after every round from then on.
 */

const MIN_ROUNDS_FOR_AUTO_HANDICAP = 4;

// Once a player has enough rounds to go automatic, it's always the best 4
// of however many of their last 8 rounds are available (never fewer) —
// unlike WHS's own sliding scale for newer players, which this app doesn't
// need since anyone below the minimum isn't being averaged at all yet.
function bestCountFor(roundsAvailable) {
  return roundsAvailable < MIN_ROUNDS_FOR_AUTO_HANDICAP ? 0 : 4;
}

/**
 * @param {{grossTotal:number, courseRating:number, slopeRating:number}[]} recentRounds
 *   A player's most recent rounds, up to 8, in any order.
 * @returns {number|null} the new Handicap Index rounded to 1 decimal, or
 *   null if recentRounds has fewer than MIN_ROUNDS_FOR_AUTO_HANDICAP rounds
 *   (caller should leave the existing value alone).
 */
function recalculateHandicapIndex(recentRounds) {
  if (recentRounds.length < MIN_ROUNDS_FOR_AUTO_HANDICAP) return null;

  const differentials = recentRounds
    .map((r) => scoreDifferential(r.grossTotal, r.courseRating, r.slopeRating))
    .sort((a, b) => a - b);

  const best = differentials.slice(0, 4);
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
     FROM rounds r
     JOIN courses co ON co.id = r.course_id
     JOIN competitions c ON c.id = r.competition_id
     WHERE r.player_id = $1 AND c.type != 'sprint'
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

module.exports = { scoreDifferential, bestCountFor, recalculateHandicapIndex, updatePlayerHandicap, MIN_ROUNDS_FOR_AUTO_HANDICAP };
