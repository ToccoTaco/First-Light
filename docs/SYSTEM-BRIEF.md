# First Light — How the Whole System Works

A complete tour of the machinery: what runs where, why it's shaped this way, and
how to fix it yourself when something breaks. Written for a smart person who
isn't a web developer yet.

---

## The 30-second version

First Light is a **static site with git as its database**. There is no server
of ours anywhere — no machine we own, patch, restart, or pay for. The whole
system is four things:

```
┌─────────────────────────── GitHub ────────────────────────────┐
│                                                               │
│  The repo ──push──▶ Actions (robot) ──build──▶ Pages (host)   │
│   ▲  code + data        tests, build,           serves the    │
│   │  (YAML files)       bakes meta.json         website       │
│   │                                                  │        │
│   └────── save = commit (Contents API) ◀── your browser ◀─────┘
│                                              runs the app,
│                                              computes the
└──────────────┐                               schedule locally
               │ "swap login code for token"
               ▼
     Cloudflare Worker (≈100 lines, stateless)
     holds the one secret a public site can't
```

Everything intelligent — the scheduling engine, the chart, the dashboard math —
runs **in the viewer's browser**. GitHub stores files and serves files.
Cloudflare holds one secret. That's the entire operational footprint.

---

## The cast of characters

### 1. The repo — the single source of truth
Everything lives in `ToccoTaco/First-Light`: the app's source code, **and the
project data itself** (`data/project.yaml` + `data/subgroups/*.yaml`). This is
the "git is the backend" idea: instead of a database with accounts and backup
jobs, the data files sit in version control. Every save is a commit, so history,
authorship, diffs, backups, and undo all come for free — they're just git.

### 2. The viewer — a static single-page app
The app is written in **TypeScript + React** and compiled by **Vite** into
plain files (one `.js`, one `.css`, one `index.html`, the data, some assets).
"Static" means the host just hands those files to any browser that asks —
nothing executes on the server side. Once loaded, the browser does all the
work: it fetches the YAML files, merges them, runs the **scheduling engine**
(a pure-math module — dates in, schedule out), and draws the chart and
dashboard. This is why the site can be hosted anywhere for free: it's just
files.

### 3. GitHub Actions — the robot that builds and ships
`.github/workflows/deploy.yml` tells GitHub: *every time someone pushes to
master, run these steps on a fresh Linux machine you provide*. The steps:

1. **Check out the repo with FULL history and tags** (`fetch-depth: 0`) — not
   the usual shallow copy. This matters (see meta.json below).
2. Install dependencies (`npm ci`).
3. **Run `scripts/generate-meta.mjs`** — mines git history into
   `generated/meta.json`.
4. **Build** (`npm run build`) — type-checks and produces the `dist/` folder.
5. **Deploy** — uploads `dist/` to GitHub Pages.

A second workflow, `ci.yml`, runs the test suite and linter on every push. If
you see a red ✗ on a commit in GitHub, click it → the failing step's log tells
you exactly what broke.

### 4. GitHub Pages — the file host
Pages is GitHub's free static hosting. Our repo is configured (repo Settings →
Pages → Source: **GitHub Actions**) so the deploy workflow's upload becomes the
live site at `https://toccotaco.github.io/First-Light/`. Note the `/First-Light/`
subpath — the app is built with relative paths (`base: "./"`) so it works from
that subfolder.

### 5. meta.json — how a browser "reads git history" without git
Two dashboard features need git history: **staleness** ("Engines last updated
12 days ago") and the **baseline** (the plan as it was when you tagged
`baseline/<date>`). A browser can't run git commands, and hammering GitHub's
API anonymously would hit rate limits. So the deploy robot precomputes both
*at build time* — when it conveniently has the full clone — into
`generated/meta.json`: the last-commit date of each data file, plus the full
text of each data file as it existed at the newest `baseline/*` tag. The
browser fetches that one JSON file and, for slippage, literally runs the same
engine over the old data and diffs the two schedules. Setting a new baseline
is just `git tag baseline/2026-08-01 && git push --tags`.

