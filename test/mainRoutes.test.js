// Render-level tests for player-facing pages, covering behaviour that has no
// other test coverage: the Play list no longer showing a competition's
// course name (that only appears once you're inside it); the
// "Play anywhere. Compete everywhere." tagline footer that got accidentally
// suppressed on every page by an earlier redesign pass and was then
// restored; and test-user accounts (players.is_test_user) being excluded
// from competition leaderboards, the season standings and the handicaps
// list. Unlike
// test/adminRoutes.test.js (which only covers JSON/redirect routes, since
// res.render needs the real view engine), these spin up the actual EJS view
// engine against the real views/ directory so the rendered HTML can be
// asserted on directly, with db.query mocked the same way via t.mock.method.
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../db');
const mainRouter = require('../routes/main');

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

// Spins up a throwaway Express app with the real view engine and main router
// mounted, plus the same res.locals a logged-in request gets from server.js,
// on a random free port.
async function startTestApp({ isAdmin = false } = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.locals.buildVersion = 'test';
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.session = { playerId: 1, isAdmin };
    res.locals.currentPlayer = {
      id: 1,
      name: 'Test Player',
      email: 'test@example.com',
      handicap_index: 18.4,
      is_admin: isAdmin,
      dashboard_intro_seen: true, // skips the first-visit hero + its UPDATE query
    };
    res.locals.currentSociety = { society_id: 1, is_society_admin: isAdmin, society_name: 'Test Golf Society' };
    res.locals.societyName = 'Test Golf Society';
    res.locals.vapidPublicKey = null;
    res.locals.baseUrl = 'http://localhost';
    res.locals.pairingSheetEnabled = true;
    res.locals.currentPath = req.path;
    res.locals.csrfToken = 'test-csrf-token';
    res.locals.MIN_ROUNDS_FOR_AUTO_HANDICAP = 4;
    next();
  });
  app.use('/', mainRouter);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('/dashboard lists a competition by format only, not its course names', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const queryMock = makeQueryMock([
    {
      match: 'rounds_count',
      result: {
        rows: [
          {
            id: 5,
            name: 'The Tee Open',
            format: 'stableford',
            type: 'league',
            comp_date: new Date('2026-09-01'),
            status: 'open',
            entry_fee_enabled: false,
            entry_fee_amount: null,
            rounds_count: 0,
          },
        ],
      },
    },
    { match: 'FROM entries WHERE player_id', result: { rows: [] } },
    { match: "type != 'sprint'", result: { rows: [] } },
    { match: 'FROM rounds r JOIN players p ON p.id = r.player_id', result: { rows: [] } },
    { match: 'FROM players WHERE is_test_user', result: { rows: [{ id: 1, name: 'Test Player', handicap_index: 18.4 }] } },
  ]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/dashboard`);
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.match(html, /The Tee Open/);
  assert.match(html, /comp-row-meta">Stableford</);

  // The dashboard's competitions query must not resurrect the course_names
  // subquery that used to drive this row — courses are only shown once
  // you've clicked into the competition itself.
  const compQuery = queryMock.calls.find((c) => c.text.includes('rounds_count'));
  assert.ok(!compQuery.text.includes('course_names'));
});

test('dashboard Order of Merit widget shows a not-yet-played player on the board, not the old "join" prompt', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  t.mock.method(
    db,
    'query',
    makeQueryMock([
      { match: 'rounds_count', result: { rows: [] } },
      { match: 'FROM entries WHERE player_id', result: { rows: [] } },
      { match: "type != 'sprint'", result: { rows: [] } },
      { match: 'FROM rounds r JOIN players p ON p.id = r.player_id', result: { rows: [] } },
      {
        match: 'FROM players WHERE is_test_user',
        result: {
          rows: [
            { id: 1, name: 'Test Player', handicap_index: 18.4 },
            { id: 2, name: 'Other Player', handicap_index: 12.0 },
          ],
        },
      },
    ])
  );

  const res = await fetch(`${app.baseUrl}/dashboard`);
  assert.equal(res.status, 200);
  const html = await res.text();

  // The widget must now match /season: every registered player shows up
  // from the moment they sign up, so a player with zero rounds still gets a
  // rank instead of the old "play a competition to join" empty state.
  assert.match(html, /oom-points">0 PTS/);
  assert.match(html, /Play a competition to get on the board/);
  assert.doesNotMatch(html, /join the Order of Merit/);
});

test('every page footer shows the tagline in full, with "Compete" in the gold accent', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  t.mock.method(
    db,
    'query',
    makeQueryMock([
      { match: "type != 'sprint'", result: { rows: [] } },
      { match: 'FROM rounds r JOIN players p ON p.id = r.player_id', result: { rows: [] } },
      { match: 'FROM players WHERE is_test_user', result: { rows: [] } },
    ])
  );

  const res = await fetch(`${app.baseUrl}/season`);
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.match(html, /<footer class="site-footer">/);
  assert.match(html, /Play anywhere\. <span class="accent">Compete<\/span> everywhere\./);
});

test('season standings exclude test users at the query level', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const queryMock = makeQueryMock([
    { match: "type != 'sprint'", result: { rows: [] } },
    { match: 'FROM rounds r JOIN players p ON p.id = r.player_id', result: { rows: [] } },
    { match: 'FROM players WHERE is_test_user', result: { rows: [] } },
  ]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/season`);
  assert.equal(res.status, 200);

  const roundsQuery = queryMock.calls.find((c) => c.text.includes('FROM rounds r JOIN players p ON p.id = r.player_id'));
  assert.ok(roundsQuery.text.includes('is_test_user = FALSE'));

  const rosterQuery = queryMock.calls.find((c) => c.text.includes('FROM players WHERE is_test_user'));
  assert.ok(rosterQuery.text.includes('is_test_user = FALSE'));
});

