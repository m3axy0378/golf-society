const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAdmin } = require('../lib/authMiddleware');

const router = express.Router();
router.use(requireAdmin);

// ---- Players ----
router.get('/players', (req, res) => {
  const players = db.prepare('SELECT * FROM players ORDER BY name').all();
  res.render('admin/players', { players, error: null, message: req.query.added ? 'Player added.' : null });
});

router.post('/players', (req, res) => {
  const { name, email, password, handicapIndex, isAdmin } = req.body;
  const players = db.prepare('SELECT * FROM players ORDER BY name').all();

  if (!name || !email || !password) {
    return res.render('admin/players', { players, error: 'Name, email and password are all required.', message: null });
  }

  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(
      'INSERT INTO players (name, email, password_hash, handicap_index, is_admin) VALUES (?, ?, ?, ?, ?)'
    ).run(name.trim(), email.trim().toLowerCase(), hash, parseFloat(handicapIndex) || 28.0, isAdmin ? 1 : 0);
    res.redirect('/admin/players?added=1');
  } catch (e) {
    res.render('admin/players', { players, error: 'That email is already registered.', message: null });
  }
});

router.post('/players/:id/handicap', (req, res) => {
  const handicapIndex = parseFloat(req.body.handicapIndex);
  if (Number.isFinite(handicapIndex)) {
    db.prepare('UPDATE players SET handicap_index = ? WHERE id = ?').run(handicapIndex, req.params.id);
  }
  res.redirect('/admin/players');
});

router.post('/players/:id/toggle-admin', (req, res) => {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  if (player) {
    db.prepare('UPDATE players SET is_admin = ? WHERE id = ?').run(player.is_admin ? 0 : 1, player.id);
  }
  res.redirect('/admin/players');
});

router.post('/players/:id/delete', (req, res) => {
  db.prepare('DELETE FROM players WHERE id = ?').run(req.params.id);
  res.redirect('/admin/players');
});

// ---- Courses ----
router.get('/courses', (req, res) => {
  const courses = db.prepare('SELECT * FROM courses ORDER BY name').all();
  res.render('admin/courses', { courses });
});

router.get('/courses/new', (req, res) => {
  res.render('admin/course-new', { error: null, welcome: req.query.welcome === '1', holesCount: 18 });
});

router.post('/courses', (req, res) => {
  const { name, teeName, courseRating, slopeRating, holesCount } = req.body;
  const n = parseInt(holesCount, 10) === 9 ? 9 : 18;

  const pars = [];
  const strokeIndexes = [];
  for (let i = 1; i <= n; i++) {
    pars.push(parseInt(req.body[`par_${i}`], 10));
    strokeIndexes.push(parseInt(req.body[`si_${i}`], 10));
  }

  const validPars = pars.every((p) => Number.isFinite(p) && p >= 3 && p <= 6);
  const siSet = new Set(strokeIndexes);
  const validSI = strokeIndexes.every((s) => Number.isFinite(s) && s >= 1 && s <= n) && siSet.size === n;

  if (!name || !Number.isFinite(parseFloat(courseRating)) || !Number.isFinite(parseInt(slopeRating, 10)) || !validPars || !validSI) {
    return res.render('admin/course-new', {
      error: `Please check every field: course name/rating/slope are required, each hole needs a par (3-6), and the stroke indexes must be a full ${n}-hole set (1-${n}, no repeats).`,
      welcome: false,
      holesCount: n,
    });
  }

  const totalPar = pars.reduce((a, b) => a + b, 0);

  const insert = db.transaction(() => {
    const info = db
      .prepare(
        'INSERT INTO courses (name, tee_name, par, course_rating, slope_rating, holes_count) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(name.trim(), (teeName || 'White').trim(), totalPar, parseFloat(courseRating), parseInt(slopeRating, 10), n);
    const courseId = info.lastInsertRowid;
    const insertHole = db.prepare('INSERT INTO course_holes (course_id, hole_number, par, stroke_index) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < n; i++) insertHole.run(courseId, i + 1, pars[i], strokeIndexes[i]);
  });
  insert();

  res.redirect('/admin/competitions/new?courseAdded=1');
});

// ---- Competitions ----
router.get('/competitions/new', (req, res) => {
  const courses = db.prepare('SELECT * FROM courses ORDER BY name').all();
  res.render('admin/competition-new', { courses, error: null, courseAdded: req.query.courseAdded === '1' });
});

router.post('/competitions', (req, res) => {
  const { name, courseId, compDate, format } = req.body;
  const courses = db.prepare('SELECT * FROM courses ORDER BY name').all();

  if (!name || !courseId || !compDate || !['stableford', 'net_stroke', 'gross_stroke'].includes(format)) {
    return res.render('admin/competition-new', { courses, error: 'Please fill in every field.', courseAdded: false });
  }

  db.prepare('INSERT INTO competitions (name, course_id, comp_date, format) VALUES (?, ?, ?, ?)').run(
    name.trim(),
    parseInt(courseId, 10),
    compDate,
    format
  );

  res.redirect('/dashboard');
});

router.post('/competitions/:id/toggle-status', (req, res) => {
  const comp = db.prepare('SELECT * FROM competitions WHERE id = ?').get(req.params.id);
  if (comp) {
    db.prepare('UPDATE competitions SET status = ? WHERE id = ?').run(comp.status === 'open' ? 'closed' : 'open', comp.id);
  }
  res.redirect(req.get('Referrer') || '/dashboard');
});

router.post('/settings/society-name', (req, res) => {
  db.setSetting('society_name', (req.body.societyName || 'Golf Society').trim());
  res.redirect('/admin/players');
});

module.exports = router;
