// Route-level tests for the admin data-management endpoints added this
// session (pairing sheets, the pairing-sheet on/off toggle, and bulk/single
// competition delete + handicap recalculation). These talk to the real `db`
// module's exported functions (query/withTransaction/getSetting/setSetting),
// but with those functions replaced per-test via node:test's built-in
// `t.mock.method` — so the actual Express routing/validation logic in
// routes/admin.js runs for real, while every database call is answered by a
// small in-memory fake instead of hitting Postgres. There's no test-DB setup
// in this repo, so route handlers that call `res.render` (GET /data, GET
// .../pairings) aren't covered here — only the JSON/redirect-returning
// routes, which is everything with real branching logic to get wrong.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../db');
const { recalculateHandicapIndex } = require('../lib/handicap');
const adminRouter = require('../routes/admin');

// Matches a query's SQL text against an ordered list of { match, result }
// rules (first substring match wins) and records every call made through it,
// so tests can both control what a query returns and assert what was run.
function makeQueryMock(rules) {
  const calls = [];
  const fn = async (text, params) => {
    calls.push({ text, params });
    for (const rule of rules) {
      if (text.includes(rule.match)) {
        return typeof rule.result === 'function' ? rule.result(params) : rule.result;
      }
    }
    throw new Error(`Unhandled fake query: ${text}`);
  };
  fn.calls = calls;
  return fn;
}

// Spins up a throwaway Express app with just the admin router mounted (and a
// fake logged-in admin session), on a random free port. Callers get back the
// base URL and a teardown function.
async function startTestApp({ pairingSheetEnabled = true } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.session = { playerId: 1, isAdmin: true };
    res.locals.pairingSheetEnabled = pairingSheetEnabled;
    next();
  });
  app.use('/admin', adminRouter);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('bulk-clear-scores rejects an empty selection', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const res = await fetch(`${app.baseUrl}/admin/competitions/bulk-clear-scores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [] }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'No competitions selected.' });
});

test('bulk-clear-scores deletes rounds/entries for the given ids and recalculates handicaps from what remains', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  // Player 1 needs at least MIN_ROUNDS_FOR_AUTO_HANDICAP (4) rounds left for
  // updatePlayerHandicap to actually touch their Handicap Index at all.
  const roundsForPlayer = {
    1: [80, 82, 84, 86].map((gross_total) => ({ gross_total, course_rating: 70, slope_rating: 113 })),
    2: [],
  };
  const clientQuery = makeQueryMock([
    { match: 'SELECT DISTINCT player_id FROM rounds WHERE competition_id = ANY', result: { rows: [{ player_id: 1 }, { player_id: 2 }] } },
    { match: 'DELETE FROM rounds WHERE competition_id = ANY', result: { rows: [] } },
    { match: 'DELETE FROM entries WHERE competition_id = ANY', result: { rows: [] } },
    { match: 'SELECT r.gross_total, co.course_rating, co.slope_rating', result: (params) => ({ rows: roundsForPlayer[params[0]] || [] }) },
    { match: 'UPDATE players SET handicap_index', result: { rows: [] } },
  ]);
  t.mock.method(db, 'withTransaction', async (fn) => fn({ query: clientQuery }));

  const res = await fetch(`${app.baseUrl}/admin/competitions/bulk-clear-scores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [10, 20] }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, count: 2 });

  assert.ok(clientQuery.calls.some((c) => c.text.includes('DELETE FROM rounds') && c.params[0].length === 2));
  assert.ok(clientQuery.calls.some((c) => c.text.includes('DELETE FROM entries')));

  // Player 1 still has 4 rounds left (enough to be automatic), so their
  // handicap gets recalculated from them; player 2 has nothing left, so
  // updatePlayerHandicap must leave them alone rather than reverting/zeroing
  // their Handicap Index.
  const updates = clientQuery.calls.filter((c) => c.text.includes('UPDATE players SET handicap_index'));
  assert.equal(updates.length, 1);
  const expectedIndex = recalculateHandicapIndex(roundsForPlayer[1].map((r) => ({
    grossTotal: r.gross_total,
    courseRating: r.course_rating,
    slopeRating: r.slope_rating,
  })));
  assert.deepEqual(updates[0].params, [expectedIndex, 1]);
});

