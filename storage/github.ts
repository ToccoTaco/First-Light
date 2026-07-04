// storage/github.ts — the write-back client: "save" = one commit via GitHub's
// Contents API. This is the PAT path (Phase-0 fallback/dev mode); the same
// requests work unchanged once an OAuth token is swapped in for the PAT.
//
// The whole point of this file is EXHAUSTIVE failure handling. Committing from a
// static page can fail a dozen ways — expired token, no push access, SSO wall,
// rate limit, someone else edited the same file a second ago, the network
// blinked — and a squad lead must NEVER lose the edit they just made or see a
// raw stack trace. So every path returns a typed `GitHubError`, and every failed
// save carries the user's unsaved text back out for the UI to re-offer.
//
// Two hard rules live here:
//   1. A genuinely concurrent edit is NEVER overwritten blind. We commit against
//      a known base sha; if the remote moved for real, we surface a `conflict`
//      with the remote copy so Phase-3 can offer reload-and-reapply.
//   2. The token appears in NO error, log, or return value — ever. If GitHub
//      were to echo it in a body, we redact it on the way out.
//
// Runs in BOTH the browser and node 22 (vitest): only globals — fetch,
// TextEncoder/TextDecoder, btoa/atob. No Buffer, no process, no DOM.

/** Which repo + branch a save targets. */
export interface GitHubTarget {
  owner: string;
  repo: string;
  branch: string;
}

/** A file as it exists on the remote: its path, decoded text, and blob sha. */
export interface LoadedFile {
  path: string;
  text: string;
  sha: string;
}

/**
 * Every way a GitHub call can go wrong, as a closed union so the UI can switch
 * on `kind` and show the right message. No free-form throws escape this module.
 */
export type GitHubError =
  // Nothing is configured — no token at all. (No network call was made.)
  | { kind: "no-token" }
  // 401 — the token is invalid, expired, or revoked. Re-authenticate.
  | { kind: "auth"; message: string }
  // 403 that is NOT a rate limit — no push access, an SSO wall, or a
  // fine-grained PAT missing this repo or the `contents:write` permission.
  | { kind: "forbidden"; message: string }
  // 403/429 rate limit. `resetAt` (if GitHub told us) is when it lifts.
  | { kind: "rate-limited"; resetAt: string | null }
  // 404 — bad owner/repo/branch/path, or a token that can't even SEE a private repo.
  | { kind: "not-found"; message: string }
  // A real concurrent edit: the remote file changed under us. `remote` is the
  // current copy so the UI can offer reload-and-reapply.
  | { kind: "conflict"; remote: LoadedFile }
  // fetch itself threw / never got a response (offline, DNS, CORS, cancelled).
  | { kind: "network"; message: string }
  // Anything else — carries GitHub's status and (redacted) message verbatim.
  | { kind: "unexpected"; status: number; message: string };

export type LoadResult =
  { ok: true; file: LoadedFile } | { ok: false; error: GitHubError };

export type SaveResult =
  | { ok: true; newSha: string; commitSha: string }
  // A failed save ALWAYS carries the user's text back — an edit is never lost.
  | { ok: false; error: GitHubError; unsavedText: string };

const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";

/**
 * Read one file from the repo. Returns its decoded text + blob sha (the sha you
 * hand back to `saveFile` as the base). Any failure comes back as a typed error.
 */
export async function loadFile(
  target: GitHubTarget,
  path: string,
  token: string,
): Promise<LoadResult> {
  if (isBlank(token)) return { ok: false, error: { kind: "no-token" } };

  const url = `${contentsUrl(target, path)}?ref=${encodeURIComponent(target.branch)}`;

  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers: authHeaders(token) });
  } catch (err) {
    return { ok: false, error: networkError(err, token) };
  }

  if (!response.ok) {
    return { ok: false, error: await classifyError(response, token) };
  }

  const file = await readFileResponse(response, path, token);
  if (!file.ok) return { ok: false, error: file.error };
  return { ok: true, file: file.value };
}

/**
 * Save (= commit) new text for one file. `base` is what we last loaded — its sha
 * proves we are editing the version we think we are, and its text lets us tell a
 * harmless sha drift apart from a real concurrent edit.
 *
 * On a sha mismatch we re-fetch and reconcile:
 *   • remote text === our new text  → someone saved the identical edit; success,
 *     no duplicate commit.
 *   • remote text === our base text → the sha drifted but content is unchanged;
 *     retry the commit ONCE with the fresh sha.
 *   • otherwise                     → a real concurrent edit; return `conflict`
 *     with the remote copy. Never overwrite it blind.
 */
