// Two sequential gates in server.js's middleware chain, run in this order,
// that keep a logged-in player off pages that don't make sense yet until
// they've done a required setup step. Each one's exempt paths must include
// the OTHER gate's redirect target, or a player who's blocked by both at
// once (unconfirmed handicap AND zero societies — every brand-new self-
// signup with no invite code) bounces between the two forever instead of
// ever reaching either form. See test/onboardingGates.test.js for the
// regression coverage on exactly that failure mode.

// New self-signups start with handicap_confirmed_by_player = FALSE (see
// routes/signup.js) and must confirm their starting handicap on
// /welcome/handicap before reaching anywhere else — once confirmed the flag
// flips to TRUE for good, so this stops applying to them. Admin/setup-created
// players default TRUE and are never gated here.
function handicapConfirmationGate(req, res, next) {
  const player = res.locals.currentPlayer;
  if (player && !player.handicap_confirmed_by_player && req.path !== '/welcome/handicap' && req.path !== '/logout') {
    return res.redirect('/welcome/handicap');
  }
  next();
}

// A logged-in player with zero societies (a self-signup with no invite code)
// can't do anything useful yet — every page from here on assumes a current
// society. Send them to create or join one instead. Exempts /join/:code
// itself (so following an invite link works), /societies (the create form
// and its POST), /logout, and /welcome/handicap — that page must stay exempt
// here since it's the other gate's own redirect target; handicap
// confirmation is meant to happen first, society selection second.
function societyMembershipGate(req, res, next) {
  const player = res.locals.currentPlayer;
  const exempt =
    req.path === '/logout' || req.path === '/societies' || req.path === '/welcome/handicap' || req.path.startsWith('/join/');
  if (player && res.locals.mySocieties.length === 0 && !exempt) {
    return res.redirect('/societies');
  }
  next();
}

module.exports = { handicapConfirmationGate, societyMembershipGate };
