const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

router.get('/signup', (req, res) => {
  if (req.session.playerId) return res.redirect('/dashboard');
  res.render('signup', { error: null, name: '', email: '' });
});

router.post(
  '/signup',
  asyncHandler(async (req, res) => {
    const { name, email, password, confirmPassword } = req.body;

    if (!name || !email || !password) {
      return res.render('signup', { error: 'Name, email and password are all required.', name: name || '', email: email || '' });
    }
    if (password.length < 8) {
      return res.render('signup', { error: 'Password must be at least 8 characters.', name, email });
    }
    if (password !== confirmPassword) {
      return res.render('signup', { error: 'Passwords do not match.', name, email });
    }

    try {
      const hash = bcrypt.hashSync(password, 10);
      const { rows } = await db.query(
        'INSERT INTO players (name, email, password_hash, handicap_confirmed_by_player) VALUES ($1, $2, $3, FALSE) RETURNING id, is_admin',
        [name.trim(), email.trim().toLowerCase(), hash]
      );
      const player = rows[0];
      req.session.playerId = player.id;
      req.session.isAdmin = !!player.is_admin;

      // Arrived via an invite link (GET /join/:code stashed the code here
      // before sending them to sign up) — join that society right away so
      // they land on a real dashboard instead of the "create or join a
      // society" gate every other brand-new signup hits.
      const pendingInviteCode = req.session.pendingInviteCode;
      if (pendingInviteCode) {
        delete req.session.pendingInviteCode;
        const { rows: societyRows } = await db.query('SELECT id FROM societies WHERE invite_code = $1', [pendingInviteCode]);
        if (societyRows[0]) {
          await db.query(
            'INSERT INTO society_members (society_id, player_id, is_society_admin) VALUES ($1, $2, FALSE) ON CONFLICT (society_id, player_id) DO NOTHING',
            [societyRows[0].id, player.id]
          );
          req.session.currentSocietyId = societyRows[0].id;
        }
      }

      // The server.js onboarding gate redirects here to /welcome/handicap
      // before this destination is ever reached, since handicap_confirmed_by_player
      // is FALSE — this is just where they land once that's done (or, with
      // no pending invite and no society yet, to /societies instead).
      res.redirect('/dashboard?enableNotifications=1');
    } catch (e) {
      if (e.code === '23505') {
        return res.render('signup', { error: 'That email is already registered — try logging in instead.', name, email });
      }
      throw e;
    }
  })
);

module.exports = router;
