// ui/auth.ts — the "Sign in with GitHub" flow (OAuth web flow, Phase-0 call).
//
// The shape of the dance:
//   1. Settings → "Sign in with GitHub": we mint a random `state`, stash it in
//      sessionStorage, and do a FULL-PAGE redirect to GitHub's authorize page
//      (redirect_uri = the app's own origin+pathname — derived, never hardcoded,
//      because Pages serves us under /First-Light/).
//   2. GitHub redirects back with ?code&state. App.tsx validates the state
//      against sessionStorage (CSRF check), POSTs {code} to the auth worker,
//      and stores the returned token into the SAME settings blob the PAT path
//      uses — storage/github.ts never knows the difference.
//   3. code/state are scrubbed from the URL via history.replaceState; any other
//      params (?mode= especially) are preserved untouched.
//
// This module holds the pure/testable parts: URL building, param parsing and
// scrubbing, and the two fetches (worker exchange + identity lookup), both with
// an injectable fetch so tests never touch the network. The DOM wiring
// (sessionStorage, redirects, toasts) lives in App.tsx where DOM belongs.
//
// The token is treated exactly like the PAT: never logged, never echoed into
// an error message, stored only in this browser's localStorage.

/** sessionStorage key for the in-flight OAuth `state` (CSRF check). */
export const OAUTH_STATE_KEY = "first-light:oauth-state";

/** Sign-in renders only when BOTH deploy-time constants are filled in. */
export function isAuthConfigured(clientId: string, workerUrl: string): boolean {
  return clientId.trim() !== "" && workerUrl.trim() !== "";
}

/** A hex random `state` for the authorize round-trip (128 bits of entropy). */
export function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The GitHub authorize URL. scope=repo — the Contents API needs it to commit;
 * same reach as the PAT the settings field asks for.
 */
export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: "repo",
    state: opts.state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/** The two params GitHub sends back on the callback redirect. */
export interface CallbackParams {
  code: string;
  state: string;
}

/**
 * Extract ?code&state from a location.search string. Null unless BOTH are
 * present and non-empty — a bare ?mode=light (or anything else) is not a
 * callback and must never be mistaken for one.
 */
export function parseCallbackParams(search: string): CallbackParams | null {
  const params = new URLSearchParams(search);
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return null;
  return { code, state };
}

/**
 * Scrub the OAuth params (code/state, plus GitHub's error trio if the user
 * cancelled consent) out of a search string, PRESERVING everything else —
 * ?mode= keeps working on the same URL. Returns "" or "?...".
 */
export function stripCallbackParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of ["code", "state", "error", "error_description", "error_uri"]) {
    params.delete(key);
  }
  const rest = params.toString();
  return rest === "" ? "" : `?${rest}`;
}

/** The worker exchange, resolved: a token, or a plain-language failure. */
export type ExchangeResult =
  | { ok: true; token: string }
  | { ok: false; message: string };

/**
 * POST {code} to the auth worker and read back {token}. Never throws; every
 * failure becomes a message fit for a toast. The token appears in no message.
 */
export async function exchangeCode(
  workerUrl: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangeResult> {
  const url = `${workerUrl.replace(/\/+$/, "")}/exchange`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch {
    return {
      ok: false,
      message: "couldn't reach the sign-in service — check your connection",
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  const obj = json as Record<string, unknown> | null;

  const token = obj?.token;
  if (response.ok && typeof token === "string" && token !== "") {
    return { ok: true, token };
  }

  const message =
    typeof obj?.error === "string" && obj.error !== ""
      ? obj.error
      : `the sign-in service returned HTTP ${response.status}`;
  return { ok: false, message };
}

/**
 * Cheap identity check: GET /user with the fresh token. Returns the login on
 * success (which also proves the token works), null on ANY failure — the
 * caller degrades to a plain "Signed in" toast.
 */
export async function fetchLogin(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { login?: unknown } | null;
    return typeof json?.login === "string" && json.login !== ""
      ? json.login
      : null;
  } catch {
    return null;
  }
}
