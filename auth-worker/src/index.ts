// auth-worker — the GitHub OAuth code→token exchange (Phase-0 write-back call).
//
// The static viewer can't hold the OAuth App's client SECRET (anything shipped
// to the browser is public), so this ~stateless Cloudflare Worker does the one
// step that needs it: swap the short-lived ?code from GitHub's redirect for an
// access token. Everything else — authorize redirect, commits via the Contents
// API — happens in the browser. Push access = edit rights, same as the PAT path.
//
// Endpoints:
//   POST /exchange  {code}  → 200 {token} | 4xx/5xx {error}
//   GET  /health            → 200 "ok"
//
// Hard rules:
//   • The client secret and the minted token appear in NO log, error, or echo.
//   • Browser callers must come from an origin in ALLOWED_ORIGINS (comma-
//     separated env var); anything else is refused. Requests with no Origin
//     header (curl, server-to-server) are not CORS requests and pass through.
//
// The pure helpers below are exported so the repo's vitest suite can unit-test
// them with a mocked fetch — no Cloudflare runtime needed.

/** The worker's environment: one public id, one secret, one origin allowlist. */
export interface Env {
  /** The GitHub OAuth App's client id (public — also shipped in the viewer). */
  GITHUB_CLIENT_ID: string;
  /** The OAuth App's client secret — set via `npx wrangler secret put`. */
  GITHUB_CLIENT_SECRET: string;
  /** Comma-separated origins allowed to call /exchange from a browser. */
  ALLOWED_ORIGINS?: string;
}

/** Where the viewer lives (GitHub Pages) + the local dev server. */
export const DEFAULT_ALLOWED_ORIGINS = [
  "https://toccotaco.github.io",
  "http://localhost:5173",
];

/** Parse the ALLOWED_ORIGINS var; empty/unset falls back to the defaults. */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return list.length > 0 ? list : DEFAULT_ALLOWED_ORIGINS;
}

/**
 * CORS decision for one request. Returns the headers to attach, or `null` if
 * the origin is present but NOT allowed (the caller must refuse). A missing
 * Origin header (curl, health probes) is not a CORS request: no headers needed.
 */
export function corsHeaders(
  origin: string | null,
  allowed: string[],
): Record<string, string> | null {
  if (origin === null) return {};
  if (!allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** What /exchange resolves to: an HTTP status plus the JSON body to send. */
export interface ExchangeOutcome {
  status: number;
  body: { token: string } | { error: string };
}

/**
 * Swap an authorization code for an access token via GitHub's token endpoint.
 * Never throws; never puts the secret or the token in an error message.
 *
 * GitHub quirk: a bad/expired/reused code comes back as HTTP 200 with an
 * `{error, error_description}` body — so success is "the body has a token",
 * not "the status was 200".
 */
export async function exchangeCodeForToken(
  code: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangeOutcome> {
  if (typeof code !== "string" || code.trim() === "") {
    return { status: 400, body: { error: "Missing authorization code." } };
  }

  let response: Response;
  try {
    response = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });
  } catch {
    return { status: 502, body: { error: "Could not reach GitHub." } };
  }

  if (!response.ok) {
    return {
      status: 502,
      body: { error: `GitHub responded with HTTP ${response.status}.` },
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return {
      status: 502,
      body: { error: "GitHub returned an unreadable response." },
    };
  }

  const obj = json as Record<string, unknown> | null;
  const token = obj?.access_token;
  if (typeof token === "string" && token !== "") {
    return { status: 200, body: { token } };
  }

  // 200-with-error: surface GitHub's own description (it never contains the
  // secret or a token — it's "bad_verification_code" style copy).
  const description =
    typeof obj?.error_description === "string" && obj.error_description !== ""
      ? obj.error_description
      : typeof obj?.error === "string" && obj.error !== ""
        ? obj.error
        : "GitHub rejected the authorization code.";
  return { status: 400, body: { error: description } };
}

function json(
  body: unknown,
  status: number,
  cors: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const cors = corsHeaders(request.headers.get("Origin"), allowed);

    // A browser origin we don't recognize: refuse outright (preflight included).
    if (cors === null) {
      return new Response(JSON.stringify({ error: "Origin not allowed." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200, headers: cors });
    }

    if (request.method === "POST" && url.pathname === "/exchange") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        body = null;
      }
      const code = (body as { code?: unknown } | null)?.code;
      const outcome = await exchangeCodeForToken(
        typeof code === "string" ? code : "",
        env.GITHUB_CLIENT_ID,
        env.GITHUB_CLIENT_SECRET,
      );
      return json(outcome.body, outcome.status, cors);
    }

    return json({ error: "Not found." }, 404, cors);
  },
};
