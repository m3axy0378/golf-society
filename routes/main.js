const express = require('express');
const db = require('../db');
const { requireLogin } = require('../lib/authMiddleware');
const { computeRound } = require('../lib/scoring');
const { computeSeasonStandings, rankCompetition } = require('../lib/standings');

const router = express.Router();

const FORMAT_LABELS = {
  stableford: 'Stableford',
  net_stroke: 'Stroke play (net)',
  gross_stroke: 'Stroke play (gross)',
};

function getRoundsForCompetition(competitionId) {
  return db
    .prepare(
      `SELECT r.*, p.name AS player_name
       FROM rounds r JOIN players p ON p.id = r.player_id
       WHERE r.competition_id = ?`
    )
    .all(competitionId);
}

router.get('/dashboard', requireLogin, (req, res) => {
  const competitions = db
    .prepare(
      `SELECT c.*, co.name AS course_name,
        (SELECT COUNT(*) FROM rounds r WHERE r.competition_id = c.id) AS rounds_count
       FROM competitions c JOIN courses co ON co.id = c.course_id
       ORDER BY c.comp_date DESC`
    )
    .all();

  const myRoundCompIds = new Set(
    db.prepare('SELECT competition_id FROM rounds WHERE player_id = ?').all(req.session.playerId).map((r) => r.competition_id)
  );

  res.render('dashboard', {
    competitions,
    myRoundCompIds,
    FORMAT_LABELS,
  });
});

router.get('/competitions/:id', requireLogin, (req, res) => {
  const comp = db
    .prepare(
      `SELECT c.*, co.name AS course_name, co.par AS course_par, co.course_rating, co.slope_rating, co.holes_count, co.tee_name
       FROM competitions c JOIN courses co ON co.id = c.course_id WHERE c.id = ?`
    )
    .get(req.params.id);
  if (!comp) return res.status(404).render('error', { message: 'Competition not found.' });

  const holes = db
    .prepare('SELECT hole_number, par, stroke_index FROM course_holes WHERE course_id = ? ORDER BY hole_number')
    .all(comp.course_id);

  const myRound = db
    .prepare('SELECT * FROM rounds WHERE competition_id = ? AND player_id = ?')
    .get(comp.id, req.session.playerId);

  let myHoleScores = [];
  if (myRound) {
    myHoleScores = db
      .prepare('SELECT hole_number, strokes FROM hole_scores WHERE round_id = ? ORDER BY hole_number')
      .all(myRound.id);
  }

  const rounds = getRoundsForCompetition(comp.id);
  const ranked = rankCompetition(comp.format, rounds);
  ranked.sort((a, b) => a.rank - b.rank);

  res.render('competition', {
    comp,
    holes,
    myRound,
    myHoleScores,
    ranked,
    FORMAT_LABELS,
    error: null,
  });
});

router.post('/competitions/:id/score', requireLogin, (req, res) => {
  const comp = db
    .prepare(
      `SELECT c.*, co.par AS course_par, co.course_rating, co.slope_rating, co.holes_count
       FROM competitions c JOIN courses co ON co.id = c.course_id WHERE c.id = ?`
    )
    .get(req.params.id);
  if (!comp) return res.status(404).render('error', { message: 'Competition not found.' });
  if (comp.status === 'closed') {
    return res.status(400).render('error', { message: 'This competition is closed for score entry.' });
  }

  const holes = db
    .prepare('SELECT hole_number, par, stroke_index FROM course_holes WHERE course_id = ? ORDER BY hole_number')
    .all(comp.course_id);

  const grossScores = holes.map((h) => parseInt(req.body[`hole_${h.hole_number}`], 10));
  if (grossScores.some((s) => !Number.isFinite(s) || s < 1 || s > 20)) {
    return res.status(400).render('error', { message: 'Please enter a valid score (1-20) for every hole.' });
  }

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.session.playerId);

  const result = computeRound({
    grossScores,
    holes: holes.map((h) => ({ par: h.par, strokeIndex: h.stroke_index })),
    handicapIndex: player.handicap_index,
    slopeRating: comp.slope_rating,
    courseRating: comp.course_rating,
    coursePar: comp.course_par,
  });

  const upsert = db.transaction(() => {
    db.prepare('DELETE FROM rounds WHERE competition_id = ? AND player_id = ?').run(comp.id, player.id);
    const info = db
      .prepare(
        `INSERT INTO rounds (competition_id, player_id, handicap_index_used, course_handicap, gross_total, net_total, stableford_points)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(comp.id, player.id, player.handicap_index, result.courseHandicap, result.grossTotal, result.netTotal, result.stablefordPoints);

    const roundId = info.lastInsertRowid;
    const insertHole = db.prepare('INSERT INTO hole_scores (round_id, hole_number, strokes) VALUES (?, ?, ?)');
    result.holeDetails.forEach((h) => insertHole.run(roundId, h.holeNumber, h.grossStrokes));
  });
  upsert();

  res.redirect(`/competitions/${comp.id}`);
});

router.get('/season', requireLogin, (req, res) => {
  const competitions = db.prepare('SELECT id, name, format, comp_date FROM competitions ORDER BY comp_date').all();
  const allRounds = db
    .prepare(
      `SELECT r.*, p.name AS player_name
       FROM rounds r JOIN players p ON p.id = r.player_id`
    )
    .all();

  const standings = computeSeasonStandings(competitions, allRounds);
  res.render('season', { standings, competitionsCount: competitions.length });
});

router.get('/profile', requireLogin, (req, res) => {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.session.playerId);
  res.render('profile', { player, message: null });
});

router.post('/profile', requireLogin, (req, res) => {
  const handicapIndex = parseFloat(req.body.handicapIndex);
  if (!Number.isFinite(handicapIndex)) {
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.session.playerId);
    return res.render('profile', { player, message: 'Please enter a valid handicap index.' });
  }
  db.prepare('UPDATE players SET handicap_index = ? WHERE id = ?').run(handicapIndex, req.session.playerId);
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.session.playerId);
  res.render('profile', { player, message: 'Handicap index updated.' });
});

module.exports = router;
