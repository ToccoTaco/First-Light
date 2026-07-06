import { describe, it, expect, vi } from "vitest";
import type { Task } from "../engine/types";
import type { GitHubTarget, LoadResult, SaveResult } from "../storage/github";
import {
  PROJECT_FILE,
  accumulate,
  applyPatchToTask,
  applyPatchesToTasks,
  commitMessage,
  dirtyCount,
  dirtyFiles,
  effectiveStatus,
  fileForTaskId,
  isEditable,
  movePatch,
  nextStatus,
  resizePatch,
  saveAll,
  squadFile,
  type GitHubClient,
  type PatchMap,
} from "./edit-model";

// edit-model is the pure editing brain of Phase 3.2: everything here runs with
// no DOM, no DHTMLX, no network. The save-orchestration block drives `saveAll`
// against a FAKE GitHubClient that records calls — no real GitHub is ever hit.

const SQUADS = ["engines", "fluids", "structures", "avionics"] as const;

const auto = (id: string, duration: number, extra: Partial<Task> = {}): Task => ({
  id,
  name: id,
  schedule: { mode: "auto", duration },
  ...extra,
});
const pinned = (
  id: string,
  start: string,
  duration: number,
  extra: Partial<Task> = {},
): Task => ({
  id,
  name: id,
  schedule: { mode: "pinned", start, duration },
  ...extra,
});

// ── id → owning file ────────────────────────────────────────────────────────────

describe("fileForTaskId", () => {
  it("maps a squad-prefixed id to its squad file", () => {
    expect(fileForTaskId("engines.injector-fab", SQUADS)).toBe(
      "data/subgroups/engines.yaml",
    );
    expect(fileForTaskId("avionics.fc-bringup", SQUADS)).toBe(
      "data/subgroups/avionics.yaml",
    );
  });

  it("maps spine ids (review.*, gate.*) to project.yaml", () => {
    expect(fileForTaskId("review.pdr", SQUADS)).toBe(PROJECT_FILE);
    expect(fileForTaskId("gate.engine-hotfire", SQUADS)).toBe(PROJECT_FILE);
  });

  it("maps an unknown prefix and an un-namespaced id to project.yaml", () => {
    expect(fileForTaskId("payload.fairing", SQUADS)).toBe(PROJECT_FILE);
    expect(fileForTaskId("loose-task", SQUADS)).toBe(PROJECT_FILE);
  });
});

// ── editability (quick tier: leaf squad tasks only) ────────────────────────────

describe("isEditable", () => {
  it("allows leaf tasks and milestones that belong to a squad", () => {
    expect(isEditable({ kind: "task", squadId: "engines" })).toBe(true);
    expect(isEditable({ kind: "milestone", squadId: "fluids" })).toBe(true);
  });

  it("refuses spine gates, summaries, groups, and squadless rows", () => {
    expect(isEditable({ kind: "gate-review", squadId: null })).toBe(false);
    expect(isEditable({ kind: "gate-test", squadId: null })).toBe(false);
    expect(isEditable({ kind: "summary", squadId: "engines" })).toBe(false);
    expect(isEditable({ kind: "group", squadId: "engines" })).toBe(false);
    expect(isEditable({ kind: "task", squadId: null })).toBe(false);
  });
});

// ── status cycle ────────────────────────────────────────────────────────────────

describe("nextStatus", () => {
  it("cycles not-started → in-progress → done → blocked → not-started", () => {
    expect(nextStatus("not-started")).toBe("in-progress");
    expect(nextStatus("in-progress")).toBe("done");
    expect(nextStatus("done")).toBe("blocked");
    expect(nextStatus("blocked")).toBe("not-started"); // wraps
  });
});

// ── drag → patch mappings ──────────────────────────────────────────────────────

