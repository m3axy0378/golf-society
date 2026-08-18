require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

const db = require('./db');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'db') }),
    secret: process.env.SESSION_SECRET || 'change-me-please-golf-society-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 90 }, // 90 days, so friends don't get logged out mid-season
  })
);

// Make current player + society name available to every view
app.use((req, res, next) => {
  res.locals.currentPlayer = null;
  if (req.session.playerId) {
    res.locals.currentPlayer = db
      .prepare('SELECT id, name, email, handicap_index, is_admin FROM players WHERE id = ?')
      .get(req.session.playerId);
  }
  res.locals.societyName = db.getSetting('society_name', 'Golf Society');
  next();
});

// First-run setup gate: if no players exist yet, force the /setup flow
app.use((req, res, next) => {
  const playerCount = db.prepare('SELECT COUNT(*) AS c FROM players').get().c;
  if (playerCount === 0 && req.path !== '/setup') {
    return res.redirect('/setup');
  }
  next();
});

app.get('/', (req, res) => {
  if (!req.session.playerId) return res.redirect('/login');
  res.redirect('/dashboard');
});

app.use('/', require('./routes/setup'));
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/main'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Golf society app running on http://localhost:${PORT}`);
});
