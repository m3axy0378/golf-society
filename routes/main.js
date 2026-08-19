const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireLogin } = require('../lib/authMiddleware');
const { computeRound } = require('../lib/scoring');
const { bestCountFor, updatePlayerHandicap } = require('../lib/handicap');
const { computeSeasonStandings, rankCompetition } = require('../lib/standings');
const ukGolfApi = require('../lib/ukGolfApi');

const router = express.Router();

const FORMAT_LABELS = {
  stableford: 'Stableford',
  net_stroke: 'Stroke play (net)',
  gross_stroke: 'Stroke play (gross)',
};

// Attaches each round's hole-by-hole strokes and the course's hole info
// (par + stroke index) it was played on, needed for countback tie-breaking.
async function attachHoleData(rounds) {
  if (rounds.length === 0) return rounds;

  const roundIds = rounds.map((r) => r.id);
  const { rows: holeScores } = await db.query(
    'SELECT round_id, hole_number, strokes FROM hole_scores WHERE round_id = ANY($1::int[])',
    [roundIds]
  );
  const holeScoresByRound = new Map();
  for (const hs of holeScores) {
    if (!holeScoresByRound.has(hs.round_id)) holeScoresByRound.set(hs.round_id, []);
    holeScoresByRound.get(hs.round_id).push(hs);
  }

  const courseIds = [...new Set(rounds.map((r) => r.course_id).filter(Boolean))];
  const courseHolesByCourse = new Map();
  if (courseIds.length > 0) {
    const { rows: courseHoles } = await db.query(
      'SELECT course_id, hole_number, par, stroke_index FROM course_holes WHERE course_id = ANY($1::int[])',
      [courseIds]
    );
    for (const ch of courseHoles) {
      if (!courseHolesByCourse.has(ch.course_id)) courseHolesByCourse.set(ch.course_id, []);
      courseHolesByCourse.get(ch.course_id).push(ch);
    }
  }

  return rounds.map((r) => ({
    ...r,
    holeScores: holeScoresByRound.get(r.id) || [],
    courseHoles: courseHolesByCourse.get(r.course_id) || [],
  }));
}

async function getRoundsForCompetition(competitionId) {
  const { rows } = await db.query(
    `SELECT r.*, p.name AS player_name, co.name AS course_name
     FROM rounds r
     JOIN players p ON p.id = r.player_id
     LEFT JOIN courses co ON co.id = r.course_id
     WHERE r.competition_id = $1`,
    [competitionId]
  );
  return attachHoleData(rows);
}

router.get(
  '/dashboard',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows: competitions } = await db.query(
      `SELECT c.*,
        (SELECT STRING_AGG(co.name, ', ' ORDER BY co.name) FROM competition_courses cc
          JOIN courses co ON co.id = cc.course_id WHERE cc.competition_id = c.id) AS course_names,
        (SELECT COUNT(*) FROM rounds r WHERE r.competition_id = c.id) AS rounds_count
       FROM competitions c
       ORDER BY c.comp_date DESC`
    );

    const { rows: myRounds } = await db.query('SELECT competition_id FROM rounds WHERE player_id = $1', [
      req.session.playerId,
    ]);
    const myRoundCompIds = new Set(myRounds.map((r) => r.competition_id));

    res.render('dashboard', { competitions, myRoundCompIds, FORMAT_LABELS });
  })
);

