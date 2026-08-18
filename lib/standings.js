/**
 * Season-long "Order of Merit" style standings that work fairly across
 * competitions played in different formats on different courses.
 *
 * For each competition we rank the players who submitted a score (best
 * result = rank 1, using the metric appropriate to that competition's
 * format), then award order-of-merit points: rank 1 out of N players gets
 * N points, last place gets 1 point. Tied ranks split the points evenly.
 * Points are then summed across every competition a player has entered.
 */
function metricForFormat(format, round) {
  if (format === 'stableford') return -round.stableford_points; // higher points = better = sort ascending on negative
  if (format === 'net_stroke') return round.net_total;
  return round.gross_total; // gross_stroke
}

function rankCompetition(format, rounds) {
  const withMetric = rounds.map((r) => ({ ...r, metric: metricForFormat(format, r) }));
  withMetric.sort((a, b) => a.metric - b.metric);

  const n = withMetric.length;
  const results = [];
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && withMetric[j].metric === withMetric[i].metric) j++;
    // players at indices i..j-1 are tied, occupying ranks (i+1)..(j)
    const ranksInGroup = [];
    for (let r = i + 1; r <= j; r++) ranksInGroup.push(r);
    const pointsInGroup = ranksInGroup.map((r) => n - r + 1);
    const avgPoints = pointsInGroup.reduce((a, b) => a + b, 0) / pointsInGroup.length;
    for (let k = i; k < j; k++) {
      results.push({ ...withMetric[k], rank: i + 1, orderOfMeritPoints: avgPoints });
    }
    i = j;
  }
  return results;
}

/**
 * @param {object[]} competitions - each with { id, format }
 * @param {object[]} allRounds - each with { competition_id, player_id, player_name, gross_total, net_total, stableford_points }
 * @returns {object[]} standings sorted best-first: [{ player_id, player_name, totalPoints, competitionsPlayed }]
 */
function computeSeasonStandings(competitions, allRounds) {
  const totals = new Map();

  for (const comp of competitions) {
    const roundsForComp = allRounds.filter((r) => r.competition_id === comp.id);
    if (roundsForComp.length === 0) continue;
    const ranked = rankCompetition(comp.format, roundsForComp);
    for (const r of ranked) {
      const entry = totals.get(r.player_id) || {
        player_id: r.player_id,
        player_name: r.player_name,
        totalPoints: 0,
        competitionsPlayed: 0,
      };
      entry.totalPoints += r.orderOfMeritPoints;
      entry.competitionsPlayed += 1;
      totals.set(r.player_id, entry);
    }
  }

  return Array.from(totals.values()).sort((a, b) => b.totalPoints - a.totalPoints);
}

module.exports = { rankCompetition, computeSeasonStandings };