test('bulk-delete with { all: true } resolves every competition and still recalculates handicaps', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  t.mock.method(db, 'query', makeQueryMock([{ match: 'SELECT id FROM competitions', result: { rows: [{ id: 5 }, { id: 6 }] } }]));

  const clientQuery = makeQueryMock([
    { match: 'SELECT DISTINCT player_id FROM rounds WHERE competition_id = ANY', result: { rows: [{ player_id: 3 }] } },
    { match: 'DELETE FROM competitions WHERE id = ANY', result: { rows: [] } },
    // 4 rounds left — enough to still be past MIN_ROUNDS_FOR_AUTO_HANDICAP.
    {
      match: 'SELECT r.gross_total, co.course_rating, co.slope_rating',
      result: { rows: [84, 86, 88, 90].map((gross_total) => ({ gross_total, course_rating: 71, slope_rating: 120 })) },
    },
    { match: 'UPDATE players SET handicap_index', result: { rows: [] } },
  ]);
  t.mock.method(db, 'withTransaction', async (fn) => fn({ query: clientQuery }));

  const res = await fetch(`${app.baseUrl}/admin/competitions/bulk-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ all: true }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, count: 2 });
  assert.equal(clientQuery.calls.filter((c) => c.text.includes('UPDATE players SET handicap_index')).length, 1);
});

test('deleting a single competition recalculates handicaps for players who had rounds in it', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const clientQuery = makeQueryMock([
    { match: 'SELECT DISTINCT player_id FROM rounds WHERE competition_id = $1', result: { rows: [{ player_id: 7 }] } },
    { match: 'DELETE FROM competitions WHERE id = $1', result: { rows: [] } },
    { match: 'SELECT r.gross_total, co.course_rating, co.slope_rating', result: { rows: [] } }, // nothing left for player 7
    { match: 'UPDATE players SET handicap_index', result: { rows: [] } },
  ]);
  t.mock.method(db, 'withTransaction', async (fn) => fn({ query: clientQuery }));

  const res = await fetch(`${app.baseUrl}/admin/competitions/42/delete`, { method: 'POST', redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/competitions');

  // Player 7 has no rounds left anywhere -> recalculateHandicapIndex returns
  // null -> updatePlayerHandicap must NOT issue an UPDATE (nothing to revert to).
  assert.equal(clientQuery.calls.filter((c) => c.text.includes('UPDATE players SET handicap_index')).length, 0);
});

test('the pairing-sheet toggle persists on/off based on the checkbox field', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const setSettingCalls = [];
  t.mock.method(db, 'setSetting', async (key, value) => setSettingCalls.push([key, value]));

  await fetch(`${app.baseUrl}/admin/settings/pairing-sheet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'enabled=on',
    redirect: 'manual',
  });
  await fetch(`${app.baseUrl}/admin/settings/pairing-sheet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '', // unchecked checkboxes aren't submitted at all
    redirect: 'manual',
  });

  assert.deepEqual(setSettingCalls, [
    ['pairing_sheet_enabled', 'true'],
    ['pairing_sheet_enabled', 'false'],
  ]);
});

test('reset-handicaps applies the given value, falling back to 28.0 when invalid', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const queryMock = makeQueryMock([{ match: 'UPDATE players SET handicap_index', result: { rows: [] } }]);
  t.mock.method(db, 'query', queryMock);

  await fetch(`${app.baseUrl}/admin/settings/reset-handicaps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'defaultHandicap=15.5',
    redirect: 'manual',
  });
  await fetch(`${app.baseUrl}/admin/settings/reset-handicaps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'defaultHandicap=not-a-number',
    redirect: 'manual',
  });

  assert.deepEqual(queryMock.calls.map((c) => c.params), [[15.5], [28.0]]);
});

test('saving a pairing sheet only stores players who are actually entered, grouped and timed correctly', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  t.mock.method(
    db,
    'query',
    makeQueryMock([
      { match: 'SELECT * FROM competitions WHERE id = $1', result: { rows: [{ id: 3, name: 'Test Comp' }] } },
      { match: 'SELECT player_id FROM entries WHERE competition_id = $1', result: { rows: [{ player_id: 1 }, { player_id: 2 }] } },
    ])
  );
  const clientQuery = makeQueryMock([
    { match: 'DELETE FROM pairing_groups WHERE competition_id = $1', result: { rows: [] } },
    { match: 'INSERT INTO pairing_groups', result: { rows: [] } },
  ]);
  t.mock.method(db, 'withTransaction', async (fn) => fn({ query: clientQuery }));

  const groups = [{ teeTime: '08:00', playerIds: [1, 999] }]; // 999 never entered the competition
  const res = await fetch(`${app.baseUrl}/admin/competitions/3/pairings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `groups=${encodeURIComponent(JSON.stringify(groups))}`,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const inserts = clientQuery.calls.filter((c) => c.text.includes('INSERT INTO pairing_groups'));
  assert.equal(inserts.length, 1); // the invalid id (999) was silently skipped
  assert.deepEqual(inserts[0].params, [3, 1, 1, '08:00']);
});

