import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadFile, saveFile, type GitHubTarget } from "./github";

// The write-back client is all about failure handling, so this suite is mostly a
// failure matrix. Every `GitHubError` kind has at least one case, and the final
// test proves the token appears in NONE of them. `fetch` is stubbed per-test and
// restored afterwards; each stub also RECORDS its calls so we can assert on the
// exact PUT body and on how many network round-trips a save actually made.

const TARGET: GitHubTarget = {
  owner: "nd-prop",
  repo: "first-light",
  branch: "main",
};
const PATH = "data/subgroups/engines.yaml";
// A distinctive token so the "never leaked" assertions are unmistakable.
const TOKEN = "ghp_SECRET_TOKEN_abc123";

// ── base64 helpers (mirror the module, so tests exercise the real round-trip) ──

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}
function unb64(s: string): string {
  const bin = atob(s.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
/** Simulate GitHub, which returns base64 with a newline every so often. */
function withNewlines(s: string): string {
  return s.replace(/(.{8})/g, "$1\n") + "\n";
}

// ── fetch stub ─────────────────────────────────────────────────────────────────

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}
type Responder = (url: string, init: RequestInit | undefined) => Response;

/** Queue of responders, consumed in order; records every call for assertions. */
function stubFetch(responders: Responder[]): { calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      const responder = responders[i++];
      if (!responder) throw new Error("test stub: unexpected extra fetch call");
      return responder(url, init); // may itself throw to simulate a network error
    }),
  );
  return { calls };
}

function jsonResponse(
  status: number,
  obj: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A well-formed Contents GET body for `text` at blob `sha`. */
function fileBody(text: string, sha: string) {
  return { content: withNewlines(b64(text)), sha, encoding: "base64" };
}

beforeEach(() => {
  // Each test installs its own stub; start from a clean slate.
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── loadFile ───────────────────────────────────────────────────────────────────

describe("loadFile", () => {
  it("happy path: decodes newline-wrapped base64 and unicode round-trips", async () => {
    const text = "tasks:\n  - id: x\n    name: ND ✦ propulsión — 火箭\n";
    const { calls } = stubFetch([
      () => jsonResponse(200, fileBody(text, "sha-load-1")),
    ]);

    const result = await loadFile(TARGET, PATH, TOKEN);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.text).toBe(text);
    expect(result.file.sha).toBe("sha-load-1");
    expect(result.file.path).toBe(PATH);
    // GET with ref=branch, path segments preserved.
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain(
      "/repos/nd-prop/first-light/contents/data/subgroups/engines.yaml",
    );
    expect(calls[0].url).toContain("ref=main");
  });

  it("401 → auth", async () => {
    stubFetch([() => jsonResponse(401, { message: "Bad credentials" })]);
    const result = await loadFile(TARGET, PATH, TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: "auth", message: "Bad credentials" });
  });

  it("403 without rate-limit headers → forbidden (no push access / SSO / missing scope)", async () => {
    stubFetch([
      () =>
        jsonResponse(
          403,
          { message: "Resource not accessible by personal access token" },
          { "x-ratelimit-remaining": "57" },
        ),
    ]);
    const result = await loadFile(TARGET, PATH, TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("forbidden");
    if (result.error.kind !== "forbidden") return;
    expect(result.error.message).toContain("not accessible");
  });

  it("403 rate-limited → rate-limited with resetAt parsed from x-ratelimit-reset", async () => {
    const resetEpoch = 1893456000; // 2030-01-01T00:00:00Z
    stubFetch([
      () =>
        jsonResponse(
          403,
          { message: "API rate limit exceeded" },
          {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetEpoch),
          },
        ),
    ]);
    const result = await loadFile(TARGET, PATH, TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: "rate-limited",
      resetAt: new Date(resetEpoch * 1000).toISOString(),
    });
  });

  it("429 → rate-limited even without a reset header (resetAt null)", async () => {
    stubFetch([() => jsonResponse(429, { message: "Too many requests" })]);
    const result = await loadFile(TARGET, PATH, TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: "rate-limited", resetAt: null });
  });

  it("404 → not-found", async () => {
    stubFetch([() => jsonResponse(404, { message: "Not Found" })]);
    const result = await loadFile(TARGET, PATH, TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: "not-found", message: "Not Found" });
  });

  it("fetch throws → network (no response)", async () => {
    stubFetch([
      () => {
        throw new Error("getaddrinfo ENOTFOUND api.github.com");
      },
    ]);
    const result = await loadFile(TARGET, PATH, TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("network");
    if (result.error.kind !== "network") return;
    expect(result.error.message).toContain("ENOTFOUND");
  });

  it("unexpected 500 → unexpected with status + message", async () => {
    stubFetch([() => jsonResponse(500, { message: "Server Error" })]);
    const result = await loadFile(TARGET, PATH, TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: "unexpected",
      status: 500,
      message: "Server Error",
    });
  });

  it("empty/whitespace token → no-token WITHOUT any network call", async () => {
    const { calls } = stubFetch([]);
    const result = await loadFile(TARGET, PATH, "   ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: "no-token" });
    expect(calls).toHaveLength(0);
  });
});

