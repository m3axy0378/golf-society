# Golf Society App

A small web app for running your society's monthly golf competitions — different courses every month are fully supported, because every round is scored using the real World Handicap System maths (Course Handicap is calculated from each course's Course Rating, Slope Rating and par), not just raw strokes.

**Live on Vercel:** https://golf-society-tee-league.vercel.app (project `golf-society` in the `Tee League` Vercel team). See "Finishing the Vercel setup" below — it needs a database connected before it'll actually work.

## What it does

- Each player has a login and a Handicap Index they keep up to date on their profile.
- An admin adds courses (hole-by-hole par and stroke index) and creates a competition each month, picking the course and the scoring format: Stableford, net stroke play, or gross stroke play.
- Players enter their own hole-by-hole score after their round. The app works out their Course Handicap for that course automatically and produces gross, net and Stableford results.
- Every competition has a leaderboard, and there's a season-long "Order of Merit" standings page that ranks players fairly across competitions even when the course or format changes — each competition awards ranking points (1st place gets the most), which are added up across the season.

## Architecture

This runs as an Express app deployed to Vercel as serverless functions, backed by Postgres (not SQLite — Vercel's functions don't have a persistent disk, so all data lives in a real database). Sessions are stored in a signed cookie rather than server-side, since that's what works correctly across stateless function instances.

## Finishing the Vercel setup

The code is deployed, but it needs two things added in the Vercel dashboard before it'll work (these need your account, so they couldn't be done automatically):

1. **Connect a database.** Open the `golf-society` project on vercel.com → **Storage** tab → **Connect Database** → choose a Postgres option (Neon is Vercel's native option) → pick the free plan → Connect. This automatically adds a `DATABASE_URL` environment variable to the project.
2. **Add a session secret.** Project → **Settings** → **Environment Variables** → add `SESSION_SECRET` with any long random string (e.g. generate one with `openssl rand -hex 32`).
3. **Redeploy** so the new environment variables take effect — Deployments tab → latest deployment → "..." menu → Redeploy (or just ask me to redeploy once you've done steps 1–2).

Once that's done, visiting the live URL will show the one-time setup page to create your society and first admin account, exactly like running it locally.

## Running it locally

You'll need [Node.js](https://nodejs.org) 18+ and a local Postgres (or a free cloud one — see above).

```bash
npm install
cp .env.example .env    # then edit .env: set DATABASE_URL and your own SESSION_SECRET
npm start
```

Open http://localhost:3000 — since there are no players yet, you'll land on a one-time setup page to create your society name and the first admin account (that's you). From there:

1. Add a course (Admin → Courses → Add course) — you'll need the course's Course Rating, Slope Rating, and each hole's par and stroke index, all of which are on the course's scorecard.
2. Create a competition (Admin → New competition), picking that course and a scoring format.
3. Add your friends as players (Admin → Players) with a starting Handicap Index and a temporary password — send them their login details.

## Notes on the scoring

- Course Handicap = Handicap Index × (Slope Rating ÷ 113) + (Course Rating − Par), rounded to the nearest whole number — the standard WHS formula.
- Stableford points per hole follow the usual scale (net double-bogey or worse = 0, net bogey = 1, net par = 2, net birdie = 3, and so on).
- The season standings work by ranking players within each competition (best result = 1st) and awarding order-of-merit points (1st out of N players gets N points, last gets 1), then summing those points across the season. That's what makes results comparable across different courses and formats.
- Courses can be set up as 9 or 18 holes.

## Project structure

```
server.js           App entry point (exports the Express app; Vercel runs it as a function)
db/index.js          Postgres schema + connection + query helpers
lib/scoring.js        Course Handicap & Stableford maths
lib/standings.js       Season Order of Merit calculation
lib/asyncHandler.js    Wraps async route handlers so errors reach the error page
routes/               setup, auth, main (competitions/scores/season), admin
views/                EJS templates
public/style.css       Styling
```