### 6. Saving — commits from the browser via the Contents API
GitHub exposes a **REST API** (an HTTP interface for programs) that can read
and write repo files. When you hit Save, the app, for each changed file:

1. **Re-fetches the file from GitHub right now** and compares it to what it
   loaded originally. If someone else committed meanwhile → your save is
   stopped with a "changed on GitHub" error and a Reload button — your edits
   are never silently overwritten and theirs never clobbered. (This is the
   *concurrency guard*; the file's `sha` — a fingerprint of its content — is
   how the API detects mismatches.)
2. Sends the new file content with a commit message like
   `engines: update Injector fabrication (First Light)`.
3. GitHub records a real commit, authored by **you** (whoever's token it is).

That commit… triggers the deploy workflow, which rebuilds meta.json and the
site. The loop closes itself: **saving updates the dashboard's staleness
automatically.**

### 7. Auth — two doors to the same token
Writing to the repo requires a **token** (a revocable password that proves to
the API who you are). Push access to the repo = edit rights in the app; there
is no separate user system.

- **Door 1, PAT (fallback):** you create a fine-grained Personal Access Token
  on GitHub yourself and paste it into Settings.
- **Door 2, Sign in with GitHub (primary):** the OAuth flow, below.

Either way the token ends up in the same place: your browser's
**localStorage** — a small per-site key-value store that survives reloads but
never leaves your machine. The save code doesn't know or care which door the
token came through.

### 8. The OAuth flow and why Cloudflare exists at all
OAuth is the "Sign in with X" protocol. The dance:

1. App redirects you to GitHub: *"First Light (client id Ov23liV…) wants repo
   access."* A random `state` string rides along and is checked on return, so
   a forged redirect can't inject a token (CSRF protection).
2. You click Authorize. GitHub redirects back to the app with a one-time
   **code** in the URL.
3. The code must be exchanged for a token — and that exchange requires the
   OAuth App's **client secret**. Here's the whole reason Cloudflare is
   involved: **a static site cannot keep a secret.** Anything in our
   JavaScript is readable by anyone who opens dev tools. So the exchange
   happens in the one place we control that isn't public:
4. The app POSTs the code to the **Cloudflare Worker**
   (`https://first-light-auth.lptocco.workers.dev/exchange`). The worker —
   ~100 lines running on Cloudflare's servers — adds the secret, asks GitHub
   for the token, and passes the token back. It stores nothing, logs nothing,
   and only answers browsers from our origins (CORS allowlist).
5. The app stores the token, scrubs the code out of the URL, and greets you.

The worker is **stateless**: no database, no memory between requests. If it
were deleted, you'd redeploy it in one command and nothing would be lost.

---

## Where every setting lives

| Thing | Where | Change it how |
|---|---|---|
| OAuth App (name, callback URL, client id, secret) | GitHub → Settings → Developer settings → OAuth Apps | Web UI; callback URL must exactly match the Pages URL |
| Client secret (the only real secret) | Cloudflare Worker secret | `cd auth-worker && npx wrangler secret put GITHUB_CLIENT_SECRET` |
| Worker code + client id + allowed origins | `auth-worker/src/index.ts`, `auth-worker/wrangler.toml` | edit → `npx wrangler deploy` |
| Client id + worker URL (app side, public) | `ui/auth-config.ts` | edit → commit → push (Pages redeploys) |
| Pages hosting source | Repo Settings → Pages | must stay "GitHub Actions" |
| Build/deploy recipe | `.github/workflows/deploy.yml` | edit → push |
| Your token + owner/repo/branch | Browser localStorage key `first-light:github-settings` | app Settings modal (per browser, per person) |
| UI preferences (screen, filter, theme) | localStorage `fl-screen`, `fl-view`, `first-light:mode` | just use the app |
| Baselines | git tags `baseline/<date>` (newest wins) | `git tag baseline/2026-08-01 && git push --tags` |
| Project data | `data/*.yaml` | the app (Save), or any text editor + commit |

---

## When it breaks — the runbook

**Site is a white screen / old version after a push.**
Repo → **Actions** tab. Find the newest "Deploy to GitHub Pages" run. Red ✗ →
open it, read the failing step's log (usually a test or type error — fix,
push again). Green but still stale → hard-refresh (Ctrl+F5). If the deploy
step itself errors, check repo Settings → Pages still says "GitHub Actions".