router.get(
  '/competitions/:id',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows: compRows } = await db.query('SELECT * FROM competitions WHERE id = $1', [req.params.id]);
    const comp = compRows[0];
    if (!comp) return res.status(404).render('error', { message: 'Competition not found.' });

    const { rows: courses } = await db.query(
      `SELECT co.* FROM competition_courses cc
       JOIN courses co ON co.id = cc.course_id
       WHERE cc.competition_id = $1 ORDER BY co.name`,
      [comp.id]
    );

    const { rows: myRoundRows } = await db.query(
      `SELECT r.*, m.name AS marker_name
       FROM rounds r
       LEFT JOIN players m ON m.id = r.marker_id
       WHERE r.competition_id = $1 AND r.player_id = $2`,
      [comp.id, req.session.playerId]
    );
    const myRound = myRoundRows[0] || null;

    const { rows: markers } = await db.query('SELECT id, name FROM players WHERE id != $1 ORDER BY name', [
      req.session.playerId,
    ]);

    let myHoleScores = [];
    if (myRound) {
      const { rows } = await db.query('SELECT hole_number, strokes FROM hole_scores WHERE round_id = $1 ORDER BY hole_number', [
        myRound.id,
      ]);
      myHoleScores = rows;
    }

    // The course the score-entry form is scoped to: whichever course the
    // player already submitted a round for, an explicit ?course= pick, or
    // (when the competition only has one) that one by default.
    let selectedCourseId = myRound ? myRound.course_id : parseInt(req.query.course, 10);
    if (!courses.some((c) => c.id === selectedCourseId)) {
      selectedCourseId = courses.length === 1 ? courses[0].id : null;
    }
    const selectedCourse = courses.find((c) => c.id === selectedCourseId) || null;

    let holes = [];
    if (selectedCourse) {
      const { rows } = await db.query(
        'SELECT hole_number, par, stroke_index FROM course_holes WHERE course_id = $1 ORDER BY hole_number',
        [selectedCourse.id]
      );
      holes = rows;
    }

    const rounds = await getRoundsForCompetition(comp.id);
    const ranked = rankCompetition(comp.format, rounds);
    ranked.sort((a, b) => a.rank - b.rank);

    res.render('competition', { comp, courses, selectedCourse, holes, myRound, myHoleScores, markers, ranked, FORMAT_LABELS, error: null });
  })
);

router.post(
  '/competitions/:id/score',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows: compRows } = await db.query('SELECT * FROM competitions WHERE id = $1', [req.params.id]);
    const comp = compRows[0];
    if (!comp) return res.status(404).render('error', { message: 'Competition not found.' });
    if (comp.status === 'closed') {
      return res.status(400).render('error', { message: 'This competition is closed for score entry.' });
    }

    const { rows: existingRound } = await db.query('SELECT id FROM rounds WHERE competition_id = $1 AND player_id = $2', [
      comp.id,
      req.session.playerId,
    ]);
    if (existingRound[0]) {
      return res.status(400).render('error', {
        message: "You've already submitted a score for this round — scores can't be changed once saved. Ask an admin if it needs correcting.",
      });
    }

    const { rows: courses } = await db.query(
      `SELECT co.* FROM competition_courses cc JOIN courses co ON co.id = cc.course_id WHERE cc.competition_id = $1`,
      [comp.id]
    );
    const course = courses.find((c) => c.id === parseInt(req.body.courseId, 10));
    if (!course) {
      return res.status(400).render('error', { message: 'Please choose which course you played.' });
    }

    const { rows: otherPlayers } = await db.query('SELECT id FROM players WHERE id != $1', [req.session.playerId]);
    let markerId = null;
    if (otherPlayers.length > 0) {
      markerId = parseInt(req.body.markerId, 10);
      if (!Number.isFinite(markerId) || markerId === req.session.playerId || !otherPlayers.some((p) => p.id === markerId)) {
        return res.status(400).render('error', { message: 'Please select who marked your card.' });
      }
    }

    const { rows: holes } = await db.query(
      'SELECT hole_number, par, stroke_index FROM course_holes WHERE course_id = $1 ORDER BY hole_number',
      [course.id]
    );

    const grossScores = holes.map((h) => parseInt(req.body[`hole_${h.hole_number}`], 10));
    if (grossScores.some((s) => !Number.isFinite(s) || s < 1 || s > 20)) {
      return res.status(400).render('error', { message: 'Please enter a valid score (1-20) for every hole.' });
    }

    const { rows: playerRows } = await db.query('SELECT * FROM players WHERE id = $1', [req.session.playerId]);
    const player = playerRows[0];

    const result = computeRound({
      grossScores,
      holes: holes.map((h) => ({ par: h.par, strokeIndex: h.stroke_index })),
      handicapIndex: player.handicap_index,
      slopeRating: course.slope_rating,
      courseRating: course.course_rating,
      coursePar: course.par,
    });

    await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO rounds (competition_id, player_id, course_id, marker_id, handicap_index_used, course_handicap, gross_total, net_total, stableford_points)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          comp.id,
          player.id,
          course.id,
          markerId,
          player.handicap_index,
          result.courseHandicap,
          result.grossTotal,
          result.netTotal,
          result.stablefordPoints,
        ]
      );
      const roundId = rows[0].id;
      for (const h of result.holeDetails) {
        await client.query('INSERT INTO hole_scores (round_id, hole_number, strokes) VALUES ($1, $2, $3)', [
          roundId,
          h.holeNumber,
          h.grossStrokes,
        ]);
      }
      await updatePlayerHandicap(client.query.bind(client), player.id);
    });

    res.redirect(`/competitions/${comp.id}`);
  })
);

