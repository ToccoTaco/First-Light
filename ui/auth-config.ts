// ui/auth-config.ts — deploy-time constants for "Sign in with GitHub".
//
// Fill these in AFTER registering the GitHub OAuth App and deploying the auth
// worker — the full runbook lives in auth-worker/README.md:
//
//   • GITHUB_CLIENT_ID — the OAuth App's client id
//     (GitHub → Settings → Developer settings → OAuth Apps). Public by design.
//   • AUTH_WORKER_URL  — the deployed worker's URL, e.g.
//     "https://first-light-auth.<account>.workers.dev". No trailing path needed.
//
// While EITHER is empty the sign-in button simply doesn't render and the app
// behaves exactly as before (PAT-paste only). Neither value is a secret — the
// client SECRET lives only in the worker, set via `wrangler secret put`.

export const GITHUB_CLIENT_ID = "";
export const AUTH_WORKER_URL = "";
