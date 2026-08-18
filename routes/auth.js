const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.playerId) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const { rows } = await db.query('SELECT * FROM players WHERE email = $1', [(email || '').trim().toLowerCase()]);
    const player = rows[0];

    if (!player || !bcrypt.compareSync(password || '', player.password_hash)) {
      return res.render('login', { error: 'Email or password not recognised.' });
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

module.exports = router;
