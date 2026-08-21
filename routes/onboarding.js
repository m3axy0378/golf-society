const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireLogin } = require('../lib/authMiddleware');

const router = express.Router();

router.get(
  '/welcome/handicap',
  requireLogin,
  asyncHandler(async (req, res) => {
    // Already confirmed (e.g. they bookmarked this or hit back) — nothing
    // left to do here, so send them on rather than showing the form again.
    if (res.locals.currentPlayer.handicap_confirmed_by_player) return res.redirect('/dashboard');
    res.render('onboarding-handicap', { error: null, handicapIndex: res.locals.currentPlayer.handicap_index });
  })
);

router.post(
  '/welcome/handicap',
  requireLogin,
  asyncHandler(async (req, res) => {
    if (res.locals.currentPlayer.handicap_confirmed_by_player) return res.redirect('/dashboard');

    const handicapIndex = parseFloat(req.body.handicapIndex);
    if (!Number.isFinite(handicapIndex)) {
      return res.render('onboarding-handicap', { error: 'Please enter a valid handicap index.', handicapIndex: req.body.handicapIndex });
    }

    await db.query('UPDATE players SET handicap_index = $1, handicap_confirmed_by_player = TRUE WHERE id = $2', [
      handicapIndex,
      req.session.playerId,
    ]);
    res.redirect('/dashboard?enableNotifications=1');
  })
);

module.exports = router;
