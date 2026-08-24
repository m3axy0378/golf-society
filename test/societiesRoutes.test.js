// Route-level tests for routes/societies.js (create/switch/join a society),
// new this session. Real EJS view engine against the real views/ directory,
// same db.query mocking pattern as the other route test files.
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../db');
const societiesRouter = require('../routes/societies');

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

// Spins up a throwaway Express app with the real view engine and the
// societies router mounted, with a fake session that can be logged-in or
// logged-out and whatever society memberships the test needs.
async function startTestApp({ loggedIn = true, mySocieties = [], currentSociety = null } = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.locals.buildVersion = 'test';
  app.use(express.urlencoded({ extended: true }));
  const session = loggedIn ? { playerId: 1 } : {};
  app.use((req, res, next) => {
    req.session = session;
    res.locals.currentPlayer = loggedIn ? { id: 1, is_admin: false, is_society_admin: !!(currentSociety && currentSociety.is_society_admin) } : null;
    res.locals.mySocieties = mySocieties;
    res.locals.currentSociety = currentSociety;
    res.locals.societyName = 'Test Golf Society';
    res.locals.baseUrl = 'http://localhost';
    res.locals.currentPath = req.path;
    res.locals.csrfToken = 'test-csrf-token';
    next();
  });
  app.use('/', societiesRouter);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)), session };
}

test('GET /societies with no memberships shows a public join list, not a create form', async (t) => {
  const app = await startTestApp({ mySocieties: [] });
  t.after(() => app.close());

  t.mock.method(
    db,
    'query',
    makeQueryMock([
      {
        match: 'FROM societies ORDER BY name',
        result: { rows: [{ id: 9, name: 'Cathkin Crew', invite_code: 'abc123' }] },
      },
    ])
  );

  const res = await fetch(`${app.baseUrl}/societies`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Cathkin Crew/);
  assert.match(html, /href="\/join\/abc123"/);
  assert.match(html, /Join with a code/);
  assert.doesNotMatch(html, /Create a new society/);
  assert.doesNotMatch(html, /My societies/);
});

test('GET /societies with no memberships and nothing to join yet falls back to showing a create form', async (t) => {
  const app = await startTestApp({ mySocieties: [] });
  t.after(() => app.close());

  t.mock.method(db, 'query', makeQueryMock([{ match: 'FROM societies ORDER BY name', result: { rows: [] } }]));

  const res = await fetch(`${app.baseUrl}/societies`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /No societies exist yet/);
  assert.match(html, /Create a new society/);
});

test('GET /societies with one membership shows it, a create form, but no switch button for the current one', async (t) => {
  const society = { society_id: 5, society_name: 'Cathkin Crew', is_society_admin: true };
  const app = await startTestApp({ mySocieties: [society], currentSociety: society });
  t.after(() => app.close());

  const res = await fetch(`${app.baseUrl}/societies`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Cathkin Crew/);
  assert.match(html, /Create a new society/);
  assert.doesNotMatch(html, /Switch to this one/);
});

test('POST /societies creates the society, adds the creator as its admin, and makes it current, for an existing member', async (t) => {
  const mine = { society_id: 5, society_name: 'Mine', is_society_admin: true };
  const app = await startTestApp({ mySocieties: [mine], currentSociety: mine });
  t.after(() => app.close());

  const clientQuery = makeQueryMock([
    { match: 'INSERT INTO societies', result: { rows: [{ id: 42 }] } },
    { match: 'INSERT INTO society_members', result: { rows: [] } },
  ]);
  t.mock.method(db, 'withTransaction', async (fn) => fn({ query: clientQuery }));

  const res = await fetch(`${app.baseUrl}/societies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=New+Society',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/dashboard');
  assert.equal(app.session.currentSocietyId, 42);

  const memberInsert = clientQuery.calls.find((c) => c.text.includes('INSERT INTO society_members'));
  assert.deepEqual(memberInsert.params, [42, 1]);
  assert.ok(memberInsert.text.includes('is_society_admin) VALUES ($1, $2, TRUE)'));
});

test('POST /societies is refused for a zero-society player when other societies already exist to join', async (t) => {
  const app = await startTestApp({ mySocieties: [] });
  t.after(() => app.close());

  t.mock.method(
    db,
    'query',
    makeQueryMock([{ match: 'FROM societies ORDER BY name', result: { rows: [{ id: 9, name: 'Cathkin Crew', invite_code: 'x' }] } }])
  );
  const withTransactionMock = t.mock.method(db, 'withTransaction', async () => {
    throw new Error('should not start a transaction — this player should not be able to create one yet');
  });

  const res = await fetch(`${app.baseUrl}/societies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=New+Society',
  });
  assert.equal(res.status, 403);
  assert.equal(withTransactionMock.mock.calls.length, 0);
});

