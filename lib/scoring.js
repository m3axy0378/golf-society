/**
 * Scoring & handicap maths for the golf society app.
 *
 * These follow the standard World Handicap System (WHS) approach so results
 * feel "proper", while staying self-contained (no external handicap service
 * required — every player's Handicap Index is just a number stored in the app).
 */

/**
 * Course Handicap = Handicap Index x (Slope Rating / 113) + (Course Rating - Par)
 * Rounded to the nearest whole number.
 */
function courseHandicap(handicapIndex, slopeRating, courseRating, par) {
  const raw = handicapIndex * (slopeRating / 113) + (courseRating - par);
  return Math.round(raw);
}

/**
 * Given a course handicap and a hole's stroke index (1 = hardest, 18 = easiest),
 * work out how many handicap strokes a player receives on that hole.
 * Handles course handicaps above 18 (extra strokes on the hardest holes again)
 * and negative/"plus" handicaps (strokes given back on the easiest holes).
 */
function strokesReceivedOnHole(courseHcp, strokeIndex, holesPlayed = 18) {
  if (courseHcp >= 0) {
    const base = Math.floor(courseHcp / holesPlayed);
    const extra = (courseHcp % holesPlayed) >= strokeIndex ? 1 : 0;
    return base + extra;
  }
  // Plus handicap: player gives strokes back on the easiest holes.
  const posHcp = Math.abs(courseHcp);
  const base = -Math.floor(posHcp / holesPlayed);
  const reverseIndex = holesPlayed - strokeIndex + 1; // easiest hole first
  const extra = (posHcp % holesPlayed) >= reverseIndex ? -1 : 0;
  return base + extra;
}

/**
 * Stableford points for a single hole from gross strokes, par and strokes received.
 * Net double-bogey or worse = 0 points, net bogey = 1, net par = 2, net birdie = 3,
 * net eagle = 4, net albatross = 5, and so on.
 */
function stablefordPointsForHole(grossStrokes, par, strokesReceived) {
  const netStrokes = grossStrokes - strokesReceived;
  const diff = netStrokes - par; // negative = under par
  const points = 2 - diff;
  return Math.max(0, points);
}

/**
 * Compute full results for a round given hole-by-hole gross scores and the
 * course's hole info (par + stroke index per hole).
 *
 * @param {number[]} grossScores - strokes per hole, in hole order
 * @param {{par:number, strokeIndex:number}[]} holes - course hole definitions, in hole order
 * @param {number} handicapIndex - player's current Handicap Index
 * @param {number} slopeRating
 * @param {number} courseRating
 * @param {number} coursePar
 * @returns {{courseHandicap:number, grossTotal:number, netTotal:number, stablefordPoints:number, holeDetails:object[]}}
 */
function computeRound({ grossScores, holes, handicapIndex, slopeRating, courseRating, coursePar }) {
  const holesPlayed = holes.length;
  const fullCourseHcp = courseHandicap(handicapIndex, slopeRating, courseRating, coursePar);
  // Course Handicap is defined for a full 18-hole round — for a genuine
  // 9-hole round (a Sprint competition) the standard convention is simply
  // half of the 18-hole figure, rounded to the nearest whole number.
  const courseHcp = holesPlayed === 9 ? Math.round(fullCourseHcp / 2) : fullCourseHcp;

  let grossTotal = 0;
  let stablefordPoints = 0;
  const holeDetails = holes.map((hole, i) => {
    const strokes = grossScores[i];
    grossTotal += strokes;
    const received = strokesReceivedOnHole(courseHcp, hole.strokeIndex, holesPlayed);
    const points = stablefordPointsForHole(strokes, hole.par, received);
    stablefordPoints += points;
    return {
      holeNumber: i + 1,
      par: hole.par,
      strokeIndex: hole.strokeIndex,
      grossStrokes: strokes,
      strokesReceived: received,
      netStrokes: strokes - received,
      stablefordPoints: points,
    };
  });

  const netTotal = grossTotal - courseHcp;

  return { courseHandicap: courseHcp, grossTotal, netTotal, stablefordPoints, holeDetails };
}

module.exports = {
  courseHandicap,
  strokesReceivedOnHole,
  stablefordPointsForHole,
  computeRound,
};
