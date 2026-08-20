// Render-level tests for player-facing pages, covering two regressions that
// have no other test coverage: the Play list no longer showing a
// competition's course name (that only appears once you're inside it), and
// the "Play anywhere. Compete everywhere." tagline footer that got
// accidentally suppressed on every page by an earlier redesign pass and was
// then restored. Unlike test/adminRoutes.test.js (which only covers
// JSON/redirect routes, since res.render needs the real view engine), these
// spin up the actual EJS view engine against the real views/ directory so
// the rendered HTML can be asserted on directly, with db.query mocked the
// same way via t.mock.method.
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
    res.locals.societyName = 'Test Golf Society';
    res.locals.vapidPublicKey = null;
    res.locals.baseUrl = 'http://localhost';
    res.locals.pairingSheetEnabled = true;
    res.locals.currentPath = req.path;
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

test('every page footer shows the tagline in full, with "Compete" in the gold accent', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  t.mock.method(
    db,
    'query',
    makeQueryMock([
      { match: "type != 'sprint'", result: { rows: [] } },
      { match: 'FROM rounds r JOIN players p ON p.id = r.player_id', result: { rows: [] } },
    ])
  );

  const res = await fetch(`${app.baseUrl}/season`);
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.match(html, /<footer class="site-footer">/);
  assert.match(html, /Play anywhere\. <span class="accent">Compete<\/span> everywhere\./);
});