export async function saveFile(
  target: GitHubTarget,
  path: string,
  newText: string,
  message: string,
  base: { sha: string; text: string },
  token: string,
): Promise<SaveResult> {
  // No token → fail BEFORE any network call, but still hand the text back.
  if (isBlank(token)) {
    return { ok: false, error: { kind: "no-token" }, unsavedText: newText };
  }

  const first = await putContents(
    target,
    path,
    newText,
    message,
    base.sha,
    token,
  );

  // fetch threw.
  if (first.kind === "threw") {
    return {
      ok: false,
      error: networkError(first.err, token),
      unsavedText: newText,
    };
  }

  const response = first.response;
  if (response.ok) {
    return await successFromPut(response, newText);
  }

  // A sha mismatch is the one error we try to reconcile rather than surface.
  if (await isShaMismatch(response, token)) {
    return await reconcile(target, path, newText, message, base, token);
  }

  // Every other status: surface it, text carried back.
  return {
    ok: false,
    error: await classifyError(response, token),
    unsavedText: newText,
  };
}

// ── save reconciliation ──────────────────────────────────────────────────────

/**
 * The remote sha didn't match. Re-fetch and decide: identical edit (success),
 * harmless drift (retry once), or a real conflict (surface the remote copy).
 */
async function reconcile(
  target: GitHubTarget,
  path: string,
  newText: string,
  message: string,
  base: { sha: string; text: string },
  token: string,
): Promise<SaveResult> {
  const fresh = await loadFile(target, path, token);
  if (!fresh.ok) {
    // Couldn't even read the current file — surface that error, keep the text.
    return { ok: false, error: fresh.error, unsavedText: newText };
  }
  const remote = fresh.file;

  // Someone already committed the very edit we're making → treat as done.
  // No commit was made by us, so commitSha is empty (honest: "no new commit").
  if (remote.text === newText) {
    return { ok: true, newSha: remote.sha, commitSha: "" };
  }

  // The sha moved but the content is what we based on → safe to retry once.
  if (remote.text === base.text) {
    const retry = await putContents(
      target,
      path,
      newText,
      message,
      remote.sha,
      token,
    );
    if (retry.kind === "threw") {
      return {
        ok: false,
        error: networkError(retry.err, token),
        unsavedText: newText,
      };
    }
    if (retry.response.ok) {
      return await successFromPut(retry.response, newText);
    }
    // A second failure is surfaced as-is — we do NOT loop again.
    return {
      ok: false,
      error: await classifyError(retry.response, token),
      unsavedText: newText,
    };
  }

  // Genuinely different remote content → a real concurrent edit. Never clobber.
  return {
    ok: false,
    error: { kind: "conflict", remote },
    unsavedText: newText,
  };
}

// ── the PUT + its response ─────────────────────────────────────────────────────

type PutOutcome =
  { kind: "response"; response: Response } | { kind: "threw"; err: unknown };

/** One Contents-API PUT (create-or-update). Never throws; wraps a fetch throw. */
async function putContents(
  target: GitHubTarget,
  path: string,
  newText: string,
  message: string,
  sha: string,
  token: string,
): Promise<PutOutcome> {
  const body = JSON.stringify({
    message,
    content: encodeBase64(newText),
    sha,
    branch: target.branch,
  });
  try {
    const response = await fetch(contentsUrl(target, path), {
      method: "PUT",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body,
    });
    return { kind: "response", response };
  } catch (err) {
    return { kind: "threw", err };
  }
}

/** Parse a successful PUT into the new blob sha + the commit sha. */
async function successFromPut(
  response: Response,
  newText: string,
): Promise<SaveResult> {
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  const content = (json as Record<string, unknown> | null)?.content as
    Record<string, unknown> | undefined;
  const commit = (json as Record<string, unknown> | null)?.commit as
    Record<string, unknown> | undefined;
  const newSha = typeof content?.sha === "string" ? content.sha : "";
  const commitSha = typeof commit?.sha === "string" ? commit.sha : "";
  // If GitHub gave us a well-formed success we return the shas; if the body was
  // somehow unreadable we still report success (the commit DID happen) with what
  // we have — but that would be an odd server, and never leaks the token.
  if (newSha) return { ok: true, newSha, commitSha };
  return {
    ok: false,
    error: {
      kind: "unexpected",
      status: response.status,
      message: "commit response had no file sha",
    },
    unsavedText: newText,
  };
}

/**
 * Does this failed response indicate a base-sha mismatch (the one thing we
 * reconcile)? A 409 always does. A 422 does only if GitHub's message says so
 * ("does not match") — other 422s (e.g. malformed request) are real errors.
 */
async function isShaMismatch(
  response: Response,
  token: string,
): Promise<boolean> {
  if (response.status === 409) return true;
  if (response.status === 422) {
    const message = await peekMessage(response, token);
    return message.toLowerCase().includes("does not match");
  }
  return false;
}

// ── error classification ───────────────────────────────────────────────────────