// ── saveFile ───────────────────────────────────────────────────────────────────

describe("saveFile", () => {
  const NEW_TEXT = "tasks:\n  - id: x\n    name: updated ✦ 火箭\n";
  const BASE = {
    sha: "base-sha",
    text: "tasks:\n  - id: x\n    name: original\n",
  };
  const MESSAGE = "engines: rename task x";

  it("happy path: PUT carries message/branch/sha and base64 round-trips to newText", async () => {
    const { calls } = stubFetch([
      () =>
        jsonResponse(201, {
          content: { sha: "new-sha" },
          commit: { sha: "commit-sha" },
        }),
    ]);

    const result = await saveFile(TARGET, PATH, NEW_TEXT, MESSAGE, BASE, TOKEN);

    expect(result).toEqual({
      ok: true,
      newSha: "new-sha",
      commitSha: "commit-sha",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    const body = JSON.parse(calls[0].body!);
    expect(body.message).toBe(MESSAGE);
    expect(body.branch).toBe("main");
    expect(body.sha).toBe("base-sha");
    expect(unb64(body.content)).toBe(NEW_TEXT);
  });

  it("no token → no-token, fetch NEVER called, unsavedText carried", async () => {
    const { calls } = stubFetch([]);
    const result = await saveFile(TARGET, PATH, NEW_TEXT, MESSAGE, BASE, "");
    expect(result).toEqual({
      ok: false,
      error: { kind: "no-token" },
      unsavedText: NEW_TEXT,
    });
    expect(calls).toHaveLength(0);
  });

  it("401 → auth, unsavedText carried", async () => {
    stubFetch([() => jsonResponse(401, { message: "Bad credentials" })]);
    const result = await saveFile(TARGET, PATH, NEW_TEXT, MESSAGE, BASE, TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: "auth", message: "Bad credentials" });
    expect(result.unsavedText).toBe(NEW_TEXT);
  });

  it("403 (no access) → forbidden, unsavedText carried", async () => {
    stubFetch([
      () =>
        jsonResponse(
          403,
          { message: "no write access" },
          { "x-ratelimit-remaining": "40" },
        ),
    ]);
    const result = await saveFile(TARGET, PATH, NEW_TEXT, MESSAGE, BASE, TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("forbidden");
    expect(result.unsavedText).toBe(NEW_TEXT);
  });

  it("404 → not-found, unsavedText carried", async () => {
    stubFetch([() => jsonResponse(404, { message: "Not Found" })]);
    const result = await saveFile(TARGET, PATH, NEW_TEXT, MESSAGE, BASE, TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: "not-found", message: "Not Found" });
    expect(result.unsavedText).toBe(NEW_TEXT);
  });

  it("fetch throws → network, unsavedText carried", async () => {
    stubFetch([
      () => {
        throw new Error("socket hang up");
      },
    ]);
    const result = await saveFile(TARGET, PATH, NEW_TEXT, MESSAGE, BASE, TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("network");
    expect(result.unsavedText).toBe(NEW_TEXT);
  });

  it("sha drift, identical content → auto-retry succeeds (exactly 2 PUTs + 1 GET)", async () => {
    // PUT #1 → 409; GET → same text as base but a fresh sha; PUT #2 → success.
    const { calls } = stubFetch([
      () => jsonResponse(409, { message: "does not match" }),
      () => jsonResponse(200, fileBody(BASE.text, "drifted-sha")),
      () =>
        jsonResponse(200, {
          content: { sha: "final-sha" },
          commit: { sha: "commit-2" },
        }),
    ]);

    const result = await saveFile(TARGET, PATH, NEW_TEXT, MESSAGE, BASE, TOKEN);

    expect(result).toEqual({
      ok: true,
      newSha: "final-sha",
      commitSha: "commit-2",
    });
    const methods = calls.map((c) => c.method);
    expect(methods).toEqual(["PUT", "GET", "PUT"]);
    // The retry PUT must carry the FRESH sha, not the stale base sha.
    expect(JSON.parse(calls[2].body!).sha).toBe("drifted-sha");
  });

  it("remote already equals newText → ok with no second PUT (no duplicate commit)", async () => {
    const { calls } = stubFetch([
      () => jsonResponse(409, { message: "sha does not match" }),
      () => jsonResponse(200, fileBody(NEW_TEXT, "remote-sha")),
    ]);

    const result = await saveFile(TARGET, PATH, NEW_TEXT, MESSAGE, BASE, TOKEN);

    expect(result).toEqual({ ok: true, newSha: "remote-sha", commitSha: "" });
    expect(calls.map((c) => c.method)).toEqual(["PUT", "GET"]);
  });

  it("real concurrent edit → conflict with remote text+sha; unsavedText intact", async () => {
    const remoteText =
      "tasks:\n  - id: x\n    name: SOMEONE ELSE edited this\n";
    stubFetch([
      () => jsonResponse(409, { message: "does not match" }),
      () => jsonResponse(200, fileBody(remoteText, "their-sha")),
    ]);

    const result = await saveFile(TARGET, PATH, NEW_TEXT, MESSAGE, BASE, TOKEN);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: "conflict",
      remote: { path: PATH, text: remoteText, sha: "their-sha" },
    });
    expect(result.unsavedText).toBe(NEW_TEXT);
  });

  it("422 whose message says 'does not match' is treated as a sha mismatch → reconciled", async () => {
    const remoteText = "tasks:\n  - id: x\n    name: concurrent\n";
    stubFetch([
      () =>
        jsonResponse(422, { message: "sha wasn't supplied or does not match" }),
      () => jsonResponse(200, fileBody(remoteText, "z-sha")),
    ]);
    const result = await saveFile(TARGET, PATH, NEW_TEXT, MESSAGE, BASE, TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("conflict");
  });

  it("422 that is NOT a sha mismatch → surfaced as unexpected, no reconcile GET", async () => {
    const { calls } = stubFetch([
      () => jsonResponse(422, { message: "Invalid request: content required" }),
    ]);
    const result = await saveFile(TARGET, PATH, NEW_TEXT, MESSAGE, BASE, TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: "unexpected",
      status: 422,
      message: "Invalid request: content required",
    });
    expect(calls).toHaveLength(1); // never re-fetched
  });

  it("retry after refresh fails again → surfaced as-is (no further loop), text carried", async () => {
    // PUT #1 → 409; GET → same-as-base (drift); PUT #2 → 500. Surface the 500.
    const { calls } = stubFetch([
      () => jsonResponse(409, { message: "does not match" }),
      () => jsonResponse(200, fileBody(BASE.text, "drift-2")),
      () => jsonResponse(500, { message: "Server Error" }),
    ]);

    const result = await saveFile(TARGET, PATH, NEW_TEXT, MESSAGE, BASE, TOKEN);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: "unexpected",
      status: 500,
      message: "Server Error",
    });
    expect(result.unsavedText).toBe(NEW_TEXT);
    expect(calls.map((c) => c.method)).toEqual(["PUT", "GET", "PUT"]); // stopped after 2nd PUT
  });

  it("mismatch, but the reconcile GET itself fails → that error surfaces with text", async () => {
    stubFetch([
      () => jsonResponse(409, { message: "does not match" }),
      () => jsonResponse(401, { message: "Bad credentials" }),
    ]);
    const result = await saveFile(TARGET, PATH, NEW_TEXT, MESSAGE, BASE, TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: "auth", message: "Bad credentials" });
    expect(result.unsavedText).toBe(NEW_TEXT);
  });
});

