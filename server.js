require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const helmet = require('helmet');

const db = require('./db');
const asyncHandler = require('./lib/asyncHandler');
const csrf = require('./lib/csrf');
const { MIN_ROUNDS_FOR_AUTO_HANDICAP } = require('./lib/handicap');
const { handicapConfirmationGate, societyMembershipGate } = require('./lib/onboardingGates');

const app = express();

// contentSecurityPolicy is left off: several pages (profile, season, the
// onboarding/push-notification flows) rely on inline <script> blocks with no
// nonce plumbing, and helmet's default CSP would silently block all of them.
// Everything else helmet sets by default — X-Content-Type-Options,
// X-Frame-Options, HSTS, etc. — is safe to turn on as-is.
app.use(helmet({ contentSecurityPolicy: false }));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // needed behind Vercel's proxy for secure cookies

// Express only enables compiled-template caching automatically when it infers
// a production environment — make it explicit rather than relying on that,
// so every request after the first reuses the compiled EJS function instead
// of re-reading and re-compiling the .ejs file from disk.
if (process.env.NODE_ENV === 'production') {
  app.set('view cache', true);
}

// Safe fallbacks so error pages can always render, even if the per-request
// middleware below never gets a chance to run (e.g. the database is down
// before res.locals gets set). Express falls back to app.locals when
// res.locals doesn't have a key.
app.locals.currentPlayer = null;
app.locals.societyName = 'Golf Society';
app.locals.vapidPublicKey = null;
app.locals.baseUrl = '';
app.locals.pairingSheetEnabled = true;
app.locals.csrfToken = '';
// A fixed constant, not per-request data — set once here rather than
// threading it through every render call across profile/handicaps/onboarding.
app.locals.MIN_ROUNDS_FOR_AUTO_HANDICAP = MIN_ROUNDS_FOR_AUTO_HANDICAP;

// Appended to /style.css's URL so every deploy gets a distinct URL instead
// of reusing "/style.css" forever — lets the browser cache it aggressively
// (see vercel.json) while guaranteeing a CSS change is never masked by an
// old cached copy, which is what long max-age on a fixed URL would do.
// Vercel sets this automatically for Git-connected deployments; falls back
// to boot time so local/non-Vercel runs still get a fresh value per restart.
app.locals.buildVersion = process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now());

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Most static files aren't fingerprinted (they keep the same URL across
// deploys), so caching can't be "forever, immutable" — but the default was
// max-age=0, forcing a revalidation round trip for every asset on every page
// load. Icons/manifest change essentially never, so they get a long cache.
// sw.js is excluded entirely: browsers already special-case service worker
// scripts to re-check at most every 24h, and it should never be served stale
// during a deploy. style.css IS fingerprinted (linked as /style.css?v=<build
// version>, see app.locals.buildVersion above), so it's safe to cache for a
// full year — a CSS change ships instantly via a new URL rather than by
// waiting for an old cached copy to expire, which is what bit us in
// production: a change would look "live" on deploy but stay invisible to
// anyone with a still-warm cache from before it, for up to the old max-age.
// Everything else (the small JS helpers) gets a short, unversioned cache —
// long enough to skip repeat requests within a browsing session, short
// enough that a fix still ships to everyone within the hour.
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      if (path.basename(filePath) === 'sw.js') {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (path.basename(filePath) === 'style.css') {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // 1 year
      } else if (filePath.includes(`${path.sep}img${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 days
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour
      }
    },
  })
);

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

// One CSRF token per session, exposed to every view as csrfToken; every POST
// is then checked against it (form field or X-CSRF-Token header — see
// lib/csrf.js) before it reaches any route handler.
app.use(csrf.attachToken);
app.use(csrf.verifyToken);

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
    res.locals.mySocieties = [];
    res.locals.currentSociety = null;
    const settingsPromise = db.getSettings({ society_name: 'Golf Society', pairing_sheet_enabled: 'true' });
    if (req.session.playerId) {
      const { rows } = await db.query(
        'SELECT id, name, email, handicap_index, is_admin, dashboard_intro_seen, is_test_user, handicap_confirmed_by_player FROM players WHERE id = $1',
        [req.session.playerId]
      );
      const player = rows[0] || null;
      if (player) {
        // Every society this player belongs to, and which one is "current" —
        // from the session if they're still a member of it, else whichever
        // comes first. Kept as a separate is_society_admin field alongside the
        // player's global is_admin for now rather than merged into it — until
        // routes/authMiddleware.js's requireAdmin actually switches to reading
        // it, this has no behavioral effect (every existing player's society
        // membership was backfilled with is_society_admin = their is_admin).
        const { rows: memberships } = await db.query(
          `SELECT sm.society_id, sm.is_society_admin, s.name AS society_name, s.invite_code
           FROM society_members sm
           JOIN societies s ON s.id = sm.society_id
           WHERE sm.player_id = $1
           ORDER BY sm.joined_at ASC`,
          [player.id]
        );
        res.locals.mySocieties = memberships;
        let current = memberships.find((m) => m.society_id === req.session.currentSocietyId);
        if (!current && memberships.length > 0) current = memberships[0];
        req.session.currentSocietyId = current ? current.society_id : null;
        res.locals.currentSociety = current || null;
        res.locals.currentPlayer = { ...player, is_society_admin: current ? current.is_society_admin : false };
      }
      // Keep the session's admin flag in sync with the database on every
      // request — it's only ever set once at login otherwise, so a player
      // promoted/demoted after logging in would see admin controls (driven by
      // the fresh currentPlayer above) that then silently fail requireAdmin's
      // check against the stale session value.
      req.session.isAdmin = !!(res.locals.currentPlayer && res.locals.currentPlayer.is_admin);
    }
    const settings = await settingsPromise;
    res.locals.societyName = settings.society_name;
    res.locals.vapidPublicKey = process.env.VAPID_PUBLIC_KEY || null;
    res.locals.baseUrl = `${req.protocol}://${req.get('host')}`;
    res.locals.pairingSheetEnabled = settings.pairing_sheet_enabled !== 'false';
    res.locals.currentPath = req.path;
    next();
  })
);

// First-run setup gate: if no players exist yet, force the /setup flow. Once
// players exist they never go back to zero (nothing in the app deletes every
// player), so this only needs to actually hit the database until the first
// time it observes players present — after that a warm instance can trust
// its own memory instead of re-querying on every single request forever.
let playersConfirmedToExist = false;
app.use(
  asyncHandler(async (req, res, next) => {
    if (playersConfirmedToExist) return next();
    const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM players');
    if (rows[0].c === 0 && req.path !== '/setup') {
      return res.redirect('/setup');
    }
    if (rows[0].c > 0) playersConfirmedToExist = true;
    next();
  })
);

// See lib/onboardingGates.js — order matters (handicap confirmation first,
// society selection second) and each gate must exempt the other's target.
app.use(handicapConfirmationGate);
app.use(societyMembershipGate);

app.get('/', (req, res) => {
  if (!req.session.playerId) return res.redirect('/login');
  res.redirect('/dashboard');
});

app.use('/', require('./routes/setup'));
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/signup'));
app.use('/', require('./routes/onboarding'));
app.use('/', require('./routes/societies'));
app.use('/', require('./routes/push'));
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
