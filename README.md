# Golf Society App

A small web app for running your society's monthly golf competitions — different courses every month are fully supported, because every round is scored using the real World Handicap System maths (Course Handicap is calculated from each course's Course Rating, Slope Rating and par), not just raw strokes.

## What it does

- Each player has a login and a Handicap Index they keep up to date on their profile.
- An admin adds courses (hole-by-hole par and stroke index) and creates a competition each month, picking the course and the scoring format: Stableford, net stroke play, or gross stroke play.
- Players enter their own hole-by-hole score after their round. The app works out their Course Handicap for that course automatically and produces gross, net and Stableford results.
- Every competition has a leaderboard, and there's a season-long "Order of Merit" standings page that ranks players fairly across competitions even when the course or format changes — each competition awards ranking points (1st place gets the most), which are added up across the season.

## Running it locally

You'll need [Node.js](https://nodejs.org) 18 or later installed.

```bash
npm install
cp .env.example .env    # then edit .env and set your own SESSION_SECRET
npm start
```

Open http://localhost:3000 — since there are no players yet, you'll land on a one-time setup page to create your society name and the first admin account (that's you). From there:

1. Add a course (Admin → Courses → Add course) — you'll need the course's Course Rating, Slope Rating, and each hole's par and stroke index, all of which are on the course's scorecard.
2. Create a competition (Admin → New competition), picking that course and a scoring format.
3. Add your friends as players (Admin → Players) with a starting Handicap Index and a temporary password — send them their login details.

All data is stored in a single SQLite file at `db/golf-society.db`. Back that file up occasionally (or set up the automatic backups most hosts offer) — it's the only copy of your society's scores.

## Deploying it so your friends can use it

This app needs somewhere that (a) keeps running and (b) keeps its disk between deploys, since the database is just a file. A few options, roughly easiest-to-set-up first:

**Run it on a machine you already leave on** (a home server, NAS, or old laptop) and share access with [Tailscale](https://tailscale.com) (free for personal use — gives your friends a private URL without exposing the app to the whole internet) or [ngrok](https://ngrok.com). Just `npm start` there, ideally kept alive with a process manager like `pm2` (`npm install -g pm2 && pm2 start server.js --name golf-society`).

**Fly.io** — has a free allowance that includes a small persistent volume, which suits a single-file SQLite app well:
```bash
fly launch      # follow the prompts; say yes to a volume, mount it at /app/db
fly volumes create golf_data --size 1   # if not created during launch
fly deploy
```
Set `DB_PATH=/app/db/golf-society.db` and your `SESSION_SECRET` as Fly secrets (`fly secrets set ...`) so the database lives on the persistent volume rather than the app's ephemeral filesystem.

**Railway or Render** — both are simple "connect your repo and deploy" hosts. The free/trial tiers on both have changed a lot over time and don't reliably include a persistent disk, so check current pricing before relying on one for a database file — you may need their cheapest paid tier (a couple of dollars a month) to get persistent storage. If you'd rather not deal with disks at all, the schema in `db/index.js` is plain SQL, so swapping SQLite for a free hosted Postgres (e.g. Neon or Supabase both have free tiers) is a reasonably small change if you want to go that route later.

Whichever host you choose, remember to set `SESSION_SECRET` to your own random value (not the example one) and, if the host doesn't set `PORT` for you automatically, set it to whatever port they expect.

## Notes on the scoring

- Course Handicap = Handicap Index × (Slope Rating ÷ 113) + (Course Rating − Par), rounded to the nearest whole number — the standard WHS formula.
- Stableford points per hole follow the usual scale (net double-bogey or worse = 0, net bogey = 1, net par = 2, net birdie = 3, and so on).
- The season standings work by ranking players within each competition (best result = 1st) and awarding order-of-merit points (1st out of N players gets N points, last gets 1), then summing those points across the season. That's what makes results comparable across different courses and formats.
- Courses can be set up as 9 or 18 holes.

## Project structure

```
server.js           App entry point
db/index.js          SQLite schema + connection
lib/scoring.js        Course Handicap & Stableford maths
lib/standings.js       Season Order of Merit calculation
routes/               setup, auth, main (competitions/scores/season), admin
views/                EJS templates
public/style.css       Styling
```
