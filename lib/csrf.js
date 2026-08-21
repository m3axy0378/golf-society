const crypto = require('crypto');

// Synchronizer-token pattern, backed by the session cookie that's already
// there for login. One random token is generated the first time a session
// needs one and then lives for the rest of that session, rather than
// rotating per request or per form — a per-request token would go stale for
// anything the offline round-submission queue (public/offline-queue.js)
// replays hours after the form was originally rendered.
function attachToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

// Every POST form carries the token as a hidden `_csrf` field; the handful
// of fetch()-based POSTs that aren't real form submits (push subscribe/
// unsubscribe, the paid toggle, round reactions) send it as an
// X-CSRF-Token header instead — same value, just read from a <meta> tag
// (see partials/header.ejs) rather than a form field. Presence of that
// header is also what decides whether a failure gets a JSON or HTML
// response, since those are exactly the endpoints that reply with JSON.
function verifyToken(req, res, next) {
  if (req.method !== 'POST') return next();

  const headerToken = req.get('X-CSRF-Token');
  const provided = (req.body && req.body._csrf) || headerToken;
  const expected = req.session && req.session.csrfToken;

  if (provided && expected && provided === expected) return next();

  const wantsJson = Boolean(headerToken) || (req.get('Content-Type') || '').includes('application/json');
  if (wantsJson) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token. Please refresh the page and try again.' });
  }
  res.status(403).render('error', {
    message: "This form couldn't be verified — your session may have expired. Please refresh the page and try again.",
  });
}

module.exports = { attachToken, verifyToken };
