// Render-level tests for the self-service password reset flow
// (/forgot-password, /reset-password/:token). Spins up the real EJS view
// engine against the real views/ directory, same pattern as
// mainRoutes.test.js, with db.query and lib/email's sendPasswordResetEmail
// both mocked via t.mock.method.
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const email = require('../lib/email');
const authRouter = require('../routes/auth');

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

async function startTestApp(router = authRouter) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.locals.buildVersion = 'test';
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.session = {};
    res.locals.currentPlayer = null;
    res.locals.societyName = 'Test Golf Society';
    res.locals.baseUrl = 'http://localhost';
    res.locals.currentPath = req.path;
    res.locals.csrfToken = 'test-csrf-token';
    next();
  });
  app.use('/', router);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

// routes/auth.js's rate limiters are created once at module scope, so their
// request counts persist across every test that shares the cached module —
// fine for the handful of successful requests the other tests in this file
// make, but the two lockout tests below need a router with its own limiter
// state so they can drive a specific counter to its limit without being
// thrown off by requests other tests already made. Busting the require
// cache gives each one a fresh rate-limit store.
function freshAuthRouter() {
  delete require.cache[require.resolve('../routes/auth')];
  return require('../routes/auth');
}

test('/forgot-password sends a reset email for a real account and stores a hashed token', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const queryMock = makeQueryMock([
    { match: 'SELECT id, name FROM players WHERE email', result: { rows: [{ id: 3, name: 'Real Player' }] } },
    { match: 'UPDATE players SET password_reset_token_hash', result: { rows: [] } },
  ]);
  t.mock.method(db, 'query', queryMock);
  const sendMock = t.mock.method(email, 'sendPasswordResetEmail', async () => ({ sent: true, configured: true }));

  const res = await fetch(`${app.baseUrl}/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=real@example.com',
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /we've sent a link/);

  assert.equal(sendMock.mock.calls.length, 1);
  const emailArgs = sendMock.mock.calls[0].arguments[0];
  assert.equal(emailArgs.to, 'real@example.com');
  assert.match(emailArgs.resetUrl, /^http:\/\/localhost\/reset-password\/[0-9a-f]{64}$/);

  const updateCall = queryMock.calls.find((c) => c.text.includes('UPDATE players SET password_reset_token_hash'));
  // The raw token in the emailed URL must never be what's stored — only its hash.
  const rawToken = emailArgs.resetUrl.split('/').pop();
  assert.notEqual(updateCall.params[0], rawToken);
  assert.equal(updateCall.params[0], crypto.createHash('sha256').update(rawToken).digest('hex'));
});

test("/forgot-password gives the same response for an email that doesn't exist, and sends nothing", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  t.mock.method(db, 'query', makeQueryMock([{ match: 'SELECT id, name FROM players WHERE email', result: { rows: [] } }]));
  const sendMock = t.mock.method(email, 'sendPasswordResetEmail', async () => ({ sent: true, configured: true }));

  const res = await fetch(`${app.baseUrl}/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=nobody@example.com',
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /we've sent a link/);
  assert.equal(sendMock.mock.calls.length, 0);
});

test('/login locks out further attempts after repeated failures', async (t) => {
  const app = await startTestApp(freshAuthRouter());
  t.after(() => app.close());

  t.mock.method(db, 'query', makeQueryMock([{ match: 'SELECT * FROM players WHERE email', result: { rows: [] } }]));

  let lastStatus;
  for (let i = 0; i < 11; i++) {
    const res = await fetch(`${app.baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'email=nobody@example.com&password=wrong',
    });
    lastStatus = res.status;
    if (i < 10) assert.equal(res.status, 200);
  }
  assert.equal(lastStatus, 429);
});

test('/forgot-password locks out further attempts after repeated requests', async (t) => {
  const app = await startTestApp(freshAuthRouter());
  t.after(() => app.close());

  t.mock.method(db, 'query', makeQueryMock([{ match: 'SELECT id, name FROM players WHERE email', result: { rows: [] } }]));

  let lastStatus;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${app.baseUrl}/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'email=nobody@example.com',
    });
    lastStatus = res.status;
    if (i < 5) assert.equal(res.status, 200);
  }
  assert.equal(lastStatus, 429);
});

test('/reset-password/:token rejects an expired or unknown token', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  t.mock.method(db, 'query', makeQueryMock([{ match: 'password_reset_token_hash', result: { rows: [] } }]));

  const res = await fetch(`${app.baseUrl}/reset-password/not-a-real-token`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /invalid or has expired/);
});

test('/reset-password/:token sets a new password and clears the reset token on success', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const queryMock = makeQueryMock([
    { match: 'password_reset_token_hash = $1 AND password_reset_expires_at', result: { rows: [{ id: 9 }] } },
    { match: 'UPDATE players SET password_hash', result: { rows: [] } },
  ]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/reset-password/some-valid-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=a-brand-new-password',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login?reset=1');

  const updateCall = queryMock.calls.find((c) => c.text.includes('UPDATE players SET password_hash'));
  assert.deepEqual(updateCall.params.slice(1), [9]);
  assert.ok(updateCall.text.includes('password_reset_token_hash = NULL'));
});

test('/reset-password/:token rejects a too-short password without touching the database', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const queryMock = makeQueryMock([{ match: 'password_reset_token_hash = $1 AND password_reset_expires_at', result: { rows: [{ id: 9 }] } }]);
  t.mock.method(db, 'query', queryMock);

  const res = await fetch(`${app.baseUrl}/reset-password/some-valid-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=short',
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /at least 8 characters/);
  assert.ok(!queryMock.calls.some((c) => c.text.includes('UPDATE players SET password_hash')));
});