test('saving a pairing sheet rejects malformed group data', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  t.mock.method(
    db,
    'query',
    makeQueryMock([{ match: 'SELECT * FROM competitions WHERE id = $1', result: { rows: [{ id: 3, name: 'Test Comp' }] } }])
  );

  const res = await fetch(`${app.baseUrl}/admin/competitions/3/pairings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'groups=not-json',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Malformed pairing data.' });
});

test('pairing-sheet routes are blocked while the feature is turned off', async (t) => {
  const app = await startTestApp({ pairingSheetEnabled: false });
  t.after(() => app.close());

  const res = await fetch(`${app.baseUrl}/admin/competitions/3/pairings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'groups=[]',
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Pairing sheets are turned off.' });
});

test('editing a player updates name and email and redirects back with a confirmation flag', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const queryMock = makeQueryMock([
    { match: 'SELECT * FROM players ORDER BY name', result: { rows: [] } },
    { match: 'UPDATE players SET name', result: { rows: [] } },
  ]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/admin/players/7/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=Corrected+Name&email=Fixed%40Example.com',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/players?updated=1');

  const updateCall = queryMock.calls.find((c) => c.text.includes('UPDATE players SET name'));
  // Email is lower-cased and trimmed the same way signup/admin-create already do.
  assert.deepEqual(updateCall.params, ['Corrected Name', 'fixed@example.com', '7']);
});

test('resetting a player\'s password hashes it and clears any pending self-service reset token', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const queryMock = makeQueryMock([
    { match: 'SELECT * FROM players ORDER BY name', result: { rows: [] } },
    { match: 'UPDATE players SET password_hash', result: { rows: [] } },
  ]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/admin/players/7/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=a-brand-new-password',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/players?passwordReset=1');

  const updateCall = queryMock.calls.find((c) => c.text.includes('UPDATE players SET password_hash'));
  assert.ok(updateCall.text.includes('password_reset_token_hash = NULL'));
  assert.ok(updateCall.text.includes('password_reset_expires_at = NULL'));
  // The stored value must be a bcrypt hash, never the plaintext password.
  assert.notEqual(updateCall.params[0], 'a-brand-new-password');
  assert.match(updateCall.params[0], /^\$2[aby]\$/);
  assert.equal(updateCall.params[1], '7');
});

