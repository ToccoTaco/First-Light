import { describe, it, expect } from "vitest";
import {
  resolveMode,
  otherMode,
  readMode,
  applyMode,
  STORAGE_KEY,
  type Mode,
} from "./mode";

/** A minimal in-memory Storage stand-in — no browser needed. */
function fakeStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(STORAGE_KEY, initial);
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    get value() {
      return map.get(STORAGE_KEY) ?? null;
    },
  };
}

describe("resolveMode", () => {
  it("defaults to dark when nothing is stored and no URL param", () => {
    expect(resolveMode("", fakeStorage())).toBe("dark");
  });

  it("uses the stored value when there is no URL param", () => {
    expect(resolveMode("", fakeStorage("light"))).toBe("light");
    expect(resolveMode("", fakeStorage("dark"))).toBe("dark");
  });

  it("URL param wins over the stored value", () => {
    expect(resolveMode("?mode=light", fakeStorage("dark"))).toBe("light");
    expect(resolveMode("?mode=dark", fakeStorage("light"))).toBe("dark");
  });

  it("persists the URL param so it sticks on the next visit", () => {
    const store = fakeStorage("dark");
    resolveMode("?mode=light", store);
    expect(store.value).toBe("light");
    // Next load without the param now resolves from storage.
    expect(resolveMode("", store)).toBe("light");
  });

  it("falls back to dark on an invalid stored value", () => {
    expect(resolveMode("", fakeStorage("neon"))).toBe("dark");
  });

  it("falls back to dark on an invalid URL param (stored value still wins if valid)", () => {
    expect(resolveMode("?mode=neon", fakeStorage("light"))).toBe("light");
    expect(resolveMode("?mode=neon", fakeStorage())).toBe("dark");
  });

  it("tolerates other query params around mode", () => {
    expect(resolveMode("?zoom=week&mode=light&x=1", fakeStorage())).toBe("light");
  });
});

describe("otherMode", () => {
  it("flips the mode", () => {
    expect(otherMode("dark")).toBe("light");
    expect(otherMode("light")).toBe("dark");
  });
});

describe("applyMode + readMode", () => {
  it("stamps data-mode on the root and persists it", () => {
    let attr: string | null = null;
    const root = {
      setAttribute: (_n: string, v: string) => void (attr = v),
      getAttribute: () => attr,
    };
    const store = fakeStorage();
    applyMode("light", root, store);
    expect(attr).toBe("light");
    expect(store.value).toBe("light");
    expect(readMode(root)).toBe("light");
  });

  it("readMode falls back to dark on a missing/invalid attribute", () => {
    const missing = { getAttribute: () => null };
    const invalid = { getAttribute: () => "neon" };
    expect(readMode(missing)).toBe("dark");
    expect(readMode(invalid)).toBe("dark");
  });
});

// Type-level guard: Mode stays a two-member union.
const _exhaustive: Mode[] = ["dark", "light"];
void _exhaustive;
