const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireLogin } = require('../lib/authMiddleware');
const { computeRound, strokesReceivedOnHole, stablefordPointsForHole } = require('../lib/scoring');
const { getWeatherForCourse } = require('../lib/courseWeather');
const { bestCountFor, updatePlayerHandicap } = require('../lib/handicap');
const { computeSeasonStandings, rankCompetition, metricForFormat } = require('../lib/standings');
const ukGolfApi = require('../lib/ukGolfApi');

const router = express.Router();

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
const REACTION_EMOJIS = ['⛳', '🔥', '😂', '👏', '😭', '💩', '🏆'];

async function getReactionsByRound(roundIds, currentPlayerId) {
  if (roundIds.length === 0) return {};
  const { rows } = await db.query(
    `SELECT round_id, emoji, COUNT(*)::int AS count, BOOL_OR(player_id = $2) AS reacted_by_me
     FROM round_reactions
     WHERE round_id = ANY($1::int[])
     GROUP BY round_id, emoji`,
    [roundIds, currentPlayerId]
  );
  const byRound = {};
  for (const r of rows) {
    if (!byRound[r.round_id]) byRound[r.round_id] = {};
    byRound[r.round_id][r.emoji] = { count: r.count, reactedByMe: r.reacted_by_me };
  }
  return byRound;
}

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

    const { rows: myEntries } = await db.query('SELECT competition_id FROM entries WHERE player_id = $1', [
      req.session.playerId,
    ]);
    const myEntryCompIds = new Set(myEntries.map((e) => e.competition_id));

    res.render('dashboard', { competitions, myEntryCompIds, FORMAT_LABELS, TYPE_LABELS });
  })
);

router.get(
  '/competitions/:id',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows: compRows } = await db.query('SELECT * FROM competitions WHERE id = $1', [req.params.id]);
    const comp = compRows[0];
    if (!comp) return res.status(404).render('error', { message: 'Competition not found.' });

    // Picking a course from the "other saved courses" part of the picker
    // below attaches it to this competition right away — same thing "+ Add
    // my course" does, just without the extra page for a course that's
    // already saved somewhere in the app.
    const queriedCourseId = parseInt(req.query.course, 10);
    if (comp.status === 'open' && Number.isFinite(queriedCourseId)) {
      const { rows: courseExists } = await db.query('SELECT id FROM courses WHERE id = $1', [queriedCourseId]);
      if (courseExists[0]) {
        await db.query('INSERT INTO competition_courses (competition_id, course_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
          comp.id,
          queriedCourseId,
        ]);
      }
    }

    const { rows: courses } = await db.query(
      `SELECT co.* FROM competition_courses cc
       JOIN courses co ON co.id = cc.course_id
       WHERE cc.competition_id = $1 ORDER BY co.name`,
      [comp.id]
    );
    const { rows: otherCourses } = await db.query(
      `SELECT * FROM courses
       WHERE id NOT IN (SELECT course_id FROM competition_courses WHERE competition_id = $1)
       ORDER BY name`,
      [comp.id]
    );

    // Best-effort — a course whose location can't be resolved, or a date
    // with no weather data available yet, just gets no entry in the map.
    const weatherByCourseId = {};
    await Promise.all(
      courses.map(async (c) => {
        const w = await getWeatherForCourse(c, comp.comp_date);
        if (w) weatherByCourseId[c.id] = w;
      })
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
      // A 9 Hole Sprint only ever plays the front 9, however many holes the
      // underlying course actually has on file.
      holes = comp.type === 'sprint' ? rows.filter((h) => h.hole_number <= 9) : rows;
    }

    const rounds = await getRoundsForCompetition(comp.id);
    const ranked = rankCompetition(comp.format, rounds);
    ranked.sort((a, b) => a.rank - b.rank);

    const reactionsByRound = await getReactionsByRound(ranked.map((r) => r.id), req.session.playerId);

    // Every player who's entered this competition, whether they've submitted
    // a score yet or not — drives the "entered, not yet played" rows at the
    // bottom of the leaderboard and the entry-fee payment tracking below.
    const { rows: allEntries } = await db.query(
      `SELECT e.id, e.player_id, p.name AS player_name, e.entry_fee_paid, e.entered_at, r.id AS round_id
       FROM entries e
       JOIN players p ON p.id = e.player_id
       LEFT JOIN rounds r ON r.competition_id = e.competition_id AND r.player_id = e.player_id
       WHERE e.competition_id = $1
       ORDER BY e.entered_at`,
      [comp.id]
    );
    const pendingEntries = allEntries.filter((e) => !e.round_id);
    const hasEntered = allEntries.some((e) => e.player_id === req.session.playerId);

    res.render('competition', {
      comp,
      courses,
      otherCourses,
      selectedCourse,
      holes,
      myRound,
      myHoleScores,
      markers,
      ranked,
      FORMAT_LABELS,
      TYPE_LABELS,
      REACTION_EMOJIS,
      reactionsByRound,
      allEntries,
      pendingEntries,
      hasEntered,
      weatherByCourseId,
      error: null,
    });
  })
);