test('season standings include every registered player, even with zero competitions played', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const queryMock = makeQueryMock([
    {
      match: "type != 'sprint'",
      result: { rows: [{ id: 1, name: 'August Assault', format: 'stableford', comp_date: new Date('2026-08-01'), type: 'league' }] },
    },
    {
      match: 'FROM rounds r JOIN players p ON p.id = r.player_id',
      result: {
        rows: [
          {
            competition_id: 1,
            player_id: 10,
            player_name: 'Played Once',
            gross_total: 80,
            net_total: 72,
            stableford_points: 34,
            course_handicap: 8,
          },
        ],
      },
    },
    {
      match: 'FROM players WHERE is_test_user',
      result: {
        rows: [
          { id: 10, name: 'Played Once', handicap_index: 12.3 },
          { id: 11, name: 'Zulu Newcomer', handicap_index: 28.0 },
          { id: 12, name: 'Alpha Newcomer', handicap_index: 20.5 },
        ],
      },
    },
    { match: 'FROM hole_scores', result: { rows: [] } },
  ]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/season`);
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.match(html, /Played Once/);
  assert.match(html, /Zulu Newcomer/);
  assert.match(html, /Alpha Newcomer/);
  assert.match(html, /stat-label">Played<\/span><strong>0<\/strong>/);
  // Handicap comes from the roster query, not from computeSeasonStandings
  // (which has no notion of it), and must reach zero-competition players too.
  assert.match(html, /stat-label">HCP<\/span><strong>28<\/strong>/);

  // Zero-point players (never played, tied at 0) are ordered alphabetically
  // after anyone who's actually scored points.
  const alphaPos = html.indexOf('Alpha Newcomer');
  const zuluPos = html.indexOf('Zulu Newcomer');
  const playedPos = html.indexOf('Played Once');
  assert.ok(playedPos < alphaPos);
  assert.ok(alphaPos < zuluPos);
});

test('Season page has no search box for a small roster', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  t.mock.method(
    db,
    'query',
    makeQueryMock([
      { match: "type != 'sprint'", result: { rows: [] } },
      { match: 'FROM rounds r JOIN players p ON p.id = r.player_id', result: { rows: [] } },
      { match: 'FROM players WHERE is_test_user', result: { rows: [{ id: 1, name: 'Solo Player', handicap_index: 18.0 }] } },
    ])
  );

  const res = await fetch(`${app.baseUrl}/season`);
  const html = await res.text();
  assert.doesNotMatch(html, /id="season-search"/);
});

test('Season page shows a search box once the roster passes 8 players', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const roster = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, name: `Player ${i + 1}`, handicap_index: 18.0 }));

  t.mock.method(
    db,
    'query',
    makeQueryMock([
      { match: "type != 'sprint'", result: { rows: [] } },
      { match: 'FROM rounds r JOIN players p ON p.id = r.player_id', result: { rows: [] } },
      { match: 'FROM players WHERE is_test_user', result: { rows: roster } },
    ])
  );

  const res = await fetch(`${app.baseUrl}/season`);
  const html = await res.text();
  assert.match(html, /id="season-search"/);
  assert.match(html, /data-search="player 1"/);
  assert.match(html, /data-search="player 9"/);
});

test('a competition leaderboard excludes test users at the query level', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const comp = {
    id: 7,
    name: 'The Tee Open',
    format: 'stableford',
    type: 'league',
    comp_date: new Date('2026-09-01'),
    status: 'closed',
    entry_fee_enabled: false,
    entry_fee_amount: null,
  };
  const queryMock = makeQueryMock([
    { match: 'FROM competitions WHERE id = $1', result: { rows: [comp] } },
    { match: 'FROM competition_courses cc', result: { rows: [] } },
    { match: 'WHERE id NOT IN', result: { rows: [] } },
    { match: 'm.name AS marker_name', result: { rows: [] } },
    { match: 'FROM players WHERE id != $1', result: { rows: [] } },
    { match: 'is_test_user = FALSE', result: { rows: [] } },
    { match: 'FROM entries e', result: { rows: [] } },
    { match: 'FROM pairing_groups pg', result: { rows: [] } },
  ]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/competitions/${comp.id}`);
  assert.equal(res.status, 200);

  // getRoundsForCompetition drives every competition leaderboard — it must
  // filter test users out at the query level, not just in the view.
  const roundsQuery = queryMock.calls.find((c) => c.text.includes('p.name AS player_name, co.name AS course_name'));
  assert.ok(roundsQuery.text.includes('is_test_user = FALSE'));
});