test('resetting a player\'s password rejects anything under 8 characters, without updating it', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const queryMock = makeQueryMock([{ match: 'SELECT * FROM players ORDER BY name', result: { rows: [] } }]);
  t.mock.method(db, 'query', queryMock);

  await fetch(`${app.baseUrl}/admin/players/7/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=short',
    redirect: 'manual',
  });
  // No view engine is set up in this test harness (see file header), so the
  // validation-failure render doesn't produce a real response body here —
  // the meaningful assertion is that it never reached the UPDATE.
  assert.ok(!queryMock.calls.some((c) => c.text.includes('UPDATE players SET password_hash')));
});

test('editing a competition updates its details and adds/removes courses to match the new selection', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  t.mock.method(
    db,
    'query',
    makeQueryMock([
      {
        match: 'FROM competitions c WHERE c.id = $1',
        result: { rows: [{ id: 9, name: 'Old Name', format: 'stableford', type: 'league', rounds_count: 0 }] },
      },
      { match: 'FROM courses ORDER BY name', result: { rows: [{ id: 1 }, { id: 2 }, { id: 3 }] } },
      { match: 'FROM competition_courses WHERE competition_id = $1', result: { rows: [{ course_id: 1 }, { course_id: 2 }] } },
    ])
  );

  const clientQuery = makeQueryMock([
    { match: 'UPDATE competitions', result: { rows: [] } },
    { match: 'INSERT INTO competition_courses', result: { rows: [] } },
    { match: 'DELETE FROM competition_courses', result: { rows: [] } },
  ]);
  t.mock.method(db, 'withTransaction', async (fn) => fn({ query: clientQuery }));

  // Keeps course 1, drops course 2, adds course 3.
  const res = await fetch(`${app.baseUrl}/admin/competitions/9/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=New+Name&compDate=2026-09-01&format=stableford&type=major&courseIds=1&courseIds=3',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/competitions?updated=1');

  const updateCall = clientQuery.calls.find((c) => c.text.includes('UPDATE competitions'));
  assert.deepEqual(updateCall.params, ['New Name', '2026-09-01', 'stableford', 'major', false, null, null, '9']);

  const inserted = clientQuery.calls.filter((c) => c.text.includes('INSERT INTO competition_courses')).map((c) => c.params[1]);
  const deleted = clientQuery.calls.filter((c) => c.text.includes('DELETE FROM competition_courses')).map((c) => c.params[1]);
  assert.deepEqual(inserted, [3]);
  assert.deepEqual(deleted, [2]);
});

