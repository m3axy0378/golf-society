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
        'INSERT INTO players (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, is_admin',
        [name.trim(), email.trim().toLowerCase(), hash]
      );
      const player = rows[0];
      req.session.playerId = player.id;
      req.session.isAdmin = !!player.is_admin;
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
