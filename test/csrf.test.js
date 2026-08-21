// Direct tests for lib/csrf.js. Every other test file mounts a router on a
// bare Express app without server.js's global middleware chain, so nothing
// else in the suite ever actually exercises attachToken/verifyToken.
//
// Two layers here: an end-to-end test using the real cookie-session package
// (wired the same order server.js uses it) to prove a token issued on one
// request is still accepted on the next real HTTP request against the same
// session — the actual risk with this design — plus focused unit tests
// against verifyToken directly for the branch logic (matching/mismatched
// token, form field vs header, JSON vs rendered-page failure response) that
// would be awkward to provoke through a full request per case.
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieSession = require('cookie-session');
const csrf = require('../lib/csrf');

async function startIntegrationApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.locals.buildVersion = 'test';
  app.locals.currentPlayer = null;
  app.locals.societyName = 'Test Golf Society';
  app.locals.vapidPublicKey = null;
  app.locals.baseUrl = 'http://localhost';
  app.locals.pairingSheetEnabled = true;
  app.locals.csrfToken = '';

  app.use(express.urlencoded({ extended: true }));
  app.use(cookieSession({ name: 'session', secret: 'test-secret', sameSite: 'lax' }));
  app.use(csrf.attachToken);
  app.use(csrf.verifyToken);
  app.get('/form', (req, res) => res.json({ csrfToken: res.locals.csrfToken }));
  app.post('/submit', (req, res) => res.json({ ok: true }));

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('a token issued on a GET is accepted on a real subsequent POST in the same session', async (t) => {
  const app = await startIntegrationApp();
  t.after(() => app.close());

  const getRes = await fetch(`${app.baseUrl}/form`);
  const cookie = getRes.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await getRes.json();
  assert.match(csrfToken, /^[0-9a-f]{64}$/);

  const postRes = await fetch(`${app.baseUrl}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: `_csrf=${csrfToken}`,
  });
  assert.equal(postRes.status, 200);
  assert.deepEqual(await postRes.json(), { ok: true });
});

test('a POST reusing a different session\'s cookie (or none at all) is rejected', async (t) => {
  const app = await startIntegrationApp();
  t.after(() => app.close());

  const getRes = await fetch(`${app.baseUrl}/form`);
  const { csrfToken } = await getRes.json();

  // Correct token value, but no session cookie attached to carry it — this
  // is exactly what happens if the token were ever leaked or guessed
  // without also having the (much harder to get) session cookie.
  const postRes = await fetch(`${app.baseUrl}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `_csrf=${csrfToken}`,
  });
  assert.equal(postRes.status, 403);
});

test('a matching _csrf body field is accepted', () => {
  const req = { method: 'POST', session: { csrfToken: 'a'.repeat(64) }, body: { _csrf: 'a'.repeat(64) }, get: () => undefined };
  let nextCalled = false;
  csrf.verifyToken(req, {}, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test('a matching X-CSRF-Token header is accepted even with no body field', () => {
  const req = {
    method: 'POST',
    session: { csrfToken: 'b'.repeat(64) },
    body: {},
    get: (header) => (header === 'X-CSRF-Token' ? 'b'.repeat(64) : undefined),
  };
  let nextCalled = false;
  csrf.verifyToken(req, {}, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test('a wrong _csrf body field is rejected with a rendered error page, not JSON', () => {
  const req = {
    method: 'POST',
    session: { csrfToken: 'a'.repeat(64) },
    body: { _csrf: 'wrong' },
    get: (header) => (header === 'Content-Type' ? 'application/x-www-form-urlencoded' : undefined),
  };
  let statusCode = null;
  let renderedView = null;
  let renderedLocals = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    render(view, locals) {
      renderedView = view;
      renderedLocals = locals;
    },
  };
  csrf.verifyToken(req, res, () => {
    throw new Error('next() should not be called');
  });
  assert.equal(statusCode, 403);
  assert.equal(renderedView, 'error');
  assert.match(renderedLocals.message, /couldn't be verified/);
});

test('a wrong X-CSRF-Token header is rejected with JSON, not a rendered page', () => {
  const req = {
    method: 'POST',
    session: { csrfToken: 'b'.repeat(64) },
    body: {},
    get: (header) => (header === 'X-CSRF-Token' ? 'wrong' : undefined),
  };
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonBody = body;
    },
  };
  csrf.verifyToken(req, res, () => {
    throw new Error('next() should not be called');
  });
  assert.equal(statusCode, 403);
  assert.match(jsonBody.error, /Invalid or missing CSRF token/);
});

test('non-POST requests are never checked', () => {
  const req = { method: 'GET', session: {}, body: {}, get: () => undefined };
  let nextCalled = false;
  csrf.verifyToken(req, {}, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});
