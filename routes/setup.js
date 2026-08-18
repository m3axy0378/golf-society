const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

router.get('/setup', (req, res) => {
  const playerCount = db.prepare('SELECT COUNT(*) AS c FROM players').get().c;
  if (playerCount > 0) return res.redirect('/login');
  res.render('setup', { error: null });
});

router.post('/setup', (req, res) => {
  const playerCount = db.prepare('SELECT COUNT(*) AS c FROM players').get().c;
  if (playerCount > 0) return res.redirect('/login');

  const { societyName, name, email, password, handicapIndex } = req.body;
  if (!name || !email || !password) {
    return res.render('setup', { error: 'Please fill in your name, email and a password.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare(
      'INSERT INTO players (name, email, password_hash, handicap_index, is_admin) VALUES (?, ?, ?, ?, 1)'
    )
    .run(name.trim(), email.trim().toLowerCase(), hash, parseFloat(handicapIndex) || 28.0);

  req.session.playerId = info.lastInsertRowid;
  req.session.isAdmin = true;

  db.setSetting('society_name', (societyName || 'Golf Society').trim());

  res.redirect('/admin/courses/new?welcome=1');
});

module.exports = router;
