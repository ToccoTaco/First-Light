// ui/auth.test.ts — the pure parts of the sign-in flow. Fetches are exercised
// with injected fakes; nothing here touches the network, the DOM, or storage.

import { describe, it, expect, vi } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchLogin,
  isAuthConfigured,
  parseCallbackParams,
  randomState,
  stripCallbackParams,
} from "./auth";

describe("isAuthConfigured", () => {
  it("requires BOTH the client id and the worker url", () => {
    expect(isAuthConfigured("", "")).toBe(false);
    expect(isAuthConfigured("Iv1.abc", "")).toBe(false);
    expect(isAuthConfigured("", "https://w.dev")).toBe(false);
    expect(isAuthConfigured("  ", "https://w.dev")).toBe(false);
    expect(isAuthConfigured("Iv1.abc", "https://w.dev")).toBe(true);
  });
});

describe("randomState", () => {
  it("is long, url-safe hex, and different every call", () => {
    const a = randomState();
    const b = randomState();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("buildAuthorizeUrl", () => {
  it("targets GitHub's authorize endpoint with scope=repo and all params encoded", () => {
    const url = buildAuthorizeUrl({
      clientId: "Iv1.abc",
      redirectUri: "https://toccotaco.github.io/First-Light/",
      state: "s123",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(parsed.searchParams.get("client_id")).toBe("Iv1.abc");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://toccotaco.github.io/First-Light/",
    );
    expect(parsed.searchParams.get("scope")).toBe("repo");
    expect(parsed.searchParams.get("state")).toBe("s123");
  });
});

describe("parseCallbackParams", () => {
  it("extracts code + state when both are present", () => {
    expect(parseCallbackParams("?code=abc&state=xyz")).toEqual({
      code: "abc",
      state: "xyz",
    });
  });

  it("coexists with ?mode= and other params", () => {
    expect(parseCallbackParams("?mode=light&code=abc&state=xyz")).toEqual({
      code: "abc",
      state: "xyz",
    });
  });

  it("is null when either half is missing or empty — a plain visit is not a callback", () => {
    expect(parseCallbackParams("")).toBeNull();
    expect(parseCallbackParams("?mode=light")).toBeNull();
    expect(parseCallbackParams("?code=abc")).toBeNull();
    expect(parseCallbackParams("?state=xyz")).toBeNull();
    expect(parseCallbackParams("?code=&state=xyz")).toBeNull();
  });
});

describe("stripCallbackParams", () => {
  it("removes code and state, preserving ?mode= on the same URL", () => {
    expect(stripCallbackParams("?code=abc&state=xyz&mode=light")).toBe(
      "?mode=light",
    );
  });

  it("removes GitHub's error params too (user cancelled consent)", () => {
    expect(
      stripCallbackParams(
        "?error=access_denied&error_description=denied&error_uri=x&mode=dark",
      ),
    ).toBe("?mode=dark");
  });

  it("returns an empty string when nothing else remains", () => {
    expect(stripCallbackParams("?code=abc&state=xyz")).toBe("");
    expect(stripCallbackParams("")).toBe("");
  });

  it("leaves unrelated params in place", () => {
    expect(stripCallbackParams("?zoom=week&code=c&state=s&x=1")).toBe(
      "?zoom=week&x=1",
    );
  });
});

/** A fetch fake returning one canned response. */
function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("exchangeCode", () => {
  it("POSTs {code} to <worker>/exchange and returns the token", async () => {
    const f = fakeFetch(200, { token: "gho_tok" });
    const result = await exchangeCode("https://w.dev/", "the-code", f);
    expect(result).toEqual({ ok: true, token: "gho_tok" });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://w.dev/exchange"); // trailing slash normalized
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ code: "the-code" });
  });

  it("surfaces the worker's {error} message on failure", async () => {
    const f = fakeFetch(400, { error: "The code passed is incorrect." });
    const result = await exchangeCode("https://w.dev", "stale", f);
    expect(result).toEqual({
      ok: false,
      message: "The code passed is incorrect.",
    });
  });

  it("degrades to a status message when the body is not JSON", async () => {
    const f = vi.fn(
      async () => new Response("gateway timeout", { status: 504 }),
    ) as unknown as typeof fetch;
    const result = await exchangeCode("https://w.dev", "c", f);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("504");
  });

  it("never throws on a network failure", async () => {
    const f = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const result = await exchangeCode("https://w.dev", "c", f);
    expect(result.ok).toBe(false);
  });

  it("treats a 200 with no token as a failure, not a silent empty token", async () => {
    const f = fakeFetch(200, {});
    const result = await exchangeCode("https://w.dev", "c", f);
    expect(result.ok).toBe(false);
  });
});

describe("fetchLogin", () => {
  it("returns the login when /user succeeds", async () => {
    const f = fakeFetch(200, { login: "toccotaco" });
    expect(await fetchLogin("tok", f)).toBe("toccotaco");
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/user");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
  });

  it("returns null on any failure — bad status, bad shape, or a throw", async () => {
    expect(await fetchLogin("tok", fakeFetch(401, { message: "nope" }))).toBe(
      null,
    );
    expect(await fetchLogin("tok", fakeFetch(200, {}))).toBe(null);
    const thrower = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchLogin("tok", thrower)).toBe(null);
  });
});
