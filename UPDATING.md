# Making changes going forward

The project is now a git repository (`git log` shows the initial commits), and it's deployed to Vercel (project `golf-society` in the `Tee League` team). Here's how to keep making changes.

## The easy way: ask me, I redeploy directly

Since I'm connected to your Vercel account for this project, the simplest loop is:

1. Tell me what you want changed (in this conversation, or a new one — just mention the golf society app).
2. I make the edit, test it against a real Postgres the same way I tested the original build, and redeploy straight to Vercel.
3. You refresh the live URL.

No terminal, no git required on your end for this path. The one thing I can't do myself is anything that needs your Vercel account directly — connecting the database, adding environment variables, custom domains, billing — those need you in the dashboard (see README.md's "Finishing the Vercel setup").

## The GitHub way: auto-deploy on push

If you'd rather changes deploy automatically whenever code is pushed (useful if you start editing things yourself, or want a review step), put the repo on GitHub and link it to the Vercel project:

1. Go to [github.com/new](https://github.com/new) and create an empty repository, e.g. `golf-society`.
2. In a terminal, inside this project folder:
   ```bash
   git remote add origin git@github.com:YOUR-USERNAME/golf-society.git
   git push -u origin main
   ```
3. In the Vercel dashboard, open the `golf-society` project → Settings → Git → connect it to that GitHub repo (or ask me to do this via `create_git_project` once the repo exists).

From then on, `git push` deploys automatically — no need to ask me to redeploy.

## If you start a new conversation with me

Each Cowork session gets its own private workspace, so I won't automatically remember this project's files in a brand-new session. What persists regardless of session is the live Vercel project itself (I can look it up by name/team) and, once you've done the GitHub step above, the repo. Mention "the golf society app on Vercel" and I can pick things up from there even without the original files.
