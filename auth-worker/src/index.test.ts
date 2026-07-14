// auth-worker unit tests — the pure helpers plus the fetch handler, all with a
// mocked fetch. No Cloudflare runtime or types needed: node 22 has Request /
// Response / URL as globals, which is everything the worker touches.

import { describe, it, expect, vi, afterEach } from "vitest";
import worker, {
  DEFAULT_ALLOWED_ORIGINS,
  corsHeaders,
  exchangeCodeForToken,
  parseAllowedOrigins,
  type Env,
} from "./index";

const SECRET = "shh-super-secret";
const ENV: Env = {
  GITHUB_CLIENT_ID: "Iv1.abc123",
  GITHUB_CLIENT_SECRET: SECRET,
  ALLOWED_ORIGINS: "https://toccotaco.github.io,http://localhost:5173",
};

/** A fetch stand-in that returns a canned response and records its calls. */
function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseAllowedOrigins", () => {
  it("falls back to the defaults when unset or empty", () => {
    expect(parseAllowedOrigins(undefined)).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(parseAllowedOrigins("")).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(parseAllowedOrigins(" , ")).toEqual(DEFAULT_ALLOWED_ORIGINS);
  });

  it("splits on commas and trims whitespace", () => {
    expect(parseAllowedOrigins("https://a.dev , http://b.local")).toEqual([
      "https://a.dev",
      "http://b.local",
    ]);
  });
});

describe("corsHeaders", () => {
  const allowed = ["https://toccotaco.github.io"];

  it("treats a missing Origin (curl) as a non-CORS request: no headers, allowed", () => {
    expect(corsHeaders(null, allowed)).toEqual({});
  });

  it("echoes an allowed origin back", () => {
    const h = corsHeaders("https://toccotaco.github.io", allowed);
    expect(h?.["Access-Control-Allow-Origin"]).toBe(
      "https://toccotaco.github.io",
    );
    expect(h?.["Access-Control-Allow-Methods"]).toContain("POST");
  });

  it("returns null (refuse) for an origin not on the list", () => {
    expect(corsHeaders("https://evil.example", allowed)).toBeNull();
  });
});

describe("exchangeCodeForToken", () => {
  it("returns the token when GitHub grants one", async () => {
    const f = fakeFetch(200, { access_token: "gho_tok", token_type: "bearer" });
    const out = await exchangeCodeForToken("good-code", "id", SECRET, f);
    expect(out).toEqual({ status: 200, body: { token: "gho_tok" } });
    // The exchange hit GitHub's token endpoint with a JSON Accept header.
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect((init.headers as Record<string, string>).Accept).toBe(
      "application/json",
    );
  });

  it("maps GitHub's 200-with-error (bad code) to a 400 with the description", async () => {
    const f = fakeFetch(200, {
      error: "bad_verification_code",
      error_description: "The code passed is incorrect or expired.",
    });
    const out = await exchangeCodeForToken("stale", "id", SECRET, f);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({
      error: "The code passed is incorrect or expired.",
    });
  });

  it("rejects an empty code without calling GitHub", async () => {
    const f = fakeFetch(200, {});
    const out = await exchangeCodeForToken("  ", "id", SECRET, f);
    expect(out.status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it("maps a network throw to 502", async () => {
    const f = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const out = await exchangeCodeForToken("code", "id", SECRET, f);
    expect(out.status).toBe(502);
  });

  it("maps a non-ok GitHub status to 502", async () => {
    const f = fakeFetch(503, {});
    const out = await exchangeCodeForToken("code", "id", SECRET, f);
    expect(out.status).toBe(502);
  });

  it("never leaks the client secret in any outcome body", async () => {
    const cases = [
      fakeFetch(200, { error: "bad_verification_code" }),
      fakeFetch(500, {}),
      vi.fn(async () => {
        throw new Error("boom");
      }) as unknown as typeof fetch,
    ];
    for (const f of cases) {
      const out = await exchangeCodeForToken("code", "id", SECRET, f);
      expect(JSON.stringify(out.body)).not.toContain(SECRET);
    }
  });
});

describe("worker.fetch (routing + CORS end to end)", () => {
  const ORIGIN = "https://toccotaco.github.io";

  it("answers an allowed preflight with 204 + CORS headers", async () => {
    const req = new Request("https://w.dev/exchange", {
      method: "OPTIONS",
      headers: { Origin: ORIGIN },
    });
    const res = await worker.fetch(req, ENV);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("refuses any request from an origin not on the list", async () => {
    const req = new Request("https://w.dev/exchange", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      body: JSON.stringify({ code: "x" }),
    });
    const res = await worker.fetch(req, ENV);
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("GET /health returns 200 ok", async () => {
    const res = await worker.fetch(new Request("https://w.dev/health"), ENV);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("POST /exchange returns {token} on success, with CORS for the caller", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch(200, { access_token: "gho_live" }) as unknown as typeof fetch,
    );
    const req = new Request("https://w.dev/exchange", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "the-code" }),
    });
    const res = await worker.fetch(req, ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "gho_live" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("POST /exchange with a malformed body reads as a missing code (400)", async () => {
    const req = new Request("https://w.dev/exchange", {
      method: "POST",
      headers: { Origin: ORIGIN },
      body: "not json",
    });
    const res = await worker.fetch(req, ENV);
    expect(res.status).toBe(400);
  });

  it("unknown routes are 404", async () => {
    const res = await worker.fetch(new Request("https://w.dev/nope"), ENV);
    expect(res.status).toBe(404);
  });
});
