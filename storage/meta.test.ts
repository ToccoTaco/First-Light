import { describe, it, expect } from "vitest";
import { loadMeta, type Meta } from "./meta";

// loadMeta must degrade to null on EVERY sad path — a dev machine that never ran
// the meta script, a network blip, garbage JSON, or a wrong-shaped blob — so the
// viewer renders fine without staleness/baseline data. These stub `fetch` with a
// tiny fake (just `ok` + `json`) rather than a real Response, matching the
// narrow FetchLike the module accepts.

function fetchReturning(ok: boolean, json: () => Promise<unknown>) {
  return async () => ({ ok, json });
}

const GOOD: Meta = {
  generatedAt: "2026-07-04T00:00:00.000Z",
  staleness: {
    "data/project.yaml": "2026-07-01T12:00:00-04:00",
    "data/subgroups/engines.yaml": null,
  },
  baseline: {
    tag: "baseline/2026-06-01",
    taggedAt: "2026-06-01T09:00:00-04:00",
    files: { "data/project.yaml": "project: ND\n" },
  },
};

describe("loadMeta", () => {
  it("happy path: returns the parsed Meta (including a null baseline)", async () => {
    const meta = await loadMeta(fetchReturning(true, async () => GOOD));
    expect(meta).toEqual(GOOD);
  });

  it("accepts a null baseline (repo with no baseline tags yet)", async () => {
    const noBaseline = { ...GOOD, baseline: null };
    const meta = await loadMeta(fetchReturning(true, async () => noBaseline));
    expect(meta).toEqual(noBaseline);
  });

  it("404 (file missing) → null", async () => {
    const meta = await loadMeta(fetchReturning(false, async () => ({})));
    expect(meta).toBeNull();
  });

  it("fetch throws (offline) → null", async () => {
    const meta = await loadMeta(async () => {
      throw new Error("network down");
    });
    expect(meta).toBeNull();
  });

  it("invalid JSON body → null", async () => {
    const meta = await loadMeta(
      fetchReturning(true, async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      }),
    );
    expect(meta).toBeNull();
  });

  it("wrong shape (missing generatedAt) → null", async () => {
    const meta = await loadMeta(
      fetchReturning(true, async () => ({ staleness: {}, baseline: null })),
    );
    expect(meta).toBeNull();
  });

  it("wrong shape (staleness has a non-string, non-null value) → null", async () => {
    const bad = { generatedAt: "x", staleness: { a: 42 }, baseline: null };
    const meta = await loadMeta(fetchReturning(true, async () => bad));
    expect(meta).toBeNull();
  });

  it("wrong shape (baseline missing its files map) → null", async () => {
    const bad = {
      generatedAt: "x",
      staleness: {},
      baseline: { tag: "baseline/x", taggedAt: "y" },
    };
    const meta = await loadMeta(fetchReturning(true, async () => bad));
    expect(meta).toBeNull();
  });

  it("a bare array (not an object) → null", async () => {
    const meta = await loadMeta(fetchReturning(true, async () => []));
    expect(meta).toBeNull();
  });
});
