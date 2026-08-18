const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

router.get(
  '/setup',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM players');
    if (rows[0].c > 0) return res.redirect('/login');
    res.render('setup', { error: null });
  })
);

router.post(
  '/setup',
  asyncHandler(async (req, res) => {
    const { rows: countRows } = await db.query('SELECT COUNT(*)::int AS c FROM players');
    if (countRows[0].c > 0) return res.redirect('/login');

    const { societyName, name, email, password, handicapIndex } = req.body;
    if (!name || !email || !password) {
      return res.render('setup', { error: 'Please fill in your name, email and a password.' });
    }

    const hash = bcrypt.hashSync(password, 10);
    const { rows } = await db.query(
      'INSERT INTO players (name, email, password_hash, handicap_index, is_admin) VALUES ($1, $2, $3, $4, TRUE) RETURNING id',
      [name.trim(), email.trim().toLowerCase(), hash, parseFloat(handicapIndex) || 28.0]
    );

    req.session.playerId = rows[0].id;
    req.session.isAdmin = true;

    await db.setSetting('society_name', (societyName || 'Golf Society').trim());

    res.redirect('/admin/courses/new?welcome=1');
  })
);

module.exports = router;