/**
 * Turn a non-ok Response into the right typed error. Never leaks the token.
 * Uses `peekMessage` (cached) so a 422 that was already probed by
 * `isShaMismatch` is not read a second time — a Response body reads only once.
 */
async function classifyError(
  response: Response,
  token: string,
): Promise<GitHubError> {
  const status = response.status;

  if (status === 401)
    return { kind: "auth", message: await peekMessage(response, token) };

  if (status === 403 || status === 429) {
    if (isRateLimited(response, status)) {
      return { kind: "rate-limited", resetAt: parseResetAt(response) };
    }
    return { kind: "forbidden", message: await peekMessage(response, token) };
  }

  if (status === 404)
    return { kind: "not-found", message: await peekMessage(response, token) };

  return {
    kind: "unexpected",
    status,
    message: await peekMessage(response, token),
  };
}

/** 429 is always a rate limit; a 403 is one only if the rate-limit headers say so. */
function isRateLimited(response: Response, status: number): boolean {
  if (status === 429) return true;
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryAfter = response.headers.get("retry-after");
  return remaining === "0" || retryAfter !== null;
}

/** `x-ratelimit-reset` is epoch seconds → ISO; anything else → null. */
function parseResetAt(response: Response): string | null {
  const reset = response.headers.get("x-ratelimit-reset");
  if (!reset) return null;
  const seconds = Number(reset);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

// ── reading responses ──────────────────────────────────────────────────────────

/** Decode a successful Contents GET into a LoadedFile. */
async function readFileResponse(
  response: Response,
  path: string,
  token: string,
): Promise<
  { ok: true; value: LoadedFile } | { ok: false; error: GitHubError }
> {
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    return { ok: false, error: networkError(err, token) };
  }
  const obj = json as Record<string, unknown> | null;
  const contentRaw = obj?.content;
  const sha = obj?.sha;
  if (typeof contentRaw !== "string" || typeof sha !== "string") {
    // A directory listing (array) or an unexpected shape lands here.
    return {
      ok: false,
      error: {
        kind: "unexpected",
        status: response.status,
        message: "response was not a file",
      },
    };
  }
  return { ok: true, value: { path, text: decodeBase64(contentRaw), sha } };
}

/**
 * Pull a human message out of a GitHub error body. GitHub sends
 * `{ "message": "...", "documentation_url": "..." }`; if the body isn't JSON we
 * fall back to the status text. Always redacted for the token.
 */
async function readMessage(response: Response, token: string): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  return redactToken(extractMessage(text, response), token);
}

/**
 * Like readMessage but for a response we may still need to reconcile: a Response
 * body can only be read once, so we read the text, keep the message, and don't
 * touch the body again. Callers of `isShaMismatch` and `classifyError` on the
 * SAME response would double-read — so a 422 that turns out NOT to be a mismatch
 * is re-classified from a cloned message, never a second body read.
 */
async function peekMessage(response: Response, token: string): Promise<string> {
  // We cache the parsed message on the response object so classifyError can reuse
  // it without a second (illegal) body read. Symbol keeps it off any real shape.
  const cached = (response as ResponseWithCache)[MESSAGE_CACHE];
  if (typeof cached === "string") return cached;
  const message = await readMessage(response, token);
  (response as ResponseWithCache)[MESSAGE_CACHE] = message;
  return message;
}

const MESSAGE_CACHE = Symbol("first-light:github-message");
type ResponseWithCache = Response & { [MESSAGE_CACHE]?: string };

function extractMessage(body: string, response: Response): string {
  if (body) {
    try {
      const json = JSON.parse(body) as { message?: unknown };
      if (typeof json.message === "string" && json.message) return json.message;
    } catch {
      // not JSON — fall through to the raw body
    }
    return body;
  }
  return response.statusText || `HTTP ${response.status}`;
}

// ── shared helpers ───────────────────────────────────────────────────────────

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
  };
}

function contentsUrl(target: GitHubTarget, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${API_BASE}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
    target.repo,
  )}/contents/${encodedPath}`;
}

function networkError(err: unknown, token: string): GitHubError {
  const raw = err instanceof Error ? err.message : String(err);
  return { kind: "network", message: redactToken(raw, token) };
}

function isBlank(token: string): boolean {
  return typeof token !== "string" || token.trim() === "";
}

/** Belt-and-suspenders: if the token ever appears in text, scrub it. */
function redactToken(text: string, token: string): string {
  if (token && text.includes(token))
    return text.split(token).join("[redacted]");
  return text;
}

// ── Unicode-safe base64 (works in browser AND node; no Buffer, no DOM) ─────────

/** UTF-8 text → base64. */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * base64 → UTF-8 text. The Contents API returns base64 with embedded newlines
 * every 60 chars, so strip ALL whitespace before decoding.
 */
function decodeBase64(b64: string): string {
  const clean = b64.replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
