function requireLogin(req, res, next) {
  if (!req.session.playerId) return res.redirect('/login');
  next();
}

// Admin-ness is per-society, not a global player flag — someone who's an
// admin of one society isn't automatically an admin of every society they
// belong to. res.locals.currentPlayer.is_society_admin reflects whichever
// society is currently selected (see server.js's currentPlayer middleware),
// so this always checks admin rights on the society the request is actually
// operating against.
function requireAdmin(req, res, next) {
  if (!req.session.playerId) return res.redirect('/login');
  if (!res.locals.currentPlayer || !res.locals.currentPlayer.is_society_admin) {
    return res.status(403).render('error', { message: "You need to be an admin to see that page." });
  }
  next();
}

module.exports = { requireLogin, requireAdmin };
