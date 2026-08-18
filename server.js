require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const db = require('./db');
const asyncHandler = require('./lib/asyncHandler');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // needed behind Vercel's proxy for secure cookies

// Safe fallbacks so error pages can always render, even if the per-request
// middleware below never gets a chance to run (e.g. the database is down
// before res.locals gets set). Express falls back to app.locals when
// res.locals doesn't have a key.
app.locals.currentPlayer = null;
app.locals.societyName = 'Golf Society';

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Sessions are stored client-side in a signed cookie (no server-side session
// store needed) — this is what makes login work correctly across Vercel's
// stateless serverless function instances.
app.use(
  cookieSession({
    name: 'session',
    secret: process.env.SESSION_SECRET || 'change-me-please-golf-society-secret',
    maxAge: 1000 * 60 * 60 * 24 * 90, // 90 days
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
);

// Make sure the schema exists before handling any request (cheap + idempotent,
// cached per warm serverless instance after the first call).
app.use(
  asyncHandler(async (req, res, next) => {
    await db.ready();
    next();
  })
);

// Make current player + society name available to every view
app.use(
  asyncHandler(async (req, res, next) => {
    res.locals.currentPlayer = null;
    if (req.session.playerId) {
      const { rows } = await db.query(
        'SELECT id, name, email, handicap_index, is_admin FROM players WHERE id = $1',
        [req.session.playerId]
      );
      res.locals.currentPlayer = rows[0] || null;
    }
    res.locals.societyName = await db.getSetting('society_name', 'Golf Society');
    next();
  })
);

// First-run setup gate: if no players exist yet, force the /setup flow
app.use(
  asyncHandler(async (req, res, next) => {
    const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM players');
    if (rows[0].c === 0 && req.path !== '/setup') {
      return res.redirect('/setup');
    }
    next();
  })
);

app.get('/', (req, res) => {
  if (!req.session.playerId) return res.redirect('/login');
  res.redirect('/dashboard');
});

app.use('/', require('./routes/setup'));
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/signup'));
app.use('/', require('./routes/main'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'Something went wrong on our end. Please try again.' });
});

// Vercel imports this file as a module and calls the exported app directly —
// it must NOT also try to bind a port. Only listen when run directly (e.g.
// `node server.js` locally, or on a traditional always-on host).
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Golf society app running on http://localhost:${PORT}`);
  });
}

module.exports = app;