test('POST /societies rejects a blank name without touching the database', async (t) => {
  const mine = { society_id: 5, society_name: 'Mine', is_society_admin: true };
  const app = await startTestApp({ mySocieties: [mine], currentSociety: mine });
  t.after(() => app.close());

  const withTransactionMock = t.mock.method(db, 'withTransaction', async () => {
    throw new Error('should not start a transaction for a blank name');
  });

  const res = await fetch(`${app.baseUrl}/societies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=',
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Please enter a name for your society/);
  assert.equal(withTransactionMock.mock.calls.length, 0);
});

test('POST /societies/switch only switches to a society you actually belong to', async (t) => {
  const mine = { society_id: 5, society_name: 'Mine', is_society_admin: false };
  const app = await startTestApp({ mySocieties: [mine], currentSociety: mine });
  t.after(() => app.close());

  const legit = await fetch(`${app.baseUrl}/societies/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'societyId=5',
    redirect: 'manual',
  });
  assert.equal(legit.status, 302);
  assert.equal(app.session.currentSocietyId, 5);

  app.session.currentSocietyId = undefined;
  const notMine = await fetch(`${app.baseUrl}/societies/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'societyId=999',
    redirect: 'manual',
  });
  assert.equal(notMine.status, 302);
  assert.equal(app.session.currentSocietyId, undefined);
});

test('POST /societies/delete is refused for a non-admin of the current society', async (t) => {
  const nonAdmin = { society_id: 5, society_name: 'Mine', is_society_admin: false };
  const app = await startTestApp({ mySocieties: [nonAdmin], currentSociety: nonAdmin });
  t.after(() => app.close());

  const queryMock = makeQueryMock([]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/societies/delete`, { method: 'POST' });
  assert.equal(res.status, 403);
  assert.equal(queryMock.calls.length, 0);
});