describe("drag → patch", () => {
  it("move pins the task to the dropped start and PRESERVES duration", () => {
    const t = auto("engines.injector-fab", 18);
    const after = applyPatchToTask(t, movePatch("2026-08-14"));
    expect(after.schedule).toEqual({
      mode: "pinned",
      start: "2026-08-14",
      duration: 18, // untouched — the patch carries no duration
    });
  });

  it("moving an already-pinned task re-pins it, keeping its duration", () => {
    const t = pinned("fluids.tank-proof", "2026-06-01", 9);
    const after = applyPatchToTask(t, movePatch("2026-06-20"));
    expect(after.schedule).toEqual({
      mode: "pinned",
      start: "2026-06-20",
      duration: 9,
    });
  });

  it("resize changes only duration; an auto task stays auto", () => {
    const t = auto("engines.injector-fab", 18);
    const after = applyPatchToTask(t, resizePatch(25));
    expect(after.schedule).toEqual({ mode: "auto", duration: 25 });
  });

  it("resize on a pinned task keeps mode AND start", () => {
    const t = pinned("fluids.tank-proof", "2026-06-01", 9);
    const after = applyPatchToTask(t, resizePatch(12));
    expect(after.schedule).toEqual({
      mode: "pinned",
      start: "2026-06-01",
      duration: 12,
    });
  });

  it("milestone move → pinned start (duration stays absent)", () => {
    const t: Task = {
      id: "engines.first-part",
      name: "m",
      milestone: true,
      schedule: { mode: "auto", duration: 0 },
    };
    const after = applyPatchToTask(t, movePatch("2026-09-01"));
    // duration 0 (from the auto schedule) survives the merge — harmless for a
    // zero-width milestone and keeps the merge rule uniform.
    expect(after.schedule.mode).toBe("pinned");
    expect((after.schedule as { start: string }).start).toBe("2026-09-01");
  });
});

// ── patch accumulation ─────────────────────────────────────────────────────────

describe("accumulate", () => {
  it("merges a later patch over an earlier one, schedule key-by-key", () => {
    let p: PatchMap = {};
    p = accumulate(p, "engines.x", movePatch("2026-08-14")); // pin
    p = accumulate(p, "engines.x", resizePatch(20)); // then resize
    expect(p["engines.x"]).toEqual({
      schedule: { mode: "pinned", start: "2026-08-14", duration: 20 },
    });
  });

  it("status and schedule edits coexist on one task", () => {
    let p: PatchMap = {};
    p = accumulate(p, "engines.x", { status: "in-progress" });
    p = accumulate(p, "engines.x", resizePatch(7));
    expect(p["engines.x"]).toEqual({
      status: "in-progress",
      schedule: { duration: 7 },
    });
  });

  it("a later status overwrites an earlier one (last click wins)", () => {
    let p: PatchMap = {};
    p = accumulate(p, "engines.x", { status: "in-progress" });
    p = accumulate(p, "engines.x", { status: "done" });
    expect(p["engines.x"]).toEqual({ status: "done" });
  });

  it("does not mutate the input map", () => {
    const before: PatchMap = { "engines.a": { status: "done" } };
    const after = accumulate(before, "engines.b", resizePatch(3));
    expect(before).toEqual({ "engines.a": { status: "done" } });
    expect(Object.keys(after)).toHaveLength(2);
  });
});

describe("applyPatchesToTasks / effectiveStatus", () => {
  it("applies each task's patch and leaves the rest identical", () => {
    const tasks = [auto("engines.a", 5), auto("engines.b", 3)];
    const patches: PatchMap = { "engines.a": { status: "blocked" } };
    const out = applyPatchesToTasks(tasks, patches);
    expect(out[0].status).toBe("blocked");
    expect(out[1]).toBe(tasks[1]); // untouched tasks are the same object
  });

  it("effectiveStatus prefers the patch, then the task, then not-started", () => {
    const t = auto("engines.a", 5, { status: "in-progress" });
    expect(effectiveStatus(t, { status: "done" })).toBe("done");
    expect(effectiveStatus(t, undefined)).toBe("in-progress");
    expect(effectiveStatus(auto("engines.b", 1), undefined)).toBe("not-started");
  });
});

// ── dirty-file derivation ──────────────────────────────────────────────────────

describe("dirtyFiles / dirtyCount", () => {
  it("derives the owning files in stable squad order, project last", () => {
    const patches: PatchMap = {
      "avionics.fc": { status: "done" },
      "engines.x": { status: "done" },
      "review.pdr": { status: "done" }, // spine → project.yaml
    };
    expect(dirtyFiles(patches, SQUADS)).toEqual([
      "data/subgroups/engines.yaml",
      "data/subgroups/avionics.yaml",
      PROJECT_FILE,
    ]);
    expect(dirtyCount(patches)).toBe(3);
  });

  it("two tasks in one file → one dirty file", () => {
    const patches: PatchMap = {
      "engines.a": { status: "done" },
      "engines.b": { status: "done" },
    };
    expect(dirtyFiles(patches, SQUADS)).toEqual([squadFile("engines")]);
    expect(dirtyCount(patches)).toBe(2);
  });

  it("no patches → no dirty files", () => {
    expect(dirtyFiles({}, SQUADS)).toEqual([]);
    expect(dirtyCount({})).toBe(0);
  });
});

