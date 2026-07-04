// storage/meta.ts — the viewer's reader for build-time git metadata.
//
// Baselines and staleness are derived from git history, NOT from schema fields
// (brief §6.4). But the deployed viewer is a static page with no git and no live
// GitHub calls — so `scripts/generate-meta.mjs` computes this at DEPLOY time and
// writes it to `generated/meta.json`. This module just fetches that file.
//
// It degrades to `null` on EVERY sad path — missing file (a dev machine that
// never ran the script), a network blip, malformed JSON, or a wrong-shaped blob.
// The viewer must render fine without meta; staleness/baseline features simply
// go quiet. So `loadMeta` never throws and never returns a half-valid object.

/** ISO datetime string, e.g. "2026-07-04T18:00:00Z". */
type ISODateTime = string;

/** The newest `baseline/*` tag and the data-file contents captured at that tag. */
export interface BaselineMeta {
  tag: string;
  taggedAt: ISODateTime;
  /** repo-relative data path → the file's full text AT the baseline tag. */
  files: Record<string, string>;
}

/** The whole precomputed blob. Mirrors `scripts/generate-meta.mjs` output. */
export interface Meta {
  generatedAt: ISODateTime;
  /** repo-relative data path → ISO date of the last commit touching it (null = never committed). */
  staleness: Record<string, string | null>;
  /** Newest baseline, or null when the repo has no `baseline/*` tags yet. */
  baseline: BaselineMeta | null;
}

/** Same shape as the global `fetch`, narrowed to what we use. Injectable for tests. */
type FetchLike = (
  input: string,
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/**
 * Load `generated/meta.json` relative to the current page. Returns the parsed
 * Meta, or `null` if it is missing / unreachable / malformed. Never throws.
 *
 * The path is relative (no leading slash) so it resolves correctly under a
 * GitHub Pages project subpath (e.g. `/first-light/`).
 */
export async function loadMeta(fetchImpl?: FetchLike): Promise<Meta | null> {
  const doFetch: FetchLike | undefined =
    fetchImpl ??
    (typeof fetch === "function" ? (fetch as unknown as FetchLike) : undefined);
  if (!doFetch) return null;

  let response: { ok: boolean; json: () => Promise<unknown> };
  try {
    response = await doFetch("generated/meta.json");
  } catch {
    return null; // network / offline
  }
  if (!response.ok) return null; // 404 on a dev deploy that skipped the script

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return null; // not valid JSON
  }

  return isMeta(raw) ? raw : null; // wrong shape → treat as absent
}

// ── shape guard ──────────────────────────────────────────────────────────────

function isMeta(v: unknown): v is Meta {
  if (!isRecord(v)) return false;
  if (typeof v.generatedAt !== "string") return false;
  if (!isStringOrNullMap(v.staleness)) return false;
  return isBaseline(v.baseline);
}

function isBaseline(v: unknown): v is BaselineMeta | null {
  if (v === null) return true;
  if (!isRecord(v)) return false;
  if (typeof v.tag !== "string") return false;
  if (typeof v.taggedAt !== "string") return false;
  return isStringMap(v.files);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringOrNullMap(v: unknown): v is Record<string, string | null> {
  if (!isRecord(v)) return false;
  return Object.values(v).every((x) => x === null || typeof x === "string");
}

function isStringMap(v: unknown): v is Record<string, string> {
  if (!isRecord(v)) return false;
  return Object.values(v).every((x) => typeof x === "string");
}
