// Render-level tests for the "confirm your starting handicap" onboarding
// step (/welcome/handicap), same pattern as authRoutes.test.js: real EJS view
// engine against the real views/ directory, db.query mocked via t.mock.method.
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../db');
const onboardingRouter = require('../routes/onboarding');

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

async function startTestApp(currentPlayer) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.locals.buildVersion = 'test';
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.session = { playerId: currentPlayer.id };
    res.locals.currentPlayer = currentPlayer;
    res.locals.societyName = 'Test Golf Society';
    res.locals.vapidPublicKey = null;
    res.locals.baseUrl = 'http://localhost';
    res.locals.pairingSheetEnabled = true;
    res.locals.currentPath = req.path;
    res.locals.csrfToken = 'test-csrf-token';
    res.locals.MIN_ROUNDS_FOR_AUTO_HANDICAP = 4;
    next();
  });
  app.use('/', onboardingRouter);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('GET /welcome/handicap shows the form for an unconfirmed player', async (t) => {
  const app = await startTestApp({ id: 4, handicap_index: 28.0, handicap_confirmed_by_player: false });
  t.after(() => app.close());

  const res = await fetch(`${app.baseUrl}/welcome/handicap`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /What's your current Handicap Index/);
});

test('GET /welcome/handicap redirects to the dashboard once already confirmed', async (t) => {
  const app = await startTestApp({ id: 4, handicap_index: 14.2, handicap_confirmed_by_player: true });
  t.after(() => app.close());

  const res = await fetch(`${app.baseUrl}/welcome/handicap`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/dashboard');
});

test('POST /welcome/handicap saves the handicap, confirms it, and sends the player on', async (t) => {
  const app = await startTestApp({ id: 4, handicap_index: 28.0, handicap_confirmed_by_player: false });
  t.after(() => app.close());

  const queryMock = makeQueryMock([{ match: 'UPDATE players SET handicap_index', result: { rows: [] } }]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/welcome/handicap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'handicapIndex=16.4',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/dashboard?enableNotifications=1');

  assert.equal(queryMock.calls.length, 1);
  assert.deepEqual(queryMock.calls[0].params, [16.4, 4]);
  assert.ok(queryMock.calls[0].text.includes('handicap_confirmed_by_player = TRUE'));
  // handicap_locked (not handicap_confirmed_by_player) is what actually stops
  // self-editing on Profile afterward — see routes/main.js's /profile handler.
  assert.ok(queryMock.calls[0].text.includes('handicap_locked = TRUE'));
});

test('POST /welcome/handicap rejects a non-numeric handicap without touching the database', async (t) => {
  const app = await startTestApp({ id: 4, handicap_index: 28.0, handicap_confirmed_by_player: false });
  t.after(() => app.close());

  const queryMock = makeQueryMock([]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/welcome/handicap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'handicapIndex=not-a-number',
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /valid handicap index/);
  assert.equal(queryMock.calls.length, 0);
});

test('POST /welcome/handicap is a no-op once already confirmed, even if posted directly', async (t) => {
  const app = await startTestApp({ id: 4, handicap_index: 14.2, handicap_confirmed_by_player: true });
  t.after(() => app.close());

  const queryMock = makeQueryMock([]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/welcome/handicap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'handicapIndex=99',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/dashboard');
  assert.equal(queryMock.calls.length, 0);
});
