const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not set. Set it to a Postgres connection string (e.g. from Neon or Supabase).');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Most managed Postgres providers (Neon, Supabase, etc.) require SSL and use
  // a certificate that Node won't validate against a local CA bundle by default.
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

async function query(text, params) {
  return pool.query(text, params);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  handicap_index REAL NOT NULL DEFAULT 28.0,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  tee_name TEXT NOT NULL DEFAULT 'White',
  par INTEGER NOT NULL,
  course_rating REAL NOT NULL,
  slope_rating INTEGER NOT NULL,
  holes_count INTEGER NOT NULL DEFAULT 18,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS course_holes (
  id SERIAL PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  hole_number INTEGER NOT NULL,
  par INTEGER NOT NULL,
  stroke_index INTEGER NOT NULL,
  UNIQUE(course_id, hole_number)
);

CREATE TABLE IF NOT EXISTS competitions (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  comp_date DATE NOT NULL,
  format TEXT NOT NULL CHECK(format IN ('stableford','net_stroke','gross_stroke')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rounds (
  id SERIAL PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  handicap_index_used REAL NOT NULL,
  course_handicap INTEGER NOT NULL,
  gross_total INTEGER NOT NULL,
  net_total INTEGER NOT NULL,
  stableford_points INTEGER NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(competition_id, player_id)
);

CREATE TABLE IF NOT EXISTS hole_scores (
  id SERIAL PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  hole_number INTEGER NOT NULL,
  strokes INTEGER NOT NULL,
  UNIQUE(round_id, hole_number)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

let readyPromise = null;

// Idempotent — safe to run on every cold start. Cached per warm instance so
// we don't re-run it on every single request.
function ready() {
  if (!readyPromise) {
    readyPromise = pool.query(SCHEMA_SQL).catch((err) => {
      readyPromise = null; // allow retry on next request if it failed
      throw err;
    });
  }
  return readyPromise;
}

async function getSetting(key, fallback = null) {
  const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : fallback;
}

async function setSetting(key, value) {
  await query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value]
  );
}

// Run a function inside a transaction using a dedicated client.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, ready, getSetting, setSetting, withTransaction };
