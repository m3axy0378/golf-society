const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const asyncHandler = require('../lib/asyncHandler');
const { requireLogin } = require('../lib/authMiddleware');

const router = express.Router();

function generateInviteCode() {
  return crypto.randomBytes(6).toString('hex');
}

// Word-of-mouth signups (no invite code) get a public list of every society
// on the deployment to join, instead of a "create your own" option — that's
// reserved for players who already belong to at least one (see
// canCreateSociety below). Only fetched when actually needed.
async function loadJoinableSocieties() {
  const { rows } = await db.query('SELECT id, name, invite_code FROM societies ORDER BY name');
  return rows;
}

// A brand-new player joins an existing society (from the list above or a
// code); starting a new one of their own is something only an existing
// member of *some* society can do from their own Societies page — except as
// a bootstrap fallback if literally no society exists yet to join, which
// would otherwise be a dead end.
function canCreateSociety(mySocieties, allSocieties) {
  return mySocieties.length > 0 || allSocieties.length === 0;
}

// Doubles as the "join a society" landing page (for a player who belongs to
// zero — see server.js's gate) and the "my societies" hub (switch between,
// or add another) for everyone else.
router.get(
  '/societies',
  requireLogin,
  asyncHandler(async (req, res) => {
    const allSocieties = res.locals.mySocieties.length === 0 ? await loadJoinableSocieties() : [];
    res.render('societies', {
      mySocieties: res.locals.mySocieties,
      currentSociety: res.locals.currentSociety,
      allSocieties,
      canCreate: canCreateSociety(res.locals.mySocieties, allSocieties),
      error: null,
    });
  })
);

router.post(
  '/societies',
  requireLogin,
  asyncHandler(async (req, res) => {
    const allSocieties = res.locals.mySocieties.length === 0 ? await loadJoinableSocieties() : [];
    const canCreate = canCreateSociety(res.locals.mySocieties, allSocieties);
    if (!canCreate) {
      return res.status(403).render('error', { message: 'Join an existing society first — you can create your own from there.' });
    }

    const name = (req.body.name || '').trim();
    if (!name) {
      return res.render('societies', {
        mySocieties: res.locals.mySocieties,
        currentSociety: res.locals.currentSociety,
        allSocieties,
        canCreate,
        error: 'Please enter a name for your society.',
      });
    }

    const societyId = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        'INSERT INTO societies (name, invite_code, created_by_player_id) VALUES ($1, $2, $3) RETURNING id',
        [name, generateInviteCode(), req.session.playerId]
      );
      await client.query('INSERT INTO society_members (society_id, player_id, is_society_admin) VALUES ($1, $2, TRUE)', [
        rows[0].id,
        req.session.playerId,
      ]);
      return rows[0].id;
    });

    req.session.currentSocietyId = societyId;
    res.redirect('/dashboard');
  })
);

// Switching between societies you're already a member of — the target must
// actually be one of res.locals.mySocieties, checked server-side rather than
// trusted from the posted id.
router.post(
  '/societies/switch',
  requireLogin,
  asyncHandler(async (req, res) => {
    const societyId = parseInt(req.body.societyId, 10);
    const isMine = res.locals.mySocieties.some((m) => m.society_id === societyId);
    if (isMine) req.session.currentSocietyId = societyId;
    res.redirect('/dashboard');
  })
);

// A manually-typed invite code (as opposed to clicking the link directly) —
// just forwards to the same /join/:code confirm page either way.
router.post(
  '/societies/join-by-code',
  requireLogin,
  asyncHandler(async (req, res) => {
    const code = (req.body.code || '').trim();
    res.redirect(`/join/${encodeURIComponent(code)}`);
  })
);

// Society-admin only, and only ever for the admin's own current society —
// regenerating invalidates the old link/code immediately.
router.post(
  '/societies/invite-code/regenerate',
  requireLogin,
  asyncHandler(async (req, res) => {
    if (!res.locals.currentPlayer.is_society_admin) {
      return res.status(403).render('error', { message: 'You need to be an admin to do that.' });
    }
    await db.query('UPDATE societies SET invite_code = $1 WHERE id = $2', [
      generateInviteCode(),
      res.locals.currentSociety.society_id,
    ]);
    res.redirect('/profile');
  })
);

// GET is side-effect-free on purpose (it's what a clicked link hits first):
// stash the code and send a logged-out visitor to sign up; show an already-
// logged-in visitor a confirm screen, or just switch them over if they're
// already a member. The actual join happens on the POST below.
router.get(
  '/join/:code',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT id, name FROM societies WHERE invite_code = $1', [req.params.code]);
    const society = rows[0];
    if (!society) return res.status(404).render('error', { message: 'That invite link is invalid or has expired.' });

    if (!req.session.playerId) {
      req.session.pendingInviteCode = req.params.code;
      return res.redirect('/signup');
    }

    const alreadyMember = res.locals.mySocieties.some((m) => m.society_id === society.id);
    if (alreadyMember) {
      req.session.currentSocietyId = society.id;
      return res.redirect('/dashboard');
    }

    res.render('join-society', { society, code: req.params.code, error: null });
  })
);

router.post(
  '/join/:code',
  requireLogin,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT id, name FROM societies WHERE invite_code = $1', [req.params.code]);
    const society = rows[0];
    if (!society) return res.status(404).render('error', { message: 'That invite link is invalid or has expired.' });

    await db.query(
      'INSERT INTO society_members (society_id, player_id, is_society_admin) VALUES ($1, $2, FALSE) ON CONFLICT (society_id, player_id) DO NOTHING',
      [society.id, req.session.playerId]
    );
    req.session.currentSocietyId = society.id;
    res.redirect('/dashboard');
  })
);

module.exports = router;
