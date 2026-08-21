const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const emailLib = require('../lib/email');

const router = express.Router();

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Counted per warm serverless instance rather than globally (no shared store
// like Redis behind this app), so under real multi-instance traffic the true
// limit is somewhat higher than the numbers below suggest — still enough to
// stop a casual password-guessing or reset-spam script hitting a single
// instance, which is the realistic threat for a golf society's user base.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('login', { error: 'Too many attempts. Please wait a few minutes and try again.', justReset: false });
  },
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('forgot-password', { sent: false, error: 'Too many requests. Please wait a few minutes and try again.' });
  },
});

router.get('/login', (req, res) => {
  if (req.session.playerId) return res.redirect('/dashboard');
  res.render('login', { error: null, justReset: req.query.reset === '1' });
});

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const { rows } = await db.query('SELECT * FROM players WHERE email = $1', [(email || '').trim().toLowerCase()]);
    const player = rows[0];

    if (!player || !bcrypt.compareSync(password || '', player.password_hash)) {
      return res.render('login', { error: 'Email or password not recognised.', justReset: false });
    }

    req.session.playerId = player.id;
    req.session.isAdmin = !!player.is_admin;
    res.redirect('/dashboard');
  })
);

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

router.get('/forgot-password', (req, res) => {
  if (req.session.playerId) return res.redirect('/dashboard');
  res.render('forgot-password', { sent: false, error: null });
});

router.post(
  '/forgot-password',
  forgotPasswordLimiter,
  asyncHandler(async (req, res) => {
    const email = (req.body.email || '').trim().toLowerCase();
    const { rows } = await db.query('SELECT id, name FROM players WHERE email = $1', [email]);
    const player = rows[0];

    if (player) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      await db.query('UPDATE players SET password_reset_token_hash = $1, password_reset_expires_at = $2 WHERE id = $3', [
        hashToken(token),
        expiresAt,
        player.id,
      ]);
      await emailLib.sendPasswordResetEmail({
        to: email,
        name: player.name,
        resetUrl: `${res.locals.baseUrl}/reset-password/${token}`,
        societyName: res.locals.societyName,
        baseUrl: res.locals.baseUrl,
      });
    }

    // Same response whether or not the email matched an account — otherwise
    // this form could be used to check who does and doesn't have one.
    res.render('forgot-password', { sent: true, error: null });
  })
);

router.get(
  '/reset-password/:token',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      'SELECT id FROM players WHERE password_reset_token_hash = $1 AND password_reset_expires_at > NOW()',
      [hashToken(req.params.token)]
    );
    if (!rows[0]) return res.render('reset-password', { valid: false, token: null, error: null });
    res.render('reset-password', { valid: true, token: req.params.token, error: null });
  })
);

router.post(
  '/reset-password/:token',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      'SELECT id FROM players WHERE password_reset_token_hash = $1 AND password_reset_expires_at > NOW()',
      [hashToken(req.params.token)]
    );
    const player = rows[0];
    if (!player) return res.render('reset-password', { valid: false, token: null, error: null });

    const { password } = req.body;
    if (!password || password.length < 8) {
      return res.render('reset-password', {
        valid: true,
        token: req.params.token,
        error: 'Password must be at least 8 characters.',
      });
    }

    await db.query(
      'UPDATE players SET password_hash = $1, password_reset_token_hash = NULL, password_reset_expires_at = NULL WHERE id = $2',
      [bcrypt.hashSync(password, 10), player.id]
    );
    res.redirect('/login?reset=1');
  })
);

module.exports = router;
