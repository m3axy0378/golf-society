const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireAdmin } = require('../lib/authMiddleware');
const { UK_COURSES } = require('../lib/ukCourses');

const router = express.Router();
router.use(requireAdmin);

// ---- Players ----
router.get(
  '/players',
  asyncHandler(async (req, res) => {
    const { rows: players } = await db.query('SELECT * FROM players ORDER BY name');
    res.render('admin/players', { players, error: null, message: req.query.added ? 'Player added.' : null });
  })
);

router.post(
  '/players',
  asyncHandler(async (req, res) => {
    const { name, email, password, handicapIndex, isAdmin } = req.body;
    const { rows: players } = await db.query('SELECT * FROM players ORDER BY name');

    if (!name || !email || !password) {
      return res.render('admin/players', { players, error: 'Name, email and password are all required.', message: null });
    }

    try {
      const hash = bcrypt.hashSync(password, 10);
      await db.query(
        'INSERT INTO players (name, email, password_hash, handicap_index, is_admin) VALUES ($1, $2, $3, $4, $5)',
        [name.trim(), email.trim().toLowerCase(), hash, parseFloat(handicapIndex) || 28.0, !!isAdmin]
      );
      res.redirect('/admin/players?added=1');
    } catch (e) {
      if (e.code === '23505') {
        return res.render('admin/players', { players, error: 'That email is already registered.', message: null });
      }
      throw e;
    }
  })
);

router.post(
  '/players/:id/handicap',
  asyncHandler(async (req, res) => {
    const handicapIndex = parseFloat(req.body.handicapIndex);
    if (Number.isFinite(handicapIndex)) {
      await db.query('UPDATE players SET handicap_index = $1 WHERE id = $2', [handicapIndex, req.params.id]);
    }
    res.redirect('/admin/players');
  })
);

router.post(
  '/players/:id/toggle-admin',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM players WHERE id = $1', [req.params.id]);
    const player = rows[0];
    if (player) {
      await db.query('UPDATE players SET is_admin = $1 WHERE id = $2', [!player.is_admin, player.id]);
    }
    res.redirect('/admin/players');
  })
);

router.post(
  '/players/:id/delete',
  asyncHandler(async (req, res) => {
    await db.query('DELETE FROM players WHERE id = $1', [req.params.id]);
    res.redirect('/admin/players');
  })
);

// ---- Courses ----
router.get(
  '/courses',
  asyncHandler(async (req, res) => {
    const { rows: courses } = await db.query('SELECT * FROM courses ORDER BY name');
    res.render('admin/courses', { courses });
  })
);

router.get('/courses/new', (req, res) => {
  res.render('admin/course-new', { error: null, welcome: req.query.welcome === '1', holesCount: 18, ukCourses: UK_COURSES });
});

router.post(
  '/courses',
  asyncHandler(async (req, res) => {
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
        ukCourses: UK_COURSES,
      });
    }

    const totalPar = pars.reduce((a, b) => a + b, 0);

    await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        'INSERT INTO courses (name, tee_name, par, course_rating, slope_rating, holes_count) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [name.trim(), (teeName || 'White').trim(), totalPar, parseFloat(courseRating), parseInt(slopeRating, 10), n]
      );
      const courseId = rows[0].id;
      for (let i = 0; i < n; i++) {
        await client.query('INSERT INTO course_holes (course_id, hole_number, par, stroke_index) VALUES ($1, $2, $3, $4)', [
          courseId,
          i + 1,
          pars[i],
          strokeIndexes[i],
        ]);
      }
    });

    res.redirect('/admin/competitions/new?courseAdded=1');
  })
);

// ---- Competitions ----
router.get(
  '/competitions/new',
  asyncHandler(async (req, res) => {
    const { rows: courses } = await db.query('SELECT * FROM courses ORDER BY name');
    res.render('admin/competition-new', { courses, error: null, courseAdded: req.query.courseAdded === '1' });
  })
);

router.post(
  '/competitions',
  asyncHandler(async (req, res) => {
    const { name, compDate, format } = req.body;
    const courseIds = [].concat(req.body.courseIds || []).map((id) => parseInt(id, 10)).filter(Number.isFinite);
    const { rows: courses } = await db.query('SELECT * FROM courses ORDER BY name');

    if (!name || !compDate || courseIds.length === 0 || !['stableford', 'net_stroke', 'gross_stroke'].includes(format)) {
      return res.render('admin/competition-new', {
        courses,
        error: 'Please fill in every field and choose at least one course.',
        courseAdded: false,
      });
    }

    await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        'INSERT INTO competitions (name, comp_date, format) VALUES ($1, $2, $3) RETURNING id',
        [name.trim(), compDate, format]
      );
      const compId = rows[0].id;
      for (const courseId of courseIds) {
        await client.query('INSERT INTO competition_courses (competition_id, course_id) VALUES ($1, $2)', [compId, courseId]);
      }
    });

    res.redirect('/dashboard');
  })
);

router.post(
  '/competitions/:id/toggle-status',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM competitions WHERE id = $1', [req.params.id]);
    const comp = rows[0];
    if (comp) {
      await db.query('UPDATE competitions SET status = $1 WHERE id = $2', [comp.status === 'open' ? 'closed' : 'open', comp.id]);
    }
    res.redirect(req.get('Referrer') || '/dashboard');
  })
);

router.post(
  '/settings/society-name',
  asyncHandler(async (req, res) => {
    await db.setSetting('society_name', (req.body.societyName || 'Golf Society').trim());
    res.redirect('/admin/players');
  })
);

module.exports = router;