test('POST /societies/delete is refused while the society still has competitions on record', async (t) => {
  const admin = { society_id: 5, society_name: 'Mine', is_society_admin: true };
  const app = await startTestApp({ mySocieties: [admin], currentSociety: admin });
  t.after(() => app.close());

  const queryMock = makeQueryMock([{ match: 'SELECT COUNT(*)::int AS c FROM competitions', result: { rows: [{ c: 2 }] } }]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/societies/delete`, { method: 'POST' });
  assert.equal(res.status, 400);
  assert.ok(!queryMock.calls.some((c) => c.text.includes('DELETE FROM societies')));
});

test('POST /societies/delete removes an empty society and clears it from the session', async (t) => {
  const admin = { society_id: 5, society_name: 'Mine', is_society_admin: true };
  const app = await startTestApp({ mySocieties: [admin], currentSociety: admin });
  t.after(() => app.close());
  app.session.currentSocietyId = 5;

  const queryMock = makeQueryMock([
    { match: 'SELECT COUNT(*)::int AS c FROM competitions', result: { rows: [{ c: 0 }] } },
    { match: 'DELETE FROM societies WHERE id', result: { rows: [] } },
  ]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/societies/delete`, { method: 'POST', redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/societies');
  assert.equal(app.session.currentSocietyId, null);

  const deleteCall = queryMock.calls.find((c) => c.text.includes('DELETE FROM societies WHERE id'));
  assert.deepEqual(deleteCall.params, [5]);
});

test('GET /join/:code with an unknown code 404s', async (t) => {
  const app = await startTestApp({ mySocieties: [] });
  t.after(() => app.close());

  t.mock.method(db, 'query', makeQueryMock([{ match: 'FROM societies WHERE invite_code', result: { rows: [] } }]));

  const res = await fetch(`${app.baseUrl}/join/bogus-code`);
  assert.equal(res.status, 404);
});

test('GET /join/:code stashes the code and sends a logged-out visitor to sign up, without joining anything', async (t) => {
  const app = await startTestApp({ loggedIn: false });
  t.after(() => app.close());

  t.mock.method(
    db,
    'query',
    makeQueryMock([{ match: 'FROM societies WHERE invite_code', result: { rows: [{ id: 7, name: 'Cathkin Crew' }] } }])
  );

  const res = await fetch(`${app.baseUrl}/join/real-code`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/signup');
  assert.equal(app.session.pendingInviteCode, 'real-code');
});

test('GET /join/:code just switches an existing member over, without re-rendering a confirm page', async (t) => {
  const mine = { society_id: 7, society_name: 'Cathkin Crew', is_society_admin: false };
  const app = await startTestApp({ mySocieties: [mine], currentSociety: mine });
  t.after(() => app.close());

  t.mock.method(
    db,
    'query',
    makeQueryMock([{ match: 'FROM societies WHERE invite_code', result: { rows: [{ id: 7, name: 'Cathkin Crew' }] } }])
  );

  const res = await fetch(`${app.baseUrl}/join/real-code`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/dashboard');
  assert.equal(app.session.currentSocietyId, 7);
});

test('GET /join/:code shows a confirm page for a logged-in non-member', async (t) => {
  const app = await startTestApp({ mySocieties: [] });
  t.after(() => app.close());

  t.mock.method(
    db,
    'query',
    makeQueryMock([{ match: 'FROM societies WHERE invite_code', result: { rows: [{ id: 7, name: 'Cathkin Crew' }] } }])
  );

  const res = await fetch(`${app.baseUrl}/join/real-code`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Join Cathkin Crew\?/);
});

test('POST /join/:code joins the society and makes it current', async (t) => {
  const app = await startTestApp({ mySocieties: [] });
  t.after(() => app.close());

  const queryMock = makeQueryMock([
    { match: 'FROM societies WHERE invite_code', result: { rows: [{ id: 7, name: 'Cathkin Crew' }] } },
    { match: 'INSERT INTO society_members', result: { rows: [] } },
  ]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/join/real-code`, { method: 'POST', redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/dashboard');
  assert.equal(app.session.currentSocietyId, 7);

  const insertCall = queryMock.calls.find((c) => c.text.includes('INSERT INTO society_members'));
  assert.deepEqual(insertCall.params, [7, 1]);
  assert.ok(insertCall.text.includes('is_society_admin) VALUES ($1, $2, FALSE)'));
});

test('POST /societies/invite-code/regenerate is refused for a non-admin of the current society', async (t) => {
  const nonAdmin = { society_id: 5, society_name: 'Mine', is_society_admin: false };
  const app = await startTestApp({ mySocieties: [nonAdmin], currentSociety: nonAdmin });
  t.after(() => app.close());

  const queryMock = makeQueryMock([]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/societies/invite-code/regenerate`, { method: 'POST' });
  assert.equal(res.status, 403);
  assert.equal(queryMock.calls.length, 0);
});

test('POST /societies/invite-code/regenerate updates the current society\'s code for its admin', async (t) => {
  const admin = { society_id: 5, society_name: 'Mine', is_society_admin: true };
  const app = await startTestApp({ mySocieties: [admin], currentSociety: admin });
  t.after(() => app.close());

  const queryMock = makeQueryMock([{ match: 'UPDATE societies SET invite_code', result: { rows: [] } }]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/societies/invite-code/regenerate`, { method: 'POST', redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/profile');

  const updateCall = queryMock.calls.find((c) => c.text.includes('UPDATE societies SET invite_code'));
  assert.equal(updateCall.params[1], 5);
});
