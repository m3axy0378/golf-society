const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireAdmin } = require('../lib/authMiddleware');
const { UK_COURSES } = require('../lib/ukCourses');
const ukGolfApi = require('../lib/ukGolfApi');
const { computeRound } = require('../lib/scoring');
const { updatePlayerHandicap } = require('../lib/handicap');
const push = require('../lib/push');

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
    res.redirect(req.body.redirectTo === '/handicaps' ? '/handicaps' : '/admin/players');
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
    res.render('admin/courses', { courses, error: null });
  })
);

router.get(
  '/courses/new',
  asyncHandler(async (req, res) => {
    const { q, clubId, clubName, city, county, courseId } = req.query;
    let clubResults = null;
    let clubCourses = null;
    let liveCourse = null;
    let apiError = null;

    try {
      if (courseId) {
        const scorecard = await ukGolfApi.getScorecard(courseId);
        const region = [city, county].filter(Boolean).join(', ') || 'UK';
        liveCourse = {
          id: 'live-pick',
          name: clubName ? `${clubName} — ${scorecard.course_name}` : scorecard.course_name,
          region: `${region} · via live course search`,
          teeName: `${scorecard.tee_set.name}${scorecard.tee_set.gender ? ` (${scorecard.tee_set.gender})` : ''}`,
          courseRating: scorecard.tee_set.course_rating,
          slopeRating: scorecard.tee_set.slope_rating,
          holes: scorecard.holes.map((h) => ({ par: h.par, si: h.stroke_index })),
        };
      } else if (clubId) {
        clubCourses = await ukGolfApi.getClubCourses(clubId);
      } else if (q) {
        clubResults = await ukGolfApi.searchClubs(q);
      }
    } catch (e) {
      apiError = 'Live course search is temporarily unavailable right now — you can still use the quick picks above or fill in the form by hand.';
    }

    res.render('admin/course-new', {
      error: null,
      welcome: req.query.welcome === '1',
      holesCount: 18,
      ukCourses: liveCourse ? [...UK_COURSES, liveCourse] : UK_COURSES,
      autoSelectId: liveCourse ? liveCourse.id : null,
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
        autoSelectId: null,
        q: '',
        clubId: '',
        clubName: '',
        city: '',
        county: '',
        clubResults: null,
        clubCourses: null,
        apiError: null,
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

router.get(
  '/courses/:id/edit',
  asyncHandler(async (req, res) => {
    const { rows: courseRows } = await db.query('SELECT * FROM courses WHERE id = $1', [req.params.id]);
    const course = courseRows[0];
    if (!course) return res.status(404).render('error', { message: 'Course not found.' });

    const { rows: holes } = await db.query(
      'SELECT hole_number, par, stroke_index FROM course_holes WHERE course_id = $1 ORDER BY hole_number',
      [course.id]
    );

    res.render('admin/course-edit', { course, holes, error: null });
  })
);

router.post(
  '/courses/:id/edit',
  asyncHandler(async (req, res) => {
    const { rows: courseRows } = await db.query('SELECT * FROM courses WHERE id = $1', [req.params.id]);
    const course = courseRows[0];
    if (!course) return res.status(404).render('error', { message: 'Course not found.' });

    const { name, teeName, courseRating, slopeRating, city, county } = req.body;
    const n = course.holes_count;

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
      const { rows: holes } = await db.query(
        'SELECT hole_number, par, stroke_index FROM course_holes WHERE course_id = $1 ORDER BY hole_number',
        [course.id]
      );
      return res.render('admin/course-edit', {
        course: { ...course, name, tee_name: teeName, course_rating: parseFloat(courseRating), slope_rating: parseInt(slopeRating, 10), city, county },
        holes,
        error: `Please check every field: course name/rating/slope are required, each hole needs a par (3-6), and the stroke indexes must be a full ${n}-hole set (1-${n}, no repeats).`,
      });
    }

    const totalPar = pars.reduce((a, b) => a + b, 0);
    const newCity = (city || '').trim() || null;
    const newCounty = (county || '').trim() || null;
    // If the location changed, drop the cached lat/lon so the next weather
    // lookup re-geocodes from the new city/county instead of the old spot.
    const locationChanged = newCity !== course.city || newCounty !== course.county;

    await db.withTransaction(async (client) => {
      await client.query(
        `UPDATE courses SET name = $1, tee_name = $2, par = $3, course_rating = $4, slope_rating = $5, city = $6, county = $7
         ${locationChanged ? ', latitude = NULL, longitude = NULL' : ''}
         WHERE id = $8`,
        [name.trim(), (teeName || 'White').trim(), totalPar, parseFloat(courseRating), parseInt(slopeRating, 10), newCity, newCounty, course.id]
      );
      for (let i = 0; i < n; i++) {
        await client.query('UPDATE course_holes SET par = $1, stroke_index = $2 WHERE course_id = $3 AND hole_number = $4', [
          pars[i],
          strokeIndexes[i],
          course.id,
          i + 1,
        ]);
      }
    });

    res.redirect('/admin/courses');
  })
);

router.post(
  '/courses/:id/delete',
  asyncHandler(async (req, res) => {
    const { rows: usage } = await db.query(
      `SELECT
        (SELECT COUNT(*) FROM competition_courses WHERE course_id = $1) AS in_competitions,
        (SELECT COUNT(*) FROM rounds WHERE course_id = $1) AS in_rounds`,
      [req.params.id]
    );
    const { in_competitions, in_rounds } = usage[0];
    if (parseInt(in_competitions, 10) > 0 || parseInt(in_rounds, 10) > 0) {
      const { rows: courses } = await db.query('SELECT * FROM courses ORDER BY name');
      return res.render('admin/courses', {
        courses,
        error: "Can't delete this course — it's linked to a competition or has scores submitted for it. Remove it from any competitions first.",
      });
    }

    await db.query('DELETE FROM courses WHERE id = $1', [req.params.id]);
    res.redirect('/admin/courses');
  })
);

// ---- Competitions ----
const FORMAT_LABELS = {
  stableford: 'Stableford',
  net_stroke: 'Stroke play (net)',
  gross_stroke: 'Stroke play (gross)',
};
const TYPE_LABELS = {
  league: 'League',
  sprint: '9 Hole Sprint',
  major: 'Major (double points)',
};

async function notifyCompetition(comp, { reminder = false } = {}) {
  const closes = new Date(comp.comp_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  try {
    return await push.sendToAllPlayers({
      title: reminder ? `Reminder: ${comp.name}` : `New competition: ${comp.name}`,
      body: `Closes ${closes}`,
      url: `/competitions/${comp.id}`,
    });
  } catch (err) {
    console.error('Push notification failed:', err);
    return { sent: 0, failed: 0, configured: false };
  }
}

router.get(
  '/competitions',
  asyncHandler(async (req, res) => {
    const { rows: competitions } = await db.query(
      `SELECT c.*,
        (SELECT STRING_AGG(co.name, ', ' ORDER BY co.name) FROM competition_courses cc
          JOIN courses co ON co.id = cc.course_id WHERE cc.competition_id = c.id) AS course_names,
        (SELECT COUNT(*) FROM rounds r WHERE r.competition_id = c.id) AS rounds_count
       FROM competitions c
       ORDER BY c.comp_date DESC`
    );
    res.render('admin/competitions', { competitions, FORMAT_LABELS, TYPE_LABELS });
  })
);

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
    const type = ['sprint', 'major'].includes(req.body.type) ? req.body.type : 'league';
    const courseIds = [].concat(req.body.courseIds || []).map((id) => parseInt(id, 10)).filter(Number.isFinite);
    const { rows: courses } = await db.query('SELECT * FROM courses ORDER BY name');

    const entryFeeEnabled = req.body.entryFeeEnabled === 'on';
    const entryFeeAmount = entryFeeEnabled ? parseFloat(req.body.entryFeeAmount) : null;
    const entryFeeLink = entryFeeEnabled ? (req.body.entryFeeLink || '').trim() : null;

    if (
      !name ||
      !compDate ||
      courseIds.length === 0 ||
      !['stableford', 'net_stroke', 'gross_stroke'].includes(format) ||
      (entryFeeEnabled && (!Number.isFinite(entryFeeAmount) || entryFeeAmount <= 0 || !/^https?:\/\//.test(entryFeeLink)))
    ) {
      return res.render('admin/competition-new', {
        courses,
        error: entryFeeEnabled
          ? 'Please fill in every field, choose at least one course, and give the entry fee a valid amount and a payment link starting with http(s)://.'
          : 'Please fill in every field and choose at least one course.',
        courseAdded: false,
      });
    }

    let compId;
    await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO competitions (name, comp_date, format, type, entry_fee_enabled, entry_fee_amount, entry_fee_link)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [name.trim(), compDate, format, type, entryFeeEnabled, entryFeeAmount, entryFeeLink]
      );
      compId = rows[0].id;
      for (const courseId of courseIds) {
        await client.query('INSERT INTO competition_courses (competition_id, course_id) VALUES ($1, $2)', [compId, courseId]);
      }
    });

    await notifyCompetition({ id: compId, name: name.trim(), comp_date: compDate });

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
  '/competitions/:id/notify',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM competitions WHERE id = $1', [req.params.id]);
    const comp = rows[0];
    if (comp) await notifyCompetition(comp, { reminder: true });
    res.redirect(req.get('Referrer') || '/admin/competitions');
  })
);

router.post(
  '/competitions/:id/delete',
  asyncHandler(async (req, res) => {
    await db.query('DELETE FROM competitions WHERE id = $1', [req.params.id]);
    res.redirect('/admin/competitions');
  })
);

router.post(
  '/settings/society-name',
  asyncHandler(async (req, res) => {
    await db.setSetting('society_name', (req.body.societyName || 'Golf Society').trim());
    res.redirect('/admin/players');
  })
);

// ---- Rounds ----
// Players can't edit their own round once it's saved — this is the escape
// hatch for a genuine mistake (mis-tapped a score, wrong hole, etc).
router.get(
  '/rounds/:id/edit',
  asyncHandler(async (req, res) => {
    const { rows: roundRows } = await db.query(
      `SELECT r.*, p.name AS player_name, c.name AS comp_name, c.type AS comp_type,
              co.name AS course_name, co.par AS course_par, co.course_rating, co.slope_rating, co.tee_name
       FROM rounds r
       JOIN players p ON p.id = r.player_id
       JOIN competitions c ON c.id = r.competition_id
       JOIN courses co ON co.id = r.course_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    const round = roundRows[0];
    if (!round) return res.status(404).render('error', { message: 'Round not found.' });

    const { rows: allHoles } = await db.query(
      'SELECT hole_number, par, stroke_index FROM course_holes WHERE course_id = $1 ORDER BY hole_number',
      [round.course_id]
    );
    const holes = round.comp_type === 'sprint' ? allHoles.filter((h) => h.hole_number <= 9) : allHoles;
    const { rows: holeScores } = await db.query(
      'SELECT hole_number, strokes FROM hole_scores WHERE round_id = $1 ORDER BY hole_number',
      [round.id]
    );

    res.render('admin/round-edit', { round, holes, holeScores, error: null });
  })
);

router.post(
  '/rounds/:id/edit',
  asyncHandler(async (req, res) => {
    const { rows: roundRows } = await db.query('SELECT * FROM rounds WHERE id = $1', [req.params.id]);
    const round = roundRows[0];
    if (!round) return res.status(404).render('error', { message: 'Round not found.' });

    const { rows: courseRows } = await db.query('SELECT * FROM courses WHERE id = $1', [round.course_id]);
    const course = courseRows[0];
    const { rows: compRows0 } = await db.query('SELECT type FROM competitions WHERE id = $1', [round.competition_id]);
    const { rows: allHoles } = await db.query(
      'SELECT hole_number, par, stroke_index FROM course_holes WHERE course_id = $1 ORDER BY hole_number',
      [course.id]
    );
    const holes = compRows0[0].type === 'sprint' ? allHoles.filter((h) => h.hole_number <= 9) : allHoles;

    const grossScores = holes.map((h) => parseInt(req.body[`hole_${h.hole_number}`], 10));
    if (grossScores.some((s) => !Number.isFinite(s) || s < 1 || s > 20)) {
      const { rows: playerRows } = await db.query('SELECT name FROM players WHERE id = $1', [round.player_id]);
      const { rows: compRows } = await db.query('SELECT name FROM competitions WHERE id = $1', [round.competition_id]);
      const { rows: holeScores } = await db.query(
        'SELECT hole_number, strokes FROM hole_scores WHERE round_id = $1 ORDER BY hole_number',
        [round.id]
      );
      return res.status(400).render('admin/round-edit', {
        round: {
          ...round,
          player_name: playerRows[0].name,
          comp_name: compRows[0].name,
          course_name: course.name,
          tee_name: course.tee_name,
          course_par: course.par,
          course_rating: course.course_rating,
          slope_rating: course.slope_rating,
        },
        holes,
        holeScores,
        error: 'Please enter a valid score (1-20) for every hole.',
      });
    }

    const { rows: playerRows } = await db.query('SELECT * FROM players WHERE id = $1', [round.player_id]);
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
      await client.query(
        `UPDATE rounds SET handicap_index_used = $1, course_handicap = $2, gross_total = $3, net_total = $4, stableford_points = $5
         WHERE id = $6`,
        [player.handicap_index, result.courseHandicap, result.grossTotal, result.netTotal, result.stablefordPoints, round.id]
      );
      await client.query('DELETE FROM hole_scores WHERE round_id = $1', [round.id]);
      for (const h of result.holeDetails) {
        await client.query('INSERT INTO hole_scores (round_id, hole_number, strokes) VALUES ($1, $2, $3)', [
          round.id,
          h.holeNumber,
          h.grossStrokes,
        ]);
      }
      await updatePlayerHandicap(client.query.bind(client), round.player_id);
    });

    res.redirect(`/competitions/${round.competition_id}`);
  })
);

// ---- Pairing sheets ----
router.get(
  '/competitions/:id/pairings',
  asyncHandler(async (req, res) => {
    const { rows: compRows } = await db.query('SELECT * FROM competitions WHERE id = $1', [req.params.id]);
    const comp = compRows[0];
    if (!comp) return res.status(404).render('error', { message: 'Competition not found.' });

    const { rows: entrants } = await db.query(
      `SELECT p.id, p.name, p.handicap_index
       FROM entries e JOIN players p ON p.id = e.player_id
       WHERE e.competition_id = $1 ORDER BY p.name`,
      [comp.id]
    );

    const { rows: existing } = await db.query(
      'SELECT player_id, group_number, tee_time FROM pairing_groups WHERE competition_id = $1 ORDER BY group_number',
      [comp.id]
    );

    res.render('admin/pairings', { comp, entrants, existing, error: null });
  })
);

router.post(
  '/competitions/:id/pairings',
  asyncHandler(async (req, res) => {
    const { rows: compRows } = await db.query('SELECT * FROM competitions WHERE id = $1', [req.params.id]);
    const comp = compRows[0];
    if (!comp) return res.status(404).json({ error: 'Competition not found.' });

    let groups;
    try {
      groups = JSON.parse(req.body.groups);
    } catch {
      return res.status(400).json({ error: 'Malformed pairing data.' });
    }
    if (!Array.isArray(groups)) return res.status(400).json({ error: 'Malformed pairing data.' });

    const { rows: validEntrants } = await db.query('SELECT player_id FROM entries WHERE competition_id = $1', [comp.id]);
    const validIds = new Set(validEntrants.map((e) => e.player_id));

    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM pairing_groups WHERE competition_id = $1', [comp.id]);
      for (let g = 0; g < groups.length; g++) {
        const group = groups[g];
        const teeTime = typeof group.teeTime === 'string' ? group.teeTime.slice(0, 5) : null;
        const playerIds = Array.isArray(group.playerIds) ? group.playerIds : [];
        for (const playerId of playerIds) {
          const id = parseInt(playerId, 10);
          if (!validIds.has(id)) continue;
          await client.query(
            'INSERT INTO pairing_groups (competition_id, player_id, group_number, tee_time) VALUES ($1, $2, $3, $4)',
            [comp.id, id, g + 1, teeTime]
          );
        }
      }
    });

    res.json({ ok: true });
  })
);

router.post(
  '/entries/:id/toggle-paid',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT entry_fee_paid FROM entries WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Entry not found.' });

    const paid = !rows[0].entry_fee_paid;
    await db.query('UPDATE entries SET entry_fee_paid = $1 WHERE id = $2', [paid, req.params.id]);
    res.json({ paid });
  })
);

module.exports = router;