test("editing a competition rejects a format change once a round has been submitted, without touching the database", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  t.mock.method(
    db,
    'query',
    makeQueryMock([
      {
        match: 'FROM competitions c WHERE c.id = $1',
        result: { rows: [{ id: 9, name: 'Old Name', format: 'stableford', type: 'league', rounds_count: 3 }] },
      },
      { match: 'FROM courses ORDER BY name', result: { rows: [{ id: 1 }] } },
      { match: 'FROM competition_courses WHERE competition_id = $1', result: { rows: [{ course_id: 1 }] } },
    ])
  );
  const withTransactionMock = t.mock.method(db, 'withTransaction', async () => {
    throw new Error('should not start a transaction when validation fails');
  });

  const res = await fetch(`${app.baseUrl}/admin/competitions/9/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=Old+Name&compDate=2026-09-01&format=net_stroke&type=league&courseIds=1',
    redirect: 'manual',
  });
  assert.equal(withTransactionMock.mock.calls.length, 0);
  assert.notEqual(res.status, 302);
});

test('reassigning a round to a different player recomputes it against their handicap and recalculates both handicaps', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const round = { id: 42, player_id: 1, course_id: 5, competition_id: 7 };
  const newPlayer = { id: 2, name: 'New Player', handicap_index: 12.0 };
  const course = { id: 5, name: 'Test Course', par: 8, course_rating: 68.0, slope_rating: 125 };
  const holes = [
    { hole_number: 1, par: 4, stroke_index: 5 },
    { hole_number: 2, par: 4, stroke_index: 7 },
  ];
  const existingScores = [
    { hole_number: 1, strokes: 5 },
    { hole_number: 2, strokes: 4 },
  ];

  t.mock.method(
    db,
    'query',
    makeQueryMock([
      { match: 'SELECT * FROM rounds WHERE id = $1', result: { rows: [round] } },
      { match: 'SELECT * FROM players WHERE id = $1', result: { rows: [newPlayer] } },
      { match: 'SELECT * FROM courses WHERE id = $1', result: { rows: [course] } },
      { match: 'SELECT type FROM competitions WHERE id = $1', result: { rows: [{ type: 'league' }] } },
      { match: 'FROM course_holes WHERE course_id = $1', result: { rows: holes } },
      { match: 'FROM hole_scores WHERE round_id = $1', result: { rows: existingScores } },
    ])
  );

  const clientQuery = makeQueryMock([
    { match: 'UPDATE rounds SET player_id', result: { rows: [] } },
    { match: 'DELETE FROM entries WHERE competition_id = $1 AND player_id = $2', result: { rows: [] } },
    { match: 'INSERT INTO entries', result: { rows: [] } },
    { match: 'SELECT r.gross_total, co.course_rating, co.slope_rating', result: { rows: [] } },
    { match: 'UPDATE players SET handicap_index', result: { rows: [] } },
  ]);
  t.mock.method(db, 'withTransaction', async (fn) => fn({ query: clientQuery }));

  const res = await fetch(`${app.baseUrl}/admin/rounds/42/reassign-player`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'playerId=2',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/rounds/42/edit?playerMoved=1');

  const updateCall = clientQuery.calls.find((c) => c.text.includes('UPDATE rounds SET player_id'));
  assert.equal(updateCall.params[0], 2); // new player_id
  assert.equal(updateCall.params[1], 12.0); // recomputed against the new player's own handicap
  assert.equal(updateCall.params[6], 42); // round id

  assert.ok(clientQuery.calls.some((c) => c.text.includes('DELETE FROM entries') && c.params[1] === 1));
  assert.ok(clientQuery.calls.some((c) => c.text.includes('INSERT INTO entries') && c.params[1] === 2));

  // Both the old and new player's handicaps get recalculated — one round
  // moving between them changes both of their histories.
  const handicapUpdates = clientQuery.calls.filter((c) => c.text.includes('SELECT r.gross_total, co.course_rating, co.slope_rating'));
  assert.equal(handicapUpdates.length, 2);
});

test('reassigning a round to a different player is a no-op if the target player is unknown', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const round = { id: 42, player_id: 1, course_id: 5, competition_id: 7 };
  t.mock.method(
    db,
    'query',
    makeQueryMock([
      { match: 'SELECT * FROM rounds WHERE id = $1', result: { rows: [round] } },
      { match: 'SELECT * FROM players WHERE id = $1', result: { rows: [] } },
    ])
  );
  const withTransactionMock = t.mock.method(db, 'withTransaction', async () => {
    throw new Error('should not start a transaction for an unknown player');
  });

  const res = await fetch(`${app.baseUrl}/admin/rounds/42/reassign-player`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'playerId=999',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/rounds/42/edit');
  assert.equal(withTransactionMock.mock.calls.length, 0);
});

test('reassigning a round to a different course recomputes it and adds the course to the competition', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  // A sprint round needs course_holes data for holes 1-9.
  const sprintHoles = Array.from({ length: 9 }, (_, i) => ({ hole_number: i + 1, par: 4, stroke_index: i + 1 }));
  const existingScores = sprintHoles.map((h) => ({ hole_number: h.hole_number, strokes: 5 }));

  const round = { id: 42, player_id: 1, course_id: 5, competition_id: 7 };
  const player = { id: 1, name: 'Player One', handicap_index: 15.0 };
  const newCourse = { id: 6, name: 'New Course', par: 36, course_rating: 34.0, slope_rating: 130 };

  t.mock.method(
    db,
    'query',
    makeQueryMock([
      { match: 'SELECT * FROM rounds WHERE id = $1', result: { rows: [round] } },
      { match: 'SELECT * FROM courses WHERE id = $1', result: { rows: [newCourse] } },
      { match: 'SELECT * FROM players WHERE id = $1', result: { rows: [player] } },
      { match: 'SELECT type FROM competitions WHERE id = $1', result: { rows: [{ type: 'sprint' }] } },
      { match: 'FROM course_holes WHERE course_id = $1', result: { rows: sprintHoles } },
      { match: 'FROM hole_scores WHERE round_id = $1', result: { rows: existingScores } },
    ])
  );

  const clientQuery = makeQueryMock([
    { match: 'UPDATE rounds SET course_id', result: { rows: [] } },
    { match: 'INSERT INTO competition_courses', result: { rows: [] } },
    { match: 'SELECT r.gross_total, co.course_rating, co.slope_rating', result: { rows: [] } },
    { match: 'UPDATE players SET handicap_index', result: { rows: [] } },
  ]);
  t.mock.method(db, 'withTransaction', async (fn) => fn({ query: clientQuery }));

  const res = await fetch(`${app.baseUrl}/admin/rounds/42/reassign-course`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'courseId=6',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/rounds/42/edit?courseMoved=1');

  const updateCall = clientQuery.calls.find((c) => c.text.includes('UPDATE rounds SET course_id'));
  assert.equal(updateCall.params[0], 6); // new course_id
  assert.equal(updateCall.params[6], 42); // round id

  assert.ok(clientQuery.calls.some((c) => c.text.includes('INSERT INTO competition_courses') && c.params[1] === 6));
  assert.equal(clientQuery.calls.filter((c) => c.text.includes('SELECT r.gross_total, co.course_rating, co.slope_rating')).length, 1);
});

test("reassigning a round to a different course is rejected if that course doesn't have enough hole data, without touching the database", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const round = { id: 42, player_id: 1, course_id: 5, competition_id: 7 };
  const newCourse = { id: 6, name: 'Nine Hole Course', par: 36, course_rating: 34.0, slope_rating: 130 };
  // A league round needs 18 holes' worth of course_holes data — this course
  // only has 2, well short of what a full round requires.
  const shortHoles = [
    { hole_number: 1, par: 4, stroke_index: 5 },
    { hole_number: 2, par: 4, stroke_index: 7 },
  ];

  t.mock.method(
    db,
    'query',
    makeQueryMock([
      { match: 'SELECT * FROM rounds WHERE id = $1', result: { rows: [round] } },
      { match: 'SELECT * FROM courses WHERE id = $1', result: { rows: [newCourse] } },
      { match: 'SELECT * FROM players WHERE id = $1', result: { rows: [{ id: 1, handicap_index: 15.0 }] } },
      { match: 'SELECT type FROM competitions WHERE id = $1', result: { rows: [{ type: 'league' }] } },
      { match: 'FROM course_holes WHERE course_id = $1', result: { rows: shortHoles } },
    ])
  );
  const withTransactionMock = t.mock.method(db, 'withTransaction', async () => {
    throw new Error('should not start a transaction when the course lacks enough hole data');
  });

  await fetch(`${app.baseUrl}/admin/rounds/42/reassign-course`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'courseId=6',
    redirect: 'manual',
  });
  // No view engine is set up in this test harness (see file header), so the
  // rejection's res.render() doesn't produce a clean 400 response here — the
  // meaningful assertion is that it never reached the transaction.
  assert.equal(withTransactionMock.mock.calls.length, 0);
});

test('removing an entry with no round yet deletes it', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const queryMock = makeQueryMock([
    { match: 'FROM entries e', result: { rows: [{ id: 15, competition_id: 7, player_id: 3, round_id: null }] } },
    { match: 'DELETE FROM entries WHERE id = $1', result: { rows: [] } },
  ]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/admin/entries/15/delete`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const deleteCall = queryMock.calls.find((c) => c.text.includes('DELETE FROM entries WHERE id = $1'));
  assert.deepEqual(deleteCall.params, [15]);
});

