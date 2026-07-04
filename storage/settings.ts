// storage/settings.ts — where a squad lead's GitHub write-back settings live.
//
// This holds the fine-grained Personal Access Token (PAT) and the repo target a
// lead saves to. It is the DEV / FALLBACK path from the Phase-0 calls: the lead
// pastes a PAT into a settings field and it is stashed in the browser.
//
// PLAINLY: the PAT lives in localStorage ON THE LEAD'S OWN MACHINE ONLY. It is
// never written to a data file, never committed, never sent anywhere except to
// github.com as an Authorization header. Clearing it (logout / "forget token")
// removes it from the browser. Treat it like a password.
//
// The storage backend is injectable so this module works in BOTH the browser
// (real localStorage) and node/vitest (a tiny stub). Nothing here touches the
// DOM beyond that seam, and nothing ever throws — bad stored JSON reads as null.

/** The write-back settings a lead configures once and we reuse on every save. */
export interface GitHubSettings {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

/**
 * The slice of the Web Storage API we actually use. Injecting this (rather than
 * reaching for the global `localStorage`) is what lets tests pass a stub and
 * lets node run with no DOM at all.
 */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** One key holds the whole settings blob, so save/clear are single operations. */
const SETTINGS_KEY = "first-light:github-settings";

/**
 * Read the stored settings, or `null` if nothing is stored or the stored value
 * is missing/corrupt. NEVER throws: a garbled blob (hand-edited, half-written,
 * or from an older version) is treated exactly like "not configured".
 */
export function getSettings(storage: StorageLike): GitHubSettings | null {
  let raw: string | null;
  try {
    raw = storage.getItem(SETTINGS_KEY);
  } catch {
    // Some browsers throw on storage access in private mode — treat as unset.
    return null;
  }
  if (raw === null || raw === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isSettingsShape(parsed)) return null;
  return {
    token: parsed.token,
    owner: parsed.owner,
    repo: parsed.repo,
    branch: parsed.branch,
  };
}

/** Persist the settings blob. Overwrites whatever was there. */
export function setSettings(
  storage: StorageLike,
  settings: GitHubSettings,
): void {
  storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/** Forget the token + target entirely (the "log out" / "forget token" action). */
export function clearSettings(storage: StorageLike): void {
  storage.removeItem(SETTINGS_KEY);
}

// ── internals ────────────────────────────────────────────────────────────────

function isSettingsShape(v: unknown): v is GitHubSettings {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.token === "string" &&
    typeof o.owner === "string" &&
    typeof o.repo === "string" &&
    typeof o.branch === "string"
  );
}
