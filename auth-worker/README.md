# auth-worker — "Sign in with GitHub" for First Light

A tiny, stateless Cloudflare Worker (free tier) that does the ONE step of the
GitHub OAuth web flow a static page can't: exchanging the short-lived `?code`
from GitHub's redirect for an access token, using the OAuth App's client
**secret** (which must never ship to the browser).

Everything else stays in the viewer: the authorize redirect, the token in
localStorage, and saves as commits via the GitHub Contents API. Push access =
edit rights, exactly like the PAT fallback — the token just arrives by a second
door. The PAT paste field in Settings keeps working regardless.

## Endpoints

| Route            | Behavior                                                        |
| ---------------- | --------------------------------------------------------------- |
| `POST /exchange` | Body `{"code": "..."}` → `200 {"token": "..."}` or `4xx/5xx {"error": "..."}` |
| `GET /health`    | `200 ok`                                                        |

CORS: browser calls are allowed only from origins in `ALLOWED_ORIGINS`
(comma-separated). Preflight (`OPTIONS`) is handled; other origins get `403`.
Requests with no `Origin` header (curl) pass through. The secret and the minted
token are never logged or echoed in any error.

## One-time setup

### 1. Register the GitHub OAuth App

GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
(register it on the org that owns the repo, or a maintainer account):

- **Application name:** `First Light` (what leads see on the consent screen)
- **Homepage URL:** `https://toccotaco.github.io/First-Light/`
- **Authorization callback URL:** `https://toccotaco.github.io/First-Light/`
  (the viewer itself — after consent GitHub redirects back here with `?code&state`)
- Leave "Device flow" off.

After creating it, note the **Client ID** and generate a **Client secret**.

> Dev note: an OAuth App has one callback URL, so sign-in from
> `http://localhost:5173` will be refused by GitHub unless you register a
> second OAuth App pointed at localhost. For local dev the PAT fallback is
> usually simpler.

### 2. Deploy the worker

From this directory (`auth-worker/`):

```sh
npx wrangler login                      # once — opens a browser to auth Cloudflare
# put the OAuth App's Client ID into wrangler.toml [vars] GITHUB_CLIENT_ID first
npx wrangler deploy
npx wrangler secret put GITHUB_CLIENT_SECRET   # paste the client secret at the prompt
```

`wrangler deploy` prints the worker URL, e.g.
`https://first-light-auth.<your-account>.workers.dev`.

### 3. Point the viewer at it

Edit `ui/auth-config.ts` in the repo root:

```ts
export const GITHUB_CLIENT_ID = "<the OAuth App client id>";
export const AUTH_WORKER_URL = "https://first-light-auth.<account>.workers.dev";
```

Commit and let Pages redeploy. While either value is empty the sign-in button
simply doesn't render and the app is PAT-only, exactly as before.

## Testing it

```sh
# health
curl https://first-light-auth.<account>.workers.dev/health
# → ok

# exchange with a junk code → GitHub's own error, no secret anywhere
curl -X POST https://first-light-auth.<account>.workers.dev/exchange \
  -H "Content-Type: application/json" -d '{"code":"junk"}'
# → {"error":"The code passed is incorrect or expired."} (HTTP 400)

# CORS refusal
curl -i -X POST https://first-light-auth.<account>.workers.dev/exchange \
  -H "Origin: https://evil.example" -d '{"code":"x"}'
# → HTTP 403 {"error":"Origin not allowed."}
```

End-to-end: open the deployed viewer → Settings → **Sign in with GitHub** →
consent → you land back in the app with a "Signed in as <login>" toast, and
saves commit under that identity.

## Changing the allowed origins

`ALLOWED_ORIGINS` lives in `wrangler.toml` under `[vars]` — edit the
comma-separated list (scheme + host, no path) and `npx wrangler deploy` again.
If it is unset/empty the worker falls back to
`https://toccotaco.github.io,http://localhost:5173`.

## Unit tests

The pure helpers (CORS decision, exchange mapping) are covered by
`src/index.test.ts`, which runs with the repo's root `npm test` using a mocked
fetch — no Cloudflare account or types required. This directory is excluded
from the app's `tsc -b` build; wrangler bundles it independently at deploy time.
