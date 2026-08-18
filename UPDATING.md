# Making changes going forward

The project is now a git repository (`git log` shows the initial commit), which makes changes trackable and — once it's on GitHub — deployable automatically. Here's the workflow.

## One-time: put it on GitHub

1. Go to [github.com/new](https://github.com/new) and create an empty repository (no README/license — this project already has those), e.g. `golf-society`.
2. In a terminal, inside this project folder:
   ```bash
   git remote add origin git@github.com:YOUR-USERNAME/golf-society.git
   git push -u origin main
   ```
   (Use the HTTPS URL GitHub gives you instead if you haven't set up an SSH key — it'll prompt you to log in.)

That's it — from now on, `git push` sends your latest changes to GitHub, and if your host is connected to that repo (see the README's deployment section), it redeploys automatically.

## Day to day: how a change happens

1. **Describe the change to me** (in this conversation, or a new one — just mention the golf society app) — e.g. "add a Texas Scramble format" or "let players see their handicap history". I'll make the edit, test it the same way I tested the original build, and hand you either the specific changed files or a fresh full copy.
2. **Bring the change into your copy of the project.** If you're working from the GitHub repo, this is:
   ```bash
   git add -A
   git commit -m "describe what changed"
   git push
   ```
3. **Redeploy**, if your host doesn't already do this automatically on push — check the README's deployment section for your specific host.

If you'd rather not touch a terminal at all, that's fine too — tell me the change, and I'll walk you through pasting a couple of commands, or just hand you a ready-to-run zip each time the way I did originally.

## If you start a new conversation with me

Each Cowork session gets its own private workspace, so I won't automatically remember this project's files in a brand-new session unless you re-share them (e.g. re-upload the zip, or point me at wherever you've saved it — including a connected folder on your computer, if you'd like me to keep a copy there). Once the project is on GitHub, that's the safest source of truth regardless of which session I'm in — just give me the repo and I can pick up from exactly where we left off.