// ── commit message ─────────────────────────────────────────────────────────────

describe("commitMessage", () => {
  it("reads `<label>: update <local-ids> (First Light)`", () => {
    expect(
      commitMessage("engines", [
        "engines.injector-fabrication",
        "engines.igniter-test-campaign",
      ]),
    ).toBe(
      "engines: update injector-fabrication, igniter-test-campaign (First Light)",
    );
  });
});

// ── save orchestration against a MOCKED client ─────────────────────────────────

const TARGET: GitHubTarget = { owner: "nd-prop", repo: "first-light", branch: "main" };
const TOKEN = "github_pat_TEST";

const ENGINES_TEXT = `tasks:
  - id: engines.injector-fab
    name: "Injector fabrication"
    schedule: { mode: auto, duration: 18 }
    status: not-started
`;
const FLUIDS_TEXT = `tasks:
  - id: fluids.tank-proof
    name: "Tank proof test"
    schedule: { mode: auto, duration: 9 }
    status: not-started
`;

interface ClientCall {
  op: "load" | "save";
  path: string;
  message?: string;
  newText?: string;
  baseSha?: string;
}

/** A fake GitHubClient: scripted per-path responses, records every call in order. */
function fakeClient(script: {
  load?: Record<string, LoadResult>;
  save?: Record<string, SaveResult>;
}): { client: GitHubClient; calls: ClientCall[] } {
  const calls: ClientCall[] = [];
  const client: GitHubClient = {
    loadFile: vi.fn(async (_t, path) => {
      calls.push({ op: "load", path });
      const r = script.load?.[path];
      if (!r) throw new Error(`fake client: no load scripted for ${path}`);
      return r;
    }),
    saveFile: vi.fn(async (_t, path, newText, message, base) => {
      calls.push({ op: "save", path, message, newText, baseSha: base.sha });
      const r = script.save?.[path];
      if (!r) throw new Error(`fake client: no save scripted for ${path}`);
      return r;
    }),
  };
  return { client, calls };
}

const loadOk = (path: string, text: string, sha: string): LoadResult => ({
  ok: true,
  file: { path, text, sha },
});
const saveOk = (sha: string): SaveResult => ({
  ok: true,
  newSha: sha,
  commitSha: `commit-${sha}`,
});

