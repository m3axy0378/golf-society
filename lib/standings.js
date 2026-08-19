const { strokesReceivedOnHole, stablefordPointsForHole } = require('./scoring');

/**
 * Season-long "Order of Merit" style standings that work fairly across
 * competitions played in different formats on different courses.
 *
 * For each competition we rank the players who submitted a score (best
 * result = rank 1, using the metric appropriate to that competition's
 * format), then award order-of-merit points to the top 3 only: 5 points for
 * 1st, 3 for 2nd, 1 for 3rd — everyone outside the top 3 scores 0. Players
 * level on the headline metric are separated using a standard progressive
 * countback (best inward/back 9, then back 6, back 3, then the last hole)
 * rather than sharing a rank — the same tie-break used in most real golf
 * competitions. Only players who are still level after the full countback
 * (or whose hole-by-hole data isn't available, e.g. a 9-hole course) share a
 * rank and split the points for it evenly. Points are then summed across
 * every competition a player has entered.
 */
const PLACE_POINTS = [5, 3, 1]; // index 0 = 1st, index 1 = 2nd, index 2 = 3rd

function pointsForRank(rank) {
  return PLACE_POINTS[rank - 1] || 0;
}

function metricForFormat(format, round) {
  if (format === 'stableford') return -round.stableford_points; // higher points = better = sort ascending on negative
  if (format === 'net_stroke') return round.net_total;
  return round.gross_total; // gross_stroke
}

// Per-hole value for the round in the same "lower = better" direction as
// metricForFormat, so back9/6/3/last-hole sums can be compared directly.
// Returns null when full 18-hole detail isn't available for this round.
function holeMetricSeries(format, round) {
  if (!round.holeScores || !round.courseHoles || round.courseHoles.length !== 18) return null;

  const holesByNumber = new Map(round.courseHoles.map((h) => [h.hole_number, h]));
  const strokesByNumber = new Map(round.holeScores.map((s) => [s.hole_number, s.strokes]));

  const series = [];
  for (let n = 1; n <= 18; n++) {
    const hole = holesByNumber.get(n);
    const strokes = strokesByNumber.get(n);
    if (!hole || strokes == null) return null;

    if (format === 'gross_stroke') {
      series.push(strokes);
    } else if (format === 'net_stroke') {
      const received = strokesReceivedOnHole(round.course_handicap, hole.stroke_index, 18);
      series.push(strokes - received);
    } else {
      const received = strokesReceivedOnHole(round.course_handicap, hole.stroke_index, 18);
      series.push(-stablefordPointsForHole(strokes, hole.par, received)); // negate: higher points = "lower" = better
    }
  }
  return series;
}

// [back 9, back 6, back 3, last hole] totals, lower = better throughout.
// null if the round doesn't have full 18-hole detail to count back through.
function countbackKey(format, round) {
  const series = holeMetricSeries(format, round);
  if (!series) return null;
  const sum = (from, to) => series.slice(from - 1, to).reduce((a, b) => a + b, 0);
  return [sum(10, 18), sum(13, 18), sum(16, 18), sum(18, 18)];
}

function compareCountback(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Assigns rank + shared/split orderOfMeritPoints to a block of players
// (indices lo..hi-1 of `block`) who are already known to be level with each
// other and occupy overall ranks (rankOffset+lo+1)..(rankOffset+hi).
function assignTiedBlock(block, lo, hi, rankOffset, results) {
  const ranksInGroup = [];
  for (let r = rankOffset + lo + 1; r <= rankOffset + hi; r++) ranksInGroup.push(r);
  const pointsInGroup = ranksInGroup.map(pointsForRank);
  const avgPoints = pointsInGroup.reduce((a, b) => a + b, 0) / pointsInGroup.length;
  for (let k = lo; k < hi; k++) {
    results.push({ ...block[k], rank: rankOffset + lo + 1, orderOfMeritPoints: avgPoints });
  }
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

    const groupSize = j - i;
    if (groupSize === 1) {
      assignTiedBlock(withMetric, i, j, 0, results);
      i = j;
      continue;
    }

    // Players i..j-1 are level on the headline metric — try to separate them
    // with a countback. Only do this if every one of them has full 18-hole
    // data; otherwise fall back to splitting the points across the whole group.
    const group = withMetric.slice(i, j).map((r) => ({ ...r, countback: countbackKey(format, r) }));
    if (group.every((r) => r.countback !== null)) {
      group.sort((a, b) => compareCountback(a.countback, b.countback));
      let gi = 0;
      while (gi < groupSize) {
        let gj = gi;
        while (gj < groupSize && compareCountback(group[gj].countback, group[gi].countback) === 0) gj++;
        assignTiedBlock(group, gi, gj, i, results);
        gi = gj;
      }
    } else {
      assignTiedBlock(withMetric, i, j, 0, results);
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