router.get(
  '/competitions/:id/add-course',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows: compRows } = await db.query('SELECT * FROM competitions WHERE id = $1', [req.params.id]);
    const comp = compRows[0];
    if (!comp) return res.status(404).render('error', { message: 'Competition not found.' });
    if (comp.status === 'closed') {
      return res.status(400).render('error', { message: 'This competition is closed, so no more courses can be added.' });
    }

    const { q, clubId, clubName, city, county } = req.query;
    let clubResults = null;
    let clubCourses = null;
    let apiError = null;

    try {
      if (clubId) {
        clubCourses = await ukGolfApi.getClubCourses(clubId);
      } else if (q) {
        clubResults = await ukGolfApi.searchClubs(q);
      }
    } catch (e) {
      apiError = 'Course search is temporarily unavailable right now — please try again shortly.';
    }

    res.render('competition-add-course', {
      comp,
      q: q || '',
      clubId: clubId || '',
      clubName: clubName || '',
      city: city || '',
      county: county || '',
      clubResults,
      clubCourses,
      apiError,
    });
  })
);

router.post(
  '/competitions/:id/add-course',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows: compRows } = await db.query('SELECT * FROM competitions WHERE id = $1', [req.params.id]);
    const comp = compRows[0];
    if (!comp) return res.status(404).render('error', { message: 'Competition not found.' });
    if (comp.status === 'closed') {
      return res.status(400).render('error', { message: 'This competition is closed, so no more courses can be added.' });
    }

    const { courseId, clubName } = req.body;
    if (!courseId) {
      return res.status(400).render('error', { message: 'Please choose a course to add.' });
    }

    let scorecard;
    try {
      scorecard = await ukGolfApi.getScorecard(courseId);
    } catch (e) {
      return res.status(502).render('error', { message: 'Could not fetch that course right now — please try again.' });
    }

    const courseName = clubName ? `${clubName} — ${scorecard.course_name}` : scorecard.course_name;
    const teeName = `${scorecard.tee_set.name}${scorecard.tee_set.gender ? ` (${scorecard.tee_set.gender})` : ''}`;
    const totalPar = scorecard.holes.reduce((sum, h) => sum + h.par, 0);

    const newCourseId = await db.withTransaction(async (client) => {
      const { rows: existing } = await client.query('SELECT id FROM courses WHERE name = $1 AND tee_name = $2', [
        courseName,
        teeName,
      ]);
      let cid = existing[0] && existing[0].id;
      if (!cid) {
        const { rows } = await client.query(
          'INSERT INTO courses (name, tee_name, par, course_rating, slope_rating, holes_count) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [
            courseName,
            teeName,
            totalPar,
            scorecard.tee_set.course_rating,
            scorecard.tee_set.slope_rating,
            scorecard.holes.length,
          ]
        );
        cid = rows[0].id;
        for (const h of scorecard.holes) {
          await client.query(
            'INSERT INTO course_holes (course_id, hole_number, par, stroke_index) VALUES ($1, $2, $3, $4)',
            [cid, h.hole_number, h.par, h.stroke_index]
          );
        }
      }
      await client.query('INSERT INTO competition_courses (competition_id, course_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
        comp.id,
        cid,
      ]);
      return cid;
    });

    res.redirect(`/competitions/${comp.id}?course=${newCourseId}`);
  })
);

