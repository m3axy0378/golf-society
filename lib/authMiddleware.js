function requireLogin(req, res, next) {
  if (!req.session.playerId) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.playerId) return res.redirect('/login');
  if (!req.session.isAdmin) return res.status(403).render('error', { message: "You need to be an admin to see that page." });
  next();
}

module.exports = { requireLogin, requireAdmin };
