const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'golf-society.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  handicap_index REAL NOT NULL DEFAULT 28.0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  tee_name TEXT NOT NULL DEFAULT 'White',
  par INTEGER NOT NULL,
  course_rating REAL NOT NULL,
  slope_rating INTEGER NOT NULL,
  holes_count INTEGER NOT NULL DEFAULT 18,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS course_holes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  hole_number INTEGER NOT NULL,
  par INTEGER NOT NULL,
  stroke_index INTEGER NOT NULL,
  UNIQUE(course_id, hole_number)
);

CREATE TABLE IF NOT EXISTS competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  comp_date TEXT NOT NULL,
  format TEXT NOT NULL CHECK(format IN ('stableford','net_stroke','gross_stroke')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  handicap_index_used REAL NOT NULL,
  course_handicap INTEGER NOT NULL,
  gross_total INTEGER NOT NULL,
  net_total INTEGER NOT NULL,
  stableford_points INTEGER NOT NULL,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(competition_id, player_id)
);

CREATE TABLE IF NOT EXISTS hole_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  hole_number INTEGER NOT NULL,
  strokes INTEGER NOT NULL,
  UNIQUE(round_id, hole_number)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

module.exports = db;
module.exports.getSetting = getSetting;
module.exports.setSetting = setSetting;