// ── the token must never leak ────────────────────────────────────────────────

describe("the token never appears in any error", () => {
  it("is absent from every error result — even when GitHub or the OS echoes it", async () => {
    const errors: unknown[] = [];

    // 1) auth error whose body maliciously echoes the token → must be redacted.
    stubFetch([
      () => jsonResponse(401, { message: `Bad credentials for ${TOKEN}` }),
    ]);
    errors.push((await loadFile(TARGET, PATH, TOKEN)) as unknown);
    vi.unstubAllGlobals();

    // 2) a network throw whose message contains the token → must be redacted.
    stubFetch([
      () => {
        throw new Error(`TLS error using ${TOKEN}`);
      },
    ]);
    errors.push((await loadFile(TARGET, PATH, TOKEN)) as unknown);
    vi.unstubAllGlobals();

    // 3) forbidden, 4) rate-limited, 5) not-found, 6) unexpected, 7) conflict, 8) no-token.
    stubFetch([
      () =>
        jsonResponse(
          403,
          { message: "nope" },
          { "x-ratelimit-remaining": "9" },
        ),
    ]);
    errors.push((await loadFile(TARGET, PATH, TOKEN)) as unknown);
    vi.unstubAllGlobals();

    stubFetch([
      () =>
        jsonResponse(
          403,
          { message: "rate" },
          { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" },
        ),
    ]);
    errors.push((await loadFile(TARGET, PATH, TOKEN)) as unknown);
    vi.unstubAllGlobals();

    stubFetch([() => jsonResponse(404, { message: "gone" })]);
    errors.push((await loadFile(TARGET, PATH, TOKEN)) as unknown);
    vi.unstubAllGlobals();

    stubFetch([() => jsonResponse(500, { message: `boom ${TOKEN}` })]);
    errors.push(
      (await saveFile(
        TARGET,
        PATH,
        "x",
        "m",
        { sha: "s", text: "t" },
        TOKEN,
      )) as unknown,
    );
    vi.unstubAllGlobals();

    stubFetch([
      () => jsonResponse(409, { message: "does not match" }),
      () => jsonResponse(200, fileBody("wholly different remote", "r")),
    ]);
    errors.push(
      (await saveFile(
        TARGET,
        PATH,
        "x",
        "m",
        { sha: "s", text: "t" },
        TOKEN,
      )) as unknown,
    );
    vi.unstubAllGlobals();

    errors.push(
      (await saveFile(
        TARGET,
        PATH,
        "x",
        "m",
        { sha: "s", text: "t" },
        "",
      )) as unknown,
    );

    // Every error result, serialized, must be free of the raw token.
    for (const e of errors) {
      expect(JSON.stringify(e)).not.toContain(TOKEN);
    }
    // And the redaction actually fired where the token was echoed.
    expect(JSON.stringify(errors[0])).toContain("[redacted]");
    expect(JSON.stringify(errors[1])).toContain("[redacted]");
  });
});
