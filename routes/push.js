const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireLogin } = require('../lib/authMiddleware');

const router = express.Router();

router.post(
  '/push/subscribe',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { endpoint, keys } = req.body.subscription || {};
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'Invalid subscription.' });
    }

    await db.query(
      `INSERT INTO push_subscriptions (player_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET player_id = EXCLUDED.player_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.session.playerId, endpoint, keys.p256dh, keys.auth]
    );

    res.json({ ok: true });
  })
);

router.post(
  '/push/unsubscribe',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { endpoint } = req.body;
    if (endpoint) {
      await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND player_id = $2', [endpoint, req.session.playerId]);
    }
    res.json({ ok: true });
  })
);

module.exports = router;
