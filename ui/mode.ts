// ui/mode.ts — the tiny dark/light mode authority (DESIGN_DIRECTION §6).
//
// The rules, in one place so they're testable without a browser:
//   • default is DARK — it's the tool's identity;
//   • a stored choice (localStorage) sticks between visits;
//   • a `?mode=light` / `?mode=dark` URL param wins over the stored value AND is
//     persisted, so a projector/deep link can force a mode and it then sticks;
//   • anything invalid falls back to dark.
//
// resolveMode/applyMode take their storage + location-search as arguments, so
// the unit test can pass fakes and never touch a real DOM or Window.

export type Mode = "dark" | "light";

/** localStorage key. Kept in sync with the pre-paint script in index.html. */
export const STORAGE_KEY = "first-light:mode";

const DEFAULT_MODE: Mode = "dark";

/** The subset of the Storage API we depend on — lets tests inject a fake. */
export interface ModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isMode(value: string | null): value is Mode {
  return value === "dark" || value === "light";
}

/** Read a valid `?mode=` override from a location search string, else null. */
function modeFromSearch(search: string): Mode | null {
  const value = new URLSearchParams(search).get("mode");
  return isMode(value) ? value : null;
}

/**
 * Resolve the effective mode. URL param wins (and is persisted); otherwise the
 * stored value; otherwise dark. `search` is a `location.search` string
 * (e.g. "?mode=light"); `storage` is anything with get/setItem.
 */
export function resolveMode(search: string, storage: ModeStorage): Mode {
  const fromUrl = modeFromSearch(search);
  if (fromUrl) {
    storage.setItem(STORAGE_KEY, fromUrl);
    return fromUrl;
  }
  const stored = storage.getItem(STORAGE_KEY);
  return isMode(stored) ? stored : DEFAULT_MODE;
}

/** The opposite mode — used to label the toggle with what it switches *to*. */
export function otherMode(mode: Mode): Mode {
  return mode === "dark" ? "light" : "dark";
}

/** Stamp the mode on the root element and persist it. */
export function applyMode(
  mode: Mode,
  root: { setAttribute(name: string, value: string): void },
  storage: ModeStorage,
): void {
  root.setAttribute("data-mode", mode);
  storage.setItem(STORAGE_KEY, mode);
}

/** Current mode already stamped on the root (by the pre-paint script), else dark. */
export function readMode(root: {
  getAttribute(name: string): string | null;
}): Mode {
  const value = root.getAttribute("data-mode");
  return isMode(value) ? value : DEFAULT_MODE;
}
