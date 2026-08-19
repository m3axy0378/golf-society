const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireLogin } = require('../lib/authMiddleware');

const router = express.Router();

const MAX_LENGTH = 500;
const INITIAL_LOAD = 100;

function serializeMessage(row) {
  return {
    id: row.id,
    playerId: row.player_id,
    playerName: row.player_name,
    body: row.body,
    createdAt: row.created_at,
  };
}

router.get(
  '/bunker-banter',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT m.id, m.player_id, m.body, m.created_at, p.name AS player_name
       FROM chat_messages m
       JOIN players p ON p.id = m.player_id
       ORDER BY m.id DESC
       LIMIT $1`,
      [INITIAL_LOAD]
    );
    rows.reverse(); // oldest first, like a normal chat log
    res.render('bunker-banter', { messages: rows.map(serializeMessage) });
  })
);

// Polling endpoint — returns messages newer than afterId.
router.get(
  '/bunker-banter/messages',
  requireLogin,
  asyncHandler(async (req, res) => {
    const afterId = parseInt(req.query.afterId, 10) || 0;
    const { rows } = await db.query(
      `SELECT m.id, m.player_id, m.body, m.created_at, p.name AS player_name
       FROM chat_messages m
       JOIN players p ON p.id = m.player_id
       WHERE m.id > $1
       ORDER BY m.id ASC
       LIMIT 200`,
      [afterId]
    );
    res.json({ messages: rows.map(serializeMessage) });
  })
);

router.post(
  '/bunker-banter/messages',
  requireLogin,
  asyncHandler(async (req, res) => {
    const body = (req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Message is empty.' });
    if (body.length > MAX_LENGTH) return res.status(400).json({ error: `Messages are limited to ${MAX_LENGTH} characters.` });

    const { rows } = await db.query(
      `INSERT INTO chat_messages (player_id, body) VALUES ($1, $2)
       RETURNING id, player_id, body, created_at`,
      [req.session.playerId, body]
    );
    res.json({
      message: serializeMessage({ ...rows[0], player_name: res.locals.currentPlayer.name }),
    });
  })
);

router.post(
  '/bunker-banter/:id/delete',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT player_id FROM chat_messages WHERE id = $1', [req.params.id]);
    const msg = rows[0];
    if (msg && (msg.player_id === req.session.playerId || req.session.isAdmin)) {
      await db.query('DELETE FROM chat_messages WHERE id = $1', [req.params.id]);
    }
    res.json({ ok: true });
  })
);

module.exports = router;