test("removing an entry that already has a round is rejected, without deleting it", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const queryMock = makeQueryMock([
    { match: 'FROM entries e', result: { rows: [{ id: 15, competition_id: 7, player_id: 3, round_id: 99 }] } },
  ]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/admin/entries/15/delete`, { method: 'POST' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Can't remove an entry that already has a submitted round." });
  assert.ok(!queryMock.calls.some((c) => c.text.includes('DELETE FROM entries')));
});

test('removing an unknown entry 404s', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  t.mock.method(db, 'query', makeQueryMock([{ match: 'FROM entries e', result: { rows: [] } }]));

  const res = await fetch(`${app.baseUrl}/admin/entries/404/delete`, { method: 'POST' });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Entry not found.' });
});

test('merging two players moves everything onto the kept player and deletes the duplicate', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  t.mock.method(
    db,
    'query',
    makeQueryMock([
      { match: 'SELECT * FROM players ORDER BY name', result: { rows: [] } },
      { match: 'SELECT c.name FROM rounds r1', result: { rows: [] } }, // no conflicting competition
    ])
  );

  const clientQuery = makeQueryMock([
    { match: 'UPDATE rounds SET player_id', result: { rows: [] } },
    { match: 'UPDATE rounds SET marker_id', result: { rows: [] } },
    { match: 'INSERT INTO entries', result: { rows: [] } },
    { match: 'DELETE FROM entries WHERE player_id', result: { rows: [] } },
    { match: 'INSERT INTO round_reactions', result: { rows: [] } },
    { match: 'DELETE FROM round_reactions WHERE player_id', result: { rows: [] } },
    { match: 'INSERT INTO pairing_groups', result: { rows: [] } },
    { match: 'DELETE FROM pairing_groups WHERE player_id', result: { rows: [] } },
    { match: 'UPDATE push_subscriptions SET player_id', result: { rows: [] } },
    { match: 'DELETE FROM players WHERE id', result: { rows: [] } },
    { match: 'SELECT r.gross_total, co.course_rating, co.slope_rating', result: { rows: [] } },
  ]);
  t.mock.method(db, 'withTransaction', async (fn) => fn({ query: clientQuery }));

  const res = await fetch(`${app.baseUrl}/admin/players/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'keepPlayerId=1&mergePlayerId=2',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/players?merged=1');

  assert.deepEqual(clientQuery.calls.find((c) => c.text.includes('UPDATE rounds SET player_id')).params, [1, 2]);
  assert.deepEqual(clientQuery.calls.find((c) => c.text.includes('UPDATE rounds SET marker_id')).params, [1, 2]);
  assert.deepEqual(clientQuery.calls.find((c) => c.text.includes('DELETE FROM players WHERE id')).params, [2]);
  // The player being merged away is never left standing after every one of
  // their rows has been moved or deduped onto the kept player.
  assert.ok(!clientQuery.calls.some((c) => c.text.includes('DELETE FROM players WHERE id') && c.params[0] === 1));
});