**Save fails.** The error rows are written to be self-explanatory, but:
*auth/expired* → sign in again (or new PAT); *forbidden* → the account lacks
push access, or a PAT is missing "Contents: read and write"; *changed on
GitHub* → someone else saved first — Reload that file, redo your edit;
*not found* → owner/repo/branch in Settings are wrong (branch is `master`,
not `main`); *rate-limited* → wait for the time it names. Failed saves never
lose your edits — they stay staged in the browser.

**Sign-in bounces or errors.**
1. Is the worker up? Open `https://first-light-auth.lptocco.workers.dev/health`
   — expect `ok`.
2. Watch it live: `cd auth-worker && npx wrangler tail`, then attempt sign-in
   and read the log line.
3. "Incorrect client credentials" → secret is wrong/rotated: regenerate on the
   GitHub OAuth App page, `npx wrangler secret put GITHUB_CLIENT_SECRET`.
4. Browser console shows a CORS error → the site's origin isn't in
   `ALLOWED_ORIGINS` in `wrangler.toml` → add it, `npx wrangler deploy`.
5. Redirects to a 404 → the OAuth App's callback URL doesn't exactly match
   `https://toccotaco.github.io/First-Light/`.

**Staleness/baseline tiles say data is missing.**
`https://toccotaco.github.io/First-Light/generated/meta.json` should be real
JSON. If its fields are null, the deploy checkout lost history — confirm
`fetch-depth: 0` is still in deploy.yml. No baseline row at all → there's no
`baseline/*` tag pushed yet.

**Chart shows "schedule can't be drawn" / dashboard says Schedule paused.**
Not an infrastructure problem — a data conflict (usually a dependency cycle).
Open the banner at the top of the chart; it names the loop. Fix by removing a
dependency chip (or Discard).

**A bad edit got committed.**
It's git. Nothing is ever lost: revert the commit on GitHub (or
`git revert <sha>` + push) and the site rebuilds with the old data.

**Cloudflare account inaccessible entirely?**
Worst case you make a new account: `wrangler login`, `wrangler deploy`,
`wrangler secret put …`, update the URL in `ui/auth-config.ts`, push. Ten
minutes, nothing lost — and PAT sign-in keeps working the whole time.

---

## What it costs and where the limits are

Everything rides free tiers, with headroom measured in orders of magnitude:
GitHub Pages (100 GB bandwidth/month soft cap; the whole site is ~1 MB),
GitHub Actions (2,000 free minutes/month; a deploy takes ~1), Cloudflare
Workers (100,000 requests/day; sign-ins might be 5/week). The failure mode of
"success" here is essentially unreachable for a student team.

## Concepts you now actually know

- **Static site** — pre-built files served as-is; no server code, so nothing to maintain or hack.
- **SPA (single-page app)** — one HTML page whose JavaScript redraws everything; navigation never reloads.
- **CI/CD** — robots that test (Continuous Integration) and ship (Continuous Deployment) on every push.
- **REST API** — a program-friendly HTTP interface; the GitHub Contents API is how the browser writes commits.
- **Token** — a revocable, scoped password for APIs. PAT = you make it by hand; OAuth = it's issued by clicking Authorize.
- **OAuth** — the delegation protocol behind every "Sign in with…" button; the *client secret* is why a backend piece must exist.
- **Serverless / Worker** — your code runs on someone else's always-on machines, billed per request; you deploy functions, not servers.
- **CORS** — browsers refuse cross-site requests unless the target explicitly allows that origin; it's why the worker has an allowlist.
- **localStorage** — a per-site, per-browser stash that survives reloads; where your token and UI preferences live.
- **sha / content fingerprint** — how git and the API detect that a file changed; the backbone of the save conflict guard.