router.post(
  '/competitions/:id/enter',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows: compRows } = await db.query('SELECT * FROM competitions WHERE id = $1', [req.params.id]);
    const comp = compRows[0];
    if (!comp) return res.status(404).render('error', { message: 'Competition not found.' });
    if (comp.status === 'closed') {
      return res.status(400).render('error', { message: 'This competition is closed for entry.' });
    }

    await db.query('INSERT INTO entries (competition_id, player_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      comp.id,
      req.session.playerId,
    ]);

    res.redirect(`/competitions/${comp.id}`);
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

    const { rows: allHoles } = await db.query(
      'SELECT hole_number, par, stroke_index FROM course_holes WHERE course_id = $1 ORDER BY hole_number',
      [course.id]
    );
    // A 9 Hole Sprint only ever plays the front 9, however many holes the
    // underlying course actually has on file.
    const holes = comp.type === 'sprint' ? allHoles.filter((h) => h.hole_number <= 9) : allHoles;

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
      // A player who goes straight to scoring without clicking "Enter
      // competition" first still counts as entered — this just fills in the
      // record retroactively rather than requiring the extra step.
      await client.query('INSERT INTO entries (competition_id, player_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
        comp.id,
        player.id,
      ]);

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

router.post(
  '/rounds/:id/react',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { emoji } = req.body;
    if (!REACTION_EMOJIS.includes(emoji)) return res.status(400).json({ error: 'Invalid reaction.' });

    const { rows: existing } = await db.query(
      'SELECT id FROM round_reactions WHERE round_id = $1 AND player_id = $2 AND emoji = $3',
      [req.params.id, req.session.playerId, emoji]
    );
    if (existing[0]) {
      await db.query('DELETE FROM round_reactions WHERE id = $1', [existing[0].id]);
    } else {
      await db.query(
        'INSERT INTO round_reactions (round_id, player_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [req.params.id, req.session.playerId, emoji]
      );
    }

    const { rows: countRow } = await db.query('SELECT COUNT(*)::int AS count FROM round_reactions WHERE round_id = $1 AND emoji = $2', [
      req.params.id,
      emoji,
    ]);
    res.json({ emoji, count: countRow[0].count, reactedByMe: !existing[0] });
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

    const { rows: availableCourses } = await db.query(
      `SELECT * FROM courses
       WHERE id NOT IN (SELECT course_id FROM competition_courses WHERE competition_id = $1)
       ORDER BY name`,
      [comp.id]
    );

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
      availableCourses,
    });
  })
);