test('merging is rejected if both players have a round in the same competition, without touching either', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  t.mock.method(
    db,
    'query',
    makeQueryMock([
      { match: 'SELECT * FROM players ORDER BY name', result: { rows: [] } },
      { match: 'SELECT c.name FROM rounds r1', result: { rows: [{ name: 'August Assault' }] } },
    ])
  );
  const withTransactionMock = t.mock.method(db, 'withTransaction', async () => {
    throw new Error('should not start a transaction when both players scored the same competition');
  });

  await fetch(`${app.baseUrl}/admin/players/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'keepPlayerId=1&mergePlayerId=2',
    redirect: 'manual',
  });
  assert.equal(withTransactionMock.mock.calls.length, 0);
});

test('merging a player with themselves is rejected before any conflict check or transaction', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const queryMock = makeQueryMock([{ match: 'SELECT * FROM players ORDER BY name', result: { rows: [] } }]);
  t.mock.method(db, 'query', queryMock);
  const withTransactionMock = t.mock.method(db, 'withTransaction', async () => {
    throw new Error('should not start a transaction merging a player with themselves');
  });

  await fetch(`${app.baseUrl}/admin/players/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'keepPlayerId=1&mergePlayerId=1',
    redirect: 'manual',
  });
  assert.equal(withTransactionMock.mock.calls.length, 0);
  assert.ok(!queryMock.calls.some((c) => c.text.includes('SELECT c.name FROM rounds r1')));
});
