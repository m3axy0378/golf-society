const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireLogin } = require('../lib/authMiddleware');
const { computeRound } = require('../lib/scoring');
const { computeSeasonStandings, rankCompetition } = require('../lib/standings');

const router = express.Router();

const FORMAT_LABELS = {
  stableford: 'Stableford',
  net_stroke: 'Stroke play (net)',
  gross_stroke: 'Stroke play (gross)',
};

async function getRoundsForCompetition(competitionId) {
  const { rows } = await db.query(
    `SELECT r.*, p.name AS player_name
     FROM rounds r JOIN players p ON p.id = r.player_id
     WHERE r.competition_id = $1`,
    [competitionId]
  );
  return rows;
}

router.get(
  '/dashboard',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows: competitions } = await db.query(
      `SELECT c.*, co.name AS course_name,
        (SELECT COUNT(*) FROM rounds r WHERE r.competition_id = c.id) AS rounds_count
       FROM competitions c JOIN courses co ON co.id = c.course_id
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
    const { rows: compRows } = await db.query(
      `SELECT c.*, co.name AS course_name, co.par AS course_par, co.course_rating, co.slope_rating, co.holes_count, co.tee_name
       FROM competitions c JOIN courses co ON co.id = c.course_id WHERE c.id = $1`,
      [req.params.id]
    );
    const comp = compRows[0];
    if (!comp) return res.status(404).render('error', { message: 'Competition not found.' });

    const { rows: holes } = await db.query(
      'SELECT hole_number, par, stroke_index FROM course_holes WHERE course_id = $1 ORDER BY hole_number',
      [comp.course_id]
    );

    const { rows: myRoundRows } = await db.query('SELECT * FROM rounds WHERE competition_id = $1 AND player_id = $2', [
      comp.id,
      req.session.playerId,
    ]);
    const myRound = myRoundRows[0] || null;

    let myHoleScores = [];
    if (myRound) {
      const { rows } = await db.query('SELECT hole_number, strokes FROM hole_scores WHERE round_id = $1 ORDER BY hole_number', [
        myRound.id,
      ]);
      myHoleScores = rows;
    }

    const rounds = await getRoundsForCompetition(comp.id);
    const ranked = rankCompetition(comp.format, rounds);
    ranked.sort((a, b) => a.rank - b.rank);

    res.render('competition', { comp, holes, myRound, myHoleScores, ranked, FORMAT_LABELS, error: null });
  })
);

router.post(
  '/competitions/:id/score',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows: compRows } = await db.query(
      `SELECT c.*, co.par AS course_par, co.course_rating, co.slope_rating, co.holes_count
       FROM competitions c JOIN courses co ON co.id = c.course_id WHERE c.id = $1`,
      [req.params.id]
    );
    const comp = compRows[0];
    if (!comp) return res.status(404).render('error', { message: 'Competition not found.' });
    if (comp.status === 'closed') {
      return res.status(400).render('error', { message: 'This competition is closed for score entry.' });
    }

    const { rows: holes } = await db.query(
      'SELECT hole_number, par, stroke_index FROM course_holes WHERE course_id = $1 ORDER BY hole_number',
      [comp.course_id]
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
      slopeRating: comp.slope_rating,
      courseRating: comp.course_rating,
      coursePar: comp.course_par,
    });

    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM rounds WHERE competition_id = $1 AND player_id = $2', [comp.id, player.id]);
      const { rows } = await client.query(
        `INSERT INTO rounds (competition_id, player_id, handicap_index_used, course_handicap, gross_total, net_total, stableford_points)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [comp.id, player.id, player.handicap_index, result.courseHandicap, result.grossTotal, result.netTotal, result.stablefordPoints]
      );
      const roundId = rows[0].id;
      for (const h of result.holeDetails) {
        await client.query('INSERT INTO hole_scores (round_id, hole_number, strokes) VALUES ($1, $2, $3)', [
          roundId,
          h.holeNumber,
          h.grossStrokes,
        ]);
      }
    });

    res.redirect(`/competitions/${comp.id}`);
  })
);

router.get(
  '/season',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows: competitions } = await db.query('SELECT id, name, format, comp_date FROM competitions ORDER BY comp_date');
    const { rows: allRounds } = await db.query(
      `SELECT r.*, p.name AS player_name
       FROM rounds r JOIN players p ON p.id = r.player_id`
    );

    const standings = computeSeasonStandings(competitions, allRounds);
    res.render('season', { standings, competitionsCount: competitions.length });
  })
);

router.get(
  '/profile',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM players WHERE id = $1', [req.session.playerId]);
    res.render('profile', { player: rows[0], message: null });
  })
);

router.post(
  '/profile',
  requireLogin,
  asyncHandler(async (req, res) => {
    const handicapIndex = parseFloat(req.body.handicapIndex);
    if (!Number.isFinite(handicapIndex)) {
      const { rows } = await db.query('SELECT * FROM players WHERE id = $1', [req.session.playerId]);
      return res.render('profile', { player: rows[0], message: 'Please enter a valid handicap index.' });
    }
    await db.query('UPDATE players SET handicap_index = $1 WHERE id = $2', [handicapIndex, req.session.playerId]);
    const { rows } = await db.query('SELECT * FROM players WHERE id = $1', [req.session.playerId]);
    res.render('profile', { player: rows[0], message: 'Handicap index updated.' });
  })
);

module.exports = router;
