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
  course_id INTEGER REFERENCES courses(id),
  comp_date DATE NOT NULL,
  format TEXT NOT NULL CHECK(format IN ('stableford','net_stroke','gross_stroke')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Which course(s) a competition can be played on. A competition open to
-- everyone can span more than one course (e.g. two groups playing different
-- courses on the same day) — each player picks the one they actually played
-- when they submit their round.
CREATE TABLE IF NOT EXISTS competition_courses (
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  PRIMARY KEY (competition_id, course_id)
);

CREATE TABLE IF NOT EXISTS rounds (
  id SERIAL PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  course_id INTEGER REFERENCES courses(id),
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

-- Emoji reactions players can drop on each other's rounds within a
-- competition. One reaction per (round, player, emoji) — reacting again with
-- the same emoji is a toggle (handled in the app, by deleting the row).
CREATE TABLE IF NOT EXISTS round_reactions (
  id SERIAL PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(round_id, player_id, emoji)
);

-- Web Push subscriptions, one row per device/browser a player has enabled
-- notifications on. Endpoint is unique per browser install, so re-subscribing
-- the same device (e.g. after clearing site data) just updates its row.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Older deployments created "competitions.course_id"/"rounds" before
-- multi-course competitions existed. Relax/extend those in place and
-- backfill competition_courses + rounds.course_id from the old column so
-- existing data keeps working under the new model.
ALTER TABLE competitions ALTER COLUMN course_id DROP NOT NULL;
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS course_id INTEGER REFERENCES courses(id);

-- Who marked/verified the card. Required for new submissions (enforced in
-- the app, not the DB, since older rounds predate this and have none).
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS marker_id INTEGER REFERENCES players(id);

-- 'league' competitions count towards Handicap Index and the season Order of
-- Merit at normal points. 'sprint' ("9 Hole Sprint") competitions are
-- casual/social rounds that don't count towards either — just a leaderboard
-- for that competition. 'major' competitions count towards both, same as
-- league, but at double points towards the season Order of Merit.
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'league' CHECK (type IN ('league', 'sprint', 'major'));

-- Optional paid entry. The app never touches money or card details itself —
-- entry_fee_link just points at a payment page the admin sets up elsewhere
-- (PayPal.me, a Stripe Payment Link, etc.) and players are sent there to pay.
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS entry_fee_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS entry_fee_amount NUMERIC;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS entry_fee_link TEXT;

-- Superseded by the "entries" table below — kept in place (unused) rather
-- than dropped, since dropping columns is a destructive schema change.
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS entry_fee_paid BOOLEAN NOT NULL DEFAULT FALSE;

-- A player "entering" a competition is now a separate step from submitting a
-- score: clicking "Enter competition" creates a row here immediately, so
-- admins can see (and chase entry-fee payment for) everyone who's committed
-- to playing before any scores come in. Submitting a score auto-creates the
-- entry too, for players who go straight to scoring without entering first.
CREATE TABLE IF NOT EXISTS entries (
  id SERIAL PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entry_fee_paid BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE(competition_id, player_id)
);

-- One-time backfill: every existing round implies its player had already
-- "entered", carrying over whatever payment status was recorded on the old
-- rounds.entry_fee_paid column. ON CONFLICT DO NOTHING makes this safe to
-- leave in place — it only fills in rows that don't exist yet, so it can
-- never clobber a payment status an admin sets afterwards via the app.
INSERT INTO entries (competition_id, player_id, entry_fee_paid)
SELECT competition_id, player_id, entry_fee_paid FROM rounds
ON CONFLICT (competition_id, player_id) DO NOTHING;

INSERT INTO competition_courses (competition_id, course_id)
SELECT id, course_id FROM competitions WHERE course_id IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE rounds SET course_id = (
  SELECT course_id FROM competitions WHERE competitions.id = rounds.competition_id
) WHERE course_id IS NULL;

-- Location for weather lookups. city/county are optional and admin-editable
-- (used to steer the geocoding search); latitude/longitude are resolved
-- automatically the first time weather is requested for a course and then
-- cached here so it's a one-time lookup, not a fetch on every page load.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS county TEXT;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS latitude REAL;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS longitude REAL;

-- Cached weather (forecast or, once the date has passed, actual historical
-- conditions) per course per day, from the free/keyless Open-Meteo API.
-- Historical rows never change once fetched; forecast rows get refreshed
-- periodically (handled in lib/courseWeather.js) since a forecast firms up
-- as the date approaches, and eventually gets replaced by real data.
CREATE TABLE IF NOT EXISTS course_weather (
  id SERIAL PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  weather_date DATE NOT NULL,
  temp_max_c REAL,
  temp_min_c REAL,
  precipitation_mm REAL,
  wind_speed_max_kph REAL,
  weather_label TEXT,
  weather_emoji TEXT,
  is_forecast BOOLEAN NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(course_id, weather_date)
);

-- Tee-off groups an admin builds for a competition (who's playing with whom,
-- and when). Regenerating the sheet replaces every row for that competition
-- (handled in the app) rather than trying to diff/update in place.
CREATE TABLE IF NOT EXISTS pairing_groups (
  id SERIAL PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  group_number INTEGER NOT NULL,
  tee_time TEXT,
  UNIQUE(competition_id, player_id)
);

-- Postgres only auto-indexes primary keys and UNIQUE constraints — every
-- other foreign key used in a WHERE/JOIN below was getting a sequential
-- scan. The composite UNIQUE constraints above already cover lookups by
-- their leading column (e.g. rounds(competition_id, player_id) covers
-- "WHERE competition_id = ..."), so only the columns actually queried on
-- their own need an explicit index here.
CREATE INDEX IF NOT EXISTS idx_rounds_player_id ON rounds(player_id);
CREATE INDEX IF NOT EXISTS idx_entries_player_id ON entries(player_id);

-- Drives whether the dashboard shows the full marketing intro (first visit
-- ever) or just the Order of Merit summary (every visit after). Set once a
-- player's dashboard has rendered for them the first time.
ALTER TABLE players ADD COLUMN IF NOT EXISTS dashboard_intro_seen BOOLEAN NOT NULL DEFAULT FALSE;

-- An account for admin manual testing: functions exactly like a normal
-- player (can enter competitions, submit scores, everything) but is
-- filtered out of every competition leaderboard, the season standings/Order
-- of Merit, the handicaps list and other players' head-to-head stats, so
-- test data never pollutes what real players see. Only ever set from the
-- admin Players page.
ALTER TABLE players ADD COLUMN IF NOT EXISTS is_test_user BOOLEAN NOT NULL DEFAULT FALSE;

-- Self-service password reset. Only the SHA-256 hash of the reset token is
-- stored (never the raw token, which only ever exists in the emailed link),
-- and expires_at gives it a 1-hour window rather than leaving a valid link
-- live forever. Both are cleared once the password is actually reset.
ALTER TABLE players ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;

-- Gates the "enter your starting handicap" onboarding step (see
-- routes/onboarding.js): defaults TRUE so it backfills existing rows as
-- already-confirmed and admin/setup-created players (who already have an
-- admin-entered handicap) skip it too — only routes/signup.js's self-signup
-- INSERT sets this FALSE. Only controls whether the onboarding redirect
-- fires; it is NOT what locks self-editing (see handicap_locked below), since
-- admin/setup-created players default TRUE here but should keep the normal
-- editable-until-first-round behaviour on their Profile page.
ALTER TABLE players ADD COLUMN IF NOT EXISTS handicap_confirmed_by_player BOOLEAN NOT NULL DEFAULT TRUE;

-- Separate from handicap_confirmed_by_player above: this is what actually
-- stops a player hand-editing their own Handicap Index on Profile once
-- they've been through onboarding. Defaults FALSE (unlocked) for everyone,
-- including self-signups until they complete onboarding — only
-- routes/onboarding.js's POST handler ever sets it TRUE, and nothing ever
-- sets it back to FALSE. Existing players and admin/setup-created players are
-- unaffected: they keep the pre-existing "editable until your first
-- submitted round" behaviour, since that's a separate check in
-- routes/main.js's /profile handler.
ALTER TABLE players ADD COLUMN IF NOT EXISTS handicap_locked BOOLEAN NOT NULL DEFAULT FALSE;

-- Multi-society support. A "society" runs its own competitions independently
-- of any other society on this deployment; society_members is who belongs to
-- which, with a per-society admin flag (lib/authMiddleware.js's requireAdmin
-- checks this, not players.is_admin, so a society admin can't reach into
-- another society's admin tools). players stays the single global identity
-- (name/email/handicap/etc.) shared across every society a person belongs to
-- — handicap in particular is deliberately global, not per-society.
CREATE TABLE IF NOT EXISTS societies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  created_by_player_id INTEGER REFERENCES players(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS society_members (
  id SERIAL PRIMARY KEY,
  society_id INTEGER NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  is_society_admin BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(society_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_society_members_player_id ON society_members(player_id);

-- A competition belongs to exactly one society. Courses stay global/shared —
-- a real golf course isn't owned by one society, and different societies will
-- legitimately play the same one — so created_by_society_id here is
-- provenance only, never used to scope reads.
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS society_id INTEGER REFERENCES societies(id);
ALTER TABLE courses ADD COLUMN IF NOT EXISTS created_by_society_id INTEGER REFERENCES societies(id);

CREATE INDEX IF NOT EXISTS idx_competitions_society_id ON competitions(society_id);

-- One-time backfill: everything that exists today predates societies, so it
-- all belongs together in a single "default" society, with every existing
-- player added as a member (carrying over their global is_admin as that
-- society's initial is_society_admin) and every existing competition
-- assigned to it. Guarded so this only ever runs once, the first time this
-- deploys against a database with no societies yet. The invite code is built
-- from md5(random()) rather than a pgcrypto function like gen_random_bytes,
-- since extensions aren't guaranteed to be installable under every managed
-- Postgres provider's app-level connection user.
DO $$
DECLARE
  default_society_id INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM societies) THEN
    INSERT INTO societies (name, invite_code, created_by_player_id)
    VALUES (
      COALESCE((SELECT value FROM settings WHERE key = 'society_name'), 'Tee League'),
      substr(md5(random()::text || clock_timestamp()::text), 1, 12),
      (SELECT id FROM players ORDER BY is_admin DESC, id ASC LIMIT 1)
    )
    RETURNING id INTO default_society_id;

    INSERT INTO society_members (society_id, player_id, is_society_admin)
    SELECT default_society_id, id, is_admin FROM players;

    UPDATE competitions SET society_id = default_society_id WHERE society_id IS NULL;
  END IF;
END $$;

-- Both created_by_*_id columns above are provenance-only (never used to scope
-- a read — see the comments where they're declared) and were missing an
-- ON DELETE clause, so Postgres defaulted to blocking the delete outright:
-- removing a player who'd ever created a society (or, if a "delete a
-- society" tool is ever built, a society that had ever added a course)
-- failed with a raw foreign-key-violation 500 instead of just clearing the
-- reference. Looked up by (from-table, to-table) rather than a hardcoded
-- constraint name, since that's not guaranteed to match Postgres's
-- auto-generated default across every environment this has run in.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT conname INTO con_name FROM pg_constraint
    WHERE conrelid = 'societies'::regclass AND confrelid = 'players'::regclass AND contype = 'f';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE societies DROP CONSTRAINT %I', con_name);
  END IF;
  ALTER TABLE societies ADD CONSTRAINT societies_created_by_player_id_fkey
    FOREIGN KEY (created_by_player_id) REFERENCES players(id) ON DELETE SET NULL;

  SELECT conname INTO con_name FROM pg_constraint
    WHERE conrelid = 'courses'::regclass AND confrelid = 'societies'::regclass AND contype = 'f';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE courses DROP CONSTRAINT %I', con_name);
  END IF;
  ALTER TABLE courses ADD CONSTRAINT courses_created_by_society_id_fkey
    FOREIGN KEY (created_by_society_id) REFERENCES societies(id) ON DELETE SET NULL;
END $$;
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

// Batch form of getSetting — one round trip for several keys instead of one
// per key. Returns a plain { key: value } map, falling back per-key for any
// row that doesn't exist yet.
async function getSettings(keysWithFallbacks) {
  const keys = Object.keys(keysWithFallbacks);
  const { rows } = await query('SELECT key, value FROM settings WHERE key = ANY($1)', [keys]);
  const found = new Map(rows.map((r) => [r.key, r.value]));
  const result = {};
  for (const key of keys) {
    result[key] = found.has(key) ? found.get(key) : keysWithFallbacks[key];
  }
  return result;
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

module.exports = { pool, query, ready, getSetting, getSettings, setSetting, withTransaction };
