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

  const roundsForPlayer = { 1: [{ gross_total: 90, course_rating: 70, slope_rating: 113 }], 2: [] };
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

  // Player 1 still has a round, so their handicap gets recalculated from it;
  // player 2 has nothing left, so updatePlayerHandicap must leave them alone
  // rather than reverting/zeroing their Handicap Index.
  const updates = clientQuery.calls.filter((c) => c.text.includes('UPDATE players SET handicap_index'));
  assert.equal(updates.length, 1);
  const expectedIndex = recalculateHandicapIndex([{ grossTotal: 90, courseRating: 70, slopeRating: 113 }]);
  assert.deepEqual(updates[0].params, [expectedIndex, 1]);
});

test('bulk-delete with { all: true } resolves every competition and still recalculates handicaps', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  t.mock.method(db, 'query', makeQueryMock([{ match: 'SELECT id FROM competitions', result: { rows: [{ id: 5 }, { id: 6 }] } }]));

  const clientQuery = makeQueryMock([
    { match: 'SELECT DISTINCT player_id FROM rounds WHERE competition_id = ANY', result: { rows: [{ player_id: 3 }] } },
    { match: 'DELETE FROM competitions WHERE id = ANY', result: { rows: [] } },
    { match: 'SELECT r.gross_total, co.course_rating, co.slope_rating', result: { rows: [{ gross_total: 84, course_rating: 71, slope_rating: 120 }] } },
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

  const queryMock = makeQueryMock([{ match: 'UPDATE players SET name', result: { rows: [] } }]);
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

  const queryMock = makeQueryMock([{ match: 'UPDATE players SET password_hash', result: { rows: [] } }]);
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