describe("saveAll (mocked GitHub client)", () => {
  const EPATH = squadFile("engines");
  const FPATH = squadFile("fluids");

  it("happy path: saves two dirty files SEQUENTIALLY with per-file commit messages", async () => {
    const { client, calls } = fakeClient({
      load: {
        [EPATH]: loadOk(EPATH, ENGINES_TEXT, "sha-e1"),
        [FPATH]: loadOk(FPATH, FLUIDS_TEXT, "sha-f1"),
      },
      save: { [EPATH]: saveOk("sha-e2"), [FPATH]: saveOk("sha-f2") },
    });

    const out = await saveAll(
      {
        patches: {
          "engines.injector-fab": { status: "in-progress" },
          "fluids.tank-proof": { schedule: { duration: 12 } },
        },
        originalTexts: { [EPATH]: ENGINES_TEXT, [FPATH]: FLUIDS_TEXT },
        squadIds: SQUADS,
        target: TARGET,
        token: TOKEN,
      },
      client,
    );

    expect(out.noToken).toBe(false);
    expect(out.results.map((r) => [r.path, r.ok])).toEqual([
      [EPATH, true],
      [FPATH, true],
    ]);

    // Strictly sequential per-file: load-e, save-e, load-f, save-f.
    expect(calls.map((c) => `${c.op}:${c.path}`)).toEqual([
      `load:${EPATH}`,
      `save:${EPATH}`,
      `load:${FPATH}`,
      `save:${FPATH}`,
    ]);

    // Commit messages name the squad and the edited tasks.
    expect(calls[1].message).toBe(
      "engines: update injector-fab (First Light)",
    );
    expect(calls[3].message).toBe("fluids: update tank-proof (First Light)");

    // Commits go against the JIT-fetched shas.
    expect(calls[1].baseSha).toBe("sha-e1");
    expect(calls[3].baseSha).toBe("sha-f1");

    // The committed text is the original with ONLY the edit applied (comment-
    // preserving minimal diff — here: the status line changed, duration line changed).
    expect(calls[1].newText).toContain("status: in-progress");
    expect(calls[1].newText).toContain("duration: 18"); // untouched
    expect(calls[3].newText).toContain("duration: 12");
    expect(calls[3].newText).toContain("status: not-started"); // untouched

    // Success results carry the new base (text + sha) for the app to adopt.
    expect(out.results[0].newSha).toBe("sha-e2");
    expect(out.results[0].newText).toBe(calls[1].newText);
  });

  it("partial failure: the failed file stays dirty, the saved one is clean", async () => {
    const { client } = fakeClient({
      load: {
        [EPATH]: loadOk(EPATH, ENGINES_TEXT, "sha-e1"),
        [FPATH]: loadOk(FPATH, FLUIDS_TEXT, "sha-f1"),
      },
      save: {
        [EPATH]: saveOk("sha-e2"),
        [FPATH]: {
          ok: false,
          error: { kind: "forbidden", message: "no push access" },
          unsavedText: "x",
        },
      },
    });

    const out = await saveAll(
      {
        patches: {
          "engines.injector-fab": { status: "done" },
          "fluids.tank-proof": { status: "done" },
        },
        originalTexts: { [EPATH]: ENGINES_TEXT, [FPATH]: FLUIDS_TEXT },
        squadIds: SQUADS,
        target: TARGET,
        token: TOKEN,
      },
      client,
    );

    const byPath = new Map(out.results.map((r) => [r.path, r]));
    expect(byPath.get(EPATH)?.ok).toBe(true);
    expect(byPath.get(EPATH)?.taskIds).toEqual(["engines.injector-fab"]);
    const failed = byPath.get(FPATH);
    expect(failed?.ok).toBe(false);
    expect(failed?.error?.kind).toBe("forbidden");
    // The failed file's tasks are named so the app clears ONLY the saved ones.
    expect(failed?.taskIds).toEqual(["fluids.tank-proof"]);
  });

  it("conflict: remote text ≠ originally loaded text → conflict BEFORE any write", async () => {
    const remoteText = ENGINES_TEXT.replace("duration: 18", "duration: 30");
    const { client, calls } = fakeClient({
      load: { [EPATH]: loadOk(EPATH, remoteText, "sha-e9") },
    });

    const out = await saveAll(
      {
        patches: { "engines.injector-fab": { status: "done" } },
        originalTexts: { [EPATH]: ENGINES_TEXT },
        squadIds: SQUADS,
        target: TARGET,
        token: TOKEN,
      },
      client,
    );

    const r = out.results[0];
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("conflict");
    // The remote copy is surfaced for reload-and-reapply.
    if (r.error?.kind === "conflict") {
      expect(r.error.remote.text).toBe(remoteText);
      expect(r.error.remote.sha).toBe("sha-e9");
    }
    // No PUT was ever attempted — the conflict is caught before applying patches.
    expect(calls.map((c) => c.op)).toEqual(["load"]);
  });

  it("load failure on one file surfaces its error and moves on", async () => {
    const { client } = fakeClient({
      load: {
        [EPATH]: { ok: false, error: { kind: "auth", message: "bad token" } },
        [FPATH]: loadOk(FPATH, FLUIDS_TEXT, "sha-f1"),
      },
      save: { [FPATH]: saveOk("sha-f2") },
    });

    const out = await saveAll(
      {
        patches: {
          "engines.injector-fab": { status: "done" },
          "fluids.tank-proof": { status: "done" },
        },
        originalTexts: { [EPATH]: ENGINES_TEXT, [FPATH]: FLUIDS_TEXT },
        squadIds: SQUADS,
        target: TARGET,
        token: TOKEN,
      },
      client,
    );

    const byPath = new Map(out.results.map((r) => [r.path, r]));
    expect(byPath.get(EPATH)?.ok).toBe(false);
    expect(byPath.get(EPATH)?.error?.kind).toBe("auth");
    expect(byPath.get(FPATH)?.ok).toBe(true);
  });

  it("no token: short-circuits with zero network calls", async () => {
    const { client, calls } = fakeClient({});
    const out = await saveAll(
      {
        patches: { "engines.injector-fab": { status: "done" } },
        originalTexts: { [EPATH]: ENGINES_TEXT },
        squadIds: SQUADS,
        target: TARGET,
        token: "",
      },
      client,
    );
    expect(out.noToken).toBe(true);
    expect(out.results).toEqual([]);
    expect(calls).toEqual([]);
  });
});