router.post(
  '/competitions/:id/add-existing-course',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows: compRows } = await db.query('SELECT * FROM competitions WHERE id = $1', [req.params.id]);
    const comp = compRows[0];
    if (!comp) return res.status(404).render('error', { message: 'Competition not found.' });
    if (comp.status === 'closed') {
      return res.status(400).render('error', { message: 'This competition is closed, so no more courses can be added.' });
    }

    const courseId = parseInt(req.body.courseId, 10);
    const { rows: courseRows } = await db.query('SELECT id FROM courses WHERE id = $1', [courseId]);
    if (!courseRows[0]) {
      return res.status(400).render('error', { message: 'Please choose a course to add.' });
    }

    await db.query('INSERT INTO competition_courses (competition_id, course_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      comp.id,
      courseId,
    ]);

    res.redirect(`/competitions/${comp.id}?course=${courseId}`);
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
    const { rows: competitions } = await db.query(
      "SELECT id, name, format, comp_date, type FROM competitions WHERE type != 'sprint' ORDER BY comp_date"
    );
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
  const { rows } = await db.query(
    `SELECT COUNT(*) FROM rounds r JOIN competitions c ON c.id = r.competition_id
     WHERE r.player_id = $1 AND c.type != 'sprint'`,
    [playerId]
  );
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
      `SELECT r.player_id, r.gross_total, r.handicap_index_used, r.submitted_at, co.course_rating, co.slope_rating
       FROM rounds r
       JOIN courses co ON co.id = r.course_id
       JOIN competitions c ON c.id = r.competition_id
       WHERE c.type != 'sprint'
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
        // Trend = current handicap vs. what it was going into their most
        // recent round (handicap_index_used is the value before that round's
        // result got folded into the rolling average).
        let trend = null;
        if (recent.length > 0) {
          if (p.handicap_index < recent[0].handicap_index_used) trend = 'down';
          else if (p.handicap_index > recent[0].handicap_index_used) trend = 'up';
          else trend = 'flat';
        }
        return {
          player_id: p.id,
          player_name: p.name,
          handicap_index: p.handicap_index,
          roundsCounted: recent.length,
          bestCount: recent.length > 0 ? bestCountFor(recent.length) : 0,
          trend,
        };
      })
      .sort((a, b) => a.handicap_index - b.handicap_index);

    res.render('handicaps', { handicaps });
  })
);

router.get(
  '/stats',
  requireLogin,
  asyncHandler(async (req, res) => {
    const playerId = req.session.playerId;

    const { rows: myRounds } = await db.query(
      `SELECT r.*, c.name AS comp_name, c.type AS comp_type, c.format AS comp_format, c.comp_date,
              co.name AS course_name
       FROM rounds r
       JOIN competitions c ON c.id = r.competition_id
       JOIN courses co ON co.id = r.course_id
       WHERE r.player_id = $1
       ORDER BY c.comp_date DESC, r.submitted_at DESC`,
      [playerId]
    );

    // Chronological (oldest first) for the trend line, using every round —
    // it's just a record of what the player's handicap actually was at the
    // time, regardless of competition type. handicap_index_used is always the
    // handicap going INTO that round, so on its own the series stops one step
    // short of reality — it never shows what the most recent round actually
    // did to their handicap. Appending the player's current (post-recalc)
    // handicap_index as a final "now" point closes that gap, and is also
    // what turns a single-round player's trend from 1 point (too few to
    // draw a line) into a real 2-point before/after picture.
    const handicapTrend = [...myRounds]
      .reverse()
      .map((r) => ({ date: r.comp_date, handicapIndex: r.handicap_index_used }));
    handicapTrend.push({ date: new Date(), handicapIndex: res.locals.currentPlayer.handicap_index });

    // Sprint rounds are only 9 holes, so mixing them into "best/worst" or an
    // average against full 18-hole rounds would be comparing apples to oranges.
    const rankedRounds = myRounds.filter((r) => r.comp_type !== 'sprint');
    let bestRound = null;
    let worstRound = null;
    for (const r of rankedRounds) {
      if (!bestRound || r.stableford_points > bestRound.stableford_points) bestRound = r;
      if (!worstRound || r.stableford_points < worstRound.stableford_points) worstRound = r;
    }
    const avgPoints = rankedRounds.length
      ? rankedRounds.reduce((sum, r) => sum + r.stableford_points, 0) / rankedRounds.length
      : null;

    // Head-to-head: every competition both this player and another player
    // both submitted a score for, decided the same way the leaderboard
    // itself decides a winner (the format-appropriate metric).
    const { rows: sharedRounds } = await db.query(
      `SELECT r.competition_id, r.player_id, r.gross_total, r.net_total, r.stableford_points,
              c.format AS comp_format, p.name AS player_name
       FROM rounds r
       JOIN competitions c ON c.id = r.competition_id
       JOIN players p ON p.id = r.player_id
       WHERE r.competition_id IN (SELECT competition_id FROM rounds WHERE player_id = $1) AND r.player_id != $1`,
      [playerId]
    );
    const myRoundsByComp = new Map(myRounds.map((r) => [r.competition_id, r]));
    const h2hByOpponent = new Map();
    for (const other of sharedRounds) {
      const mine = myRoundsByComp.get(other.competition_id);
      if (!mine) continue;
      const entry = h2hByOpponent.get(other.player_id) || {
        playerId: other.player_id,
        playerName: other.player_name,
        wins: 0,
        losses: 0,
        ties: 0,
      };
      const myMetric = metricForFormat(other.comp_format, mine);
      const theirMetric = metricForFormat(other.comp_format, other);
      if (myMetric < theirMetric) entry.wins += 1;
      else if (myMetric > theirMetric) entry.losses += 1;
      else entry.ties += 1;
      h2hByOpponent.set(other.player_id, entry);
    }
    const headToHead = Array.from(h2hByOpponent.values())
      .map((h) => ({ ...h, played: h.wins + h.losses + h.ties }))
      .sort((a, b) => b.played - a.played || b.wins - a.wins || a.playerName.localeCompare(b.playerName));

    res.render('stats', {
      myRounds,
      handicapTrend,
      bestRound,
      worstRound,
      avgPoints,
      headToHead,
      TYPE_LABELS,
      FORMAT_LABELS,
    });
  })
);

router.get(
  '/rounds/:id/scorecard',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows: roundRows } = await db.query(
      `SELECT r.*, p.name AS player_name, m.name AS marker_name,
              c.name AS comp_name, c.format AS comp_format, c.comp_date,
              co.name AS course_name, co.tee_name, co.par AS course_par, co.course_rating, co.slope_rating
       FROM rounds r
       JOIN players p ON p.id = r.player_id
       LEFT JOIN players m ON m.id = r.marker_id
       JOIN competitions c ON c.id = r.competition_id
       JOIN courses co ON co.id = r.course_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    const round = roundRows[0];
    if (!round) return res.status(404).render('error', { message: 'Round not found.' });

    const { rows: courseHoles } = await db.query(
      'SELECT hole_number, par, stroke_index FROM course_holes WHERE course_id = $1 ORDER BY hole_number',
      [round.course_id]
    );
    const { rows: holeScoreRows } = await db.query(
      'SELECT hole_number, strokes FROM hole_scores WHERE round_id = $1 ORDER BY hole_number',
      [round.id]
    );
    const scoresByHole = new Map(holeScoreRows.map((s) => [s.hole_number, s.strokes]));
    const holesPlayed = holeScoreRows.length;

    const holes = courseHoles
      .filter((h) => scoresByHole.has(h.hole_number))
      .map((h) => {
        const strokes = scoresByHole.get(h.hole_number);
        const received = strokesReceivedOnHole(round.course_handicap, h.stroke_index, holesPlayed);
        return {
          ...h,
          strokes,
          received,
          netStrokes: strokes - received,
          points: stablefordPointsForHole(strokes, h.par, received),
        };
      });

    res.render('scorecard', { round, holes, FORMAT_LABELS });
  })
);

module.exports = router;