test('/handicaps excludes test users from the players list, both in the query and on the page', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const queryMock = makeQueryMock([
    { match: 'FROM players', result: { rows: [{ id: 1, name: 'Real Player', handicap_index: 12.3 }] } },
    { match: 'FROM rounds r', result: { rows: [] } },
  ]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/handicaps`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Real Player/);

  const playersQuery = queryMock.calls.find((c) => c.text.includes('FROM players'));
  assert.ok(playersQuery.text.includes('is_test_user = FALSE'));
});

test('POST /profile rejects a self-edit once handicap_locked is set, even with zero rounds played', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const queryMock = makeQueryMock([
    { match: 'SELECT * FROM players WHERE id', result: { rows: [{ id: 1, handicap_index: 15.4, handicap_locked: true }] } },
    { match: 'JOIN courses co', result: { rows: [] } }, // myRounds
    { match: 'JOIN players p', result: { rows: [] } }, // sharedRounds
  ]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'handicapIndex=20',
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  // EJS's <%= %> HTML-escapes the message, turning the apostrophe in "can't"
  // into an entity — split the match around it rather than guess the exact
  // encoding.
  assert.match(html, /calculated automatically now and can/);
  assert.match(html, /t be edited by hand/);

  // The whole point of handicap_locked: this must reject before ever
  // reaching the UPDATE, regardless of roundsPlayed being 0.
  assert.ok(!queryMock.calls.some((c) => c.text.includes('UPDATE players SET handicap_index')));
});

test('GET /profile shows an invite link pointing at /signup on this host', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  t.mock.method(
    db,
    'query',
    makeQueryMock([
      { match: 'SELECT * FROM players WHERE id', result: { rows: [{ id: 1, handicap_index: 15.4, handicap_locked: true }] } },
      { match: 'JOIN courses co', result: { rows: [] } }, // myRounds
      { match: 'JOIN players p', result: { rows: [] } }, // sharedRounds
    ])
  );

  const res = await fetch(`${app.baseUrl}/profile`);
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.match(html, /Invite a friend/);
  assert.match(html, /id="invite-link"[^>]*value="http:\/\/localhost\/signup"/);
});