router.get(
  '/season',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows: competitions } = await db.query('SELECT id, name, format, comp_date FROM competitions ORDER BY comp_date');
    const { rows: allRoundsRaw } = await db.query(
      `SELECT r.*, p.name AS player_name
       FROM rounds r JOIN players p ON p.id = r.player_id`
    );
    const allRounds = await attachHoleData(allRoundsRaw);

    const standings = computeSeasonStandings(competitions, allRounds);
    res.render('season', { standings, competitionsCount: competitions.length });
  })
);

async function getRoundsPlayed(playerId) {
  const { rows } = await db.query('SELECT COUNT(*) FROM rounds WHERE player_id = $1', [playerId]);
  return parseInt(rows[0].count, 10);
}

router.get(
  '/profile',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM players WHERE id = $1', [req.session.playerId]);
    const roundsPlayed = await getRoundsPlayed(req.session.playerId);
    res.render('profile', { player: rows[0], roundsPlayed, message: null });
  })
);

router.post(
  '/profile',
  requireLogin,
  asyncHandler(async (req, res) => {
    const roundsPlayed = await getRoundsPlayed(req.session.playerId);
    if (roundsPlayed > 0) {
      const { rows } = await db.query('SELECT * FROM players WHERE id = $1', [req.session.playerId]);
      return res.render('profile', {
        player: rows[0],
        roundsPlayed,
        message: 'Your Handicap Index is calculated automatically now and can\'t be edited by hand.',
      });
    }
    const handicapIndex = parseFloat(req.body.handicapIndex);
    if (!Number.isFinite(handicapIndex)) {
      const { rows } = await db.query('SELECT * FROM players WHERE id = $1', [req.session.playerId]);
      return res.render('profile', { player: rows[0], roundsPlayed, message: 'Please enter a valid handicap index.' });
    }
    await db.query('UPDATE players SET handicap_index = $1 WHERE id = $2', [handicapIndex, req.session.playerId]);
    const { rows } = await db.query('SELECT * FROM players WHERE id = $1', [req.session.playerId]);
    res.render('profile', { player: rows[0], roundsPlayed, message: 'Starting handicap index updated.' });
  })
);

router.get(
  '/handicaps',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows: players } = await db.query('SELECT id, name, handicap_index FROM players ORDER BY name');
    const { rows: roundRows } = await db.query(
      `SELECT r.player_id, r.gross_total, r.submitted_at, co.course_rating, co.slope_rating
       FROM rounds r JOIN courses co ON co.id = r.course_id
       ORDER BY r.submitted_at DESC`
    );

    const recentByPlayer = new Map();
    for (const r of roundRows) {
      if (!recentByPlayer.has(r.player_id)) recentByPlayer.set(r.player_id, []);
      const arr = recentByPlayer.get(r.player_id);
      if (arr.length < 8) arr.push(r);
    }

    const handicaps = players
      .map((p) => {
        const recent = recentByPlayer.get(p.id) || [];
        return {
          player_id: p.id,
          player_name: p.name,
          handicap_index: p.handicap_index,
          roundsCounted: recent.length,
          bestCount: recent.length > 0 ? bestCountFor(recent.length) : 0,
        };
      })
      .sort((a, b) => a.handicap_index - b.handicap_index);

    res.render('handicaps', { handicaps });
  })
);

module.exports = router;
