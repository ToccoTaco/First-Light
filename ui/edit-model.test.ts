import { describe, it, expect, vi } from "vitest";
import type { Task } from "../engine/types";
import type { GitHubTarget, LoadResult, SaveResult } from "../storage/github";
import {
  PROJECT_FILE,
  accumulate,
  addTaskToState,
  applyEditsToTasks,
  applyPatchToTask,
  applyPatchesToTasks,
  blockingDependents,
  clearChart,
  commitMessage,
  commitMessageFor,
  depId,
  dependsOnIds,
  descendantIds,
  dirtyCount,
  dirtyFiles,
  editDirtyCount,
  editDirtyFiles,
  effectiveStatus,
  eligibleDependencyTargets,
  fileForTaskId,
  isEditable,
  kebab,
  makeSpineId,
  makeTaskId,
  milestonePatch,
  movePatch,
  newSpineItem,
  newSquadTask,
  nextStatus,
  releasePatch,
  removalClosure,
  removalPreview,
  removeTaskFromState,
  removeWithCleanup,
  resizePatch,
  saveAll,
  squadFile,
  type EditState,
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

  it("allows spine reviews/gates (now first-class editable)", () => {
    expect(isEditable({ kind: "gate-review", squadId: null })).toBe(true);
    expect(isEditable({ kind: "gate-test", squadId: null })).toBe(true);
  });

  it("refuses summaries, groups, and squadless leaf tasks", () => {
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

  it("add + remove + edit land in ONE text pass with a three-verb message", async () => {
    const TEXT = `tasks:
  - id: engines.a
    name: "Task A"
    schedule: { mode: auto, duration: 5 }
    status: not-started
  - id: engines.b
    name: "Task B"
    schedule: { mode: auto, duration: 3 }
    status: not-started
`;
    const { client, calls } = fakeClient({
      load: { [EPATH]: loadOk(EPATH, TEXT, "sha-1") },
      save: { [EPATH]: saveOk("sha-2") },
    });

    const out = await saveAll(
      {
        patches: {
          "engines.b": { status: "in-progress" }, // edit
          "engines.new-part": { name: "New part (refined)" }, // refines the add
        },
        added: [newSquadTask("engines.new-part", "New part")],
        removed: ["engines.a"],
        originalTexts: { [EPATH]: TEXT },
        squadIds: SQUADS,
        target: TARGET,
        token: TOKEN,
      },
      client,
    );

    const r = out.results[0];
    expect(r.ok).toBe(true);
    // Covers every touched id so the app clears all three kinds on success.
    expect(new Set(r.taskIds)).toEqual(
      new Set(["engines.b", "engines.new-part", "engines.a"]),
    );

    const save = calls.find((c) => c.op === "save")!;
    const text = save.newText!;
    expect(text).not.toContain("engines.a"); // removed
    expect(text).toContain("id: engines.new-part"); // added
    expect(text).toContain("New part (refined)"); // add carried its refine patch
    expect(text).toMatch(/id: engines\.b[\s\S]*status: in-progress/); // edited
    // Three-verb commit subject (order: add; update; remove).
    expect(save.message).toBe(
      "engines: add new-part; update b; remove a (First Light)",
    );
  });
});

// ── full-panel patch builders ────────────────────────────────────────────────────

describe("releasePatch", () => {
  it("releases a pinned task to auto, DROPPING the stale start", () => {
    const t = pinned("engines.x", "2026-08-14", 12);
    const after = applyPatchToTask(t, releasePatch(12));
    expect(after.schedule).toEqual({ mode: "auto", duration: 12 });
    expect("start" in after.schedule).toBe(false);
  });

  it("carries start:undefined so the serializer's undefined-deletes path fires", () => {
    // The explicit undefined is what makes applyTaskEdit delete the YAML key.
    expect(releasePatch(7).schedule).toEqual({
      mode: "auto",
      start: undefined,
      duration: 7,
    });
  });
});

describe("milestonePatch", () => {
  it("turning ON forces duration 0", () => {
    expect(milestonePatch(true)).toEqual({
      milestone: true,
      schedule: { duration: 0 },
    });
  });
  it("turning OFF just drops the flag", () => {
    expect(milestonePatch(false)).toEqual({ milestone: false });
  });
});

// ── applyPatchToTask — the new full-panel fields ──────────────────────────────────

describe("applyPatchToTask (full-panel fields)", () => {
  it("sets name and confidence", () => {
    const t = auto("engines.x", 5);
    const after = applyPatchToTask(t, { name: "Renamed", confidence: "firm" });
    expect(after.name).toBe("Renamed");
    expect(after.confidence).toBe("firm");
  });

  it("percent: a number sets it, null clears it", () => {
    const t = auto("engines.x", 10, { percent: 40 });
    expect(applyPatchToTask(t, { percent: 80 }).percent).toBe(80);
    expect("percent" in applyPatchToTask(t, { percent: null })).toBe(false);
  });

  it("milestone true sets it, false removes it", () => {
    const t = auto("engines.x", 0, { milestone: true });
    expect("milestone" in applyPatchToTask(t, { milestone: false })).toBe(false);
    expect(applyPatchToTask(auto("engines.y", 0), { milestone: true }).milestone).toBe(
      true,
    );
  });

  it("deadline: object sets it, null clears it", () => {
    const t = auto("engines.x", 5, { deadline: { date: "2026-09-01", hard: true } });
    expect(applyPatchToTask(t, { deadline: null }).deadline).toBeUndefined();
    const set = applyPatchToTask(auto("engines.y", 5), {
      deadline: { date: "2026-10-10", hard: false },
    });
    expect(set.deadline).toEqual({ date: "2026-10-10", hard: false });
  });

  it("dependsOn: a list replaces, an empty list clears", () => {
    const t = auto("engines.x", 5, { dependsOn: ["engines.a"] });
    expect(applyPatchToTask(t, { dependsOn: ["engines.b", "engines.c"] }).dependsOn).toEqual(
      ["engines.b", "engines.c"],
    );
    expect("dependsOn" in applyPatchToTask(t, { dependsOn: [] })).toBe(false);
  });
});

// ── EditState: adds + removes + patches together ──────────────────────────────────

describe("EditState derivations", () => {
  const base = () => [auto("engines.a", 5), auto("engines.b", 3)];

  it("applyEditsToTasks drops removed, appends added, applies patches", () => {
    const state: EditState = {
      patches: { "engines.b": { status: "done" } },
      added: [newSquadTask("engines.c", "C")],
      removed: ["engines.a"],
    };
    const out = applyEditsToTasks(base(), state);
    expect(out.map((t) => t.id)).toEqual(["engines.b", "engines.c"]);
    expect(out[0].status).toBe("done");
  });

  it("removeTaskFromState un-adds an unsaved add (clean no-op)", () => {
    let state: EditState = { patches: {}, added: [], removed: [] };
    state = addTaskToState(state, newSquadTask("engines.c", "C"));
    state = removeTaskFromState(state, "engines.c");
    expect(state.added).toEqual([]);
    expect(state.removed).toEqual([]);
  });

  it("removeTaskFromState marks an existing task removed and drops its patch", () => {
    const state: EditState = {
      patches: { "engines.a": { status: "done" } },
      added: [],
      removed: [],
    };
    const next = removeTaskFromState(state, "engines.a");
    expect(next.removed).toEqual(["engines.a"]);
    expect(next.patches).toEqual({});
  });

  it("editDirtyCount: one per add/remove; a patch on an added task isn't double-counted", () => {
    expect(
      editDirtyCount({
        patches: { "engines.b": {} },
        added: [newSquadTask("engines.c", "C")],
        removed: ["engines.a"],
      }),
    ).toBe(3);
    expect(
      editDirtyCount({
        patches: { "engines.c": { name: "x" } }, // refines the add
        added: [newSquadTask("engines.c", "C")],
        removed: [],
      }),
    ).toBe(1);
  });

  it("editDirtyFiles unions edits+adds+removes in squad order, project last", () => {
    expect(
      editDirtyFiles(
        {
          patches: { "engines.b": {}, "review.pdr": {} },
          added: [newSquadTask("fluids.new", "N")],
          removed: ["avionics.old"],
        },
        SQUADS,
      ),
    ).toEqual([
      squadFile("engines"),
      squadFile("fluids"),
      squadFile("avionics"),
      PROJECT_FILE,
    ]);
  });
});

// ── dependency helpers + eligibility (the §8 picker rule) ─────────────────────────

describe("depId / dependsOnIds", () => {
  it("reads ids from both the string and object dependency forms", () => {
    expect(depId("engines.a")).toBe("engines.a");
    expect(depId({ task: "engines.b", type: "SS", lag: 2 })).toBe("engines.b");
    expect(dependsOnIds(["engines.a", { task: "engines.b" }])).toEqual([
      "engines.a",
      "engines.b",
    ]);
    expect(dependsOnIds(undefined)).toEqual([]);
  });
});

describe("eligibleDependencyTargets", () => {
  const squads = [
    { id: "engines", name: "Engines" },
    { id: "fluids", name: "Fluids" },
  ];
  const graph: Task[] = [
    auto("engines.a", 5),
    auto("engines.b", 5),
    auto("engines.m", 0, { milestone: true }),
    auto("fluids.internal", 5), // other squad, NOT a milestone
    auto("fluids.pub", 0, { milestone: true }), // other squad, published
    { id: "review.pdr", name: "PDR", milestone: true, gate: "review", schedule: { mode: "auto", duration: 0 } },
    { id: "gate.hot", name: "Hotfire", milestone: true, gate: "test", schedule: { mode: "auto", duration: 0 } },
  ];

  it("for a squad task: own squad + all spine + OTHER squads' milestones only", () => {
    const ids = eligibleDependencyTargets(
      graph[0], // engines.a
      graph,
      squads,
      SQUADS,
    ).map((t) => t.id);
    expect(new Set(ids)).toEqual(
      new Set(["engines.b", "engines.m", "fluids.pub", "review.pdr", "gate.hot"]),
    );
    // The §8 rule made visible: a different squad's internal task is NOT offered.
    expect(ids).not.toContain("fluids.internal");
    expect(ids).not.toContain("engines.a"); // never itself
  });

  it("excludes ids already depended on", () => {
    const withDep = auto("engines.a", 5, { dependsOn: ["engines.b"] });
    const ids = eligibleDependencyTargets(withDep, graph, squads, SQUADS).map(
      (t) => t.id,
    );
    expect(ids).not.toContain("engines.b");
  });

  it("for a spine task: all squads' milestones + other spine items, no squad internals", () => {
    const ids = eligibleDependencyTargets(
      graph[5], // review.pdr
      graph,
      squads,
      SQUADS,
    ).map((t) => t.id);
    expect(new Set(ids)).toEqual(new Set(["engines.m", "fluids.pub", "gate.hot"]));
    expect(ids).not.toContain("engines.a");
    expect(ids).not.toContain("fluids.internal");
    expect(ids).not.toContain("review.pdr"); // never itself
  });

  it("tags each target with a display group (Spine or squad name)", () => {
    const targets = eligibleDependencyTargets(graph[0], graph, squads, SQUADS);
    expect(targets.find((t) => t.id === "review.pdr")?.group).toBe("Spine");
    expect(targets.find((t) => t.id === "fluids.pub")?.group).toBe("Fluids");
  });
});

describe("blockingDependents", () => {
  it("lists every task that depends on the given id", () => {
    const tasks = [
      auto("engines.a", 5),
      auto("engines.b", 5, { dependsOn: ["engines.a"] }),
      auto("engines.c", 5, { dependsOn: [{ task: "engines.a", type: "SS" }] }),
      auto("engines.d", 5),
    ];
    expect(blockingDependents("engines.a", tasks).map((t) => t.id)).toEqual([
      "engines.b",
      "engines.c",
    ]);
    expect(blockingDependents("engines.d", tasks)).toEqual([]);
  });
});

// ── deletion cascade + dependency cleanup (full modularity) ───────────────────────

describe("descendantIds / removalClosure", () => {
  // P ⊃ { X, Y ⊃ { Z } } — a two-level subtree under a summary P.
  const tree: Task[] = [
    auto("engines.p", 0),
    auto("engines.x", 3, { parent: "engines.p" }),
    auto("engines.y", 3, { parent: "engines.p" }),
    auto("engines.z", 3, { parent: "engines.y" }),
    auto("engines.loose", 3),
  ];

  it("descendantIds returns the whole subtree, excluding the root", () => {
    expect(new Set(descendantIds("engines.p", tree))).toEqual(
      new Set(["engines.x", "engines.y", "engines.z"]),
    );
    expect(descendantIds("engines.y", tree)).toEqual(["engines.z"]);
    expect(descendantIds("engines.loose", tree)).toEqual([]);
  });

  it("removalClosure includes the root itself first", () => {
    expect(removalClosure("engines.y", tree)).toEqual([
      "engines.y",
      "engines.z",
    ]);
  });
});

describe("removalPreview", () => {
  const graph: Task[] = [
    auto("engines.p", 0),
    auto("engines.child", 3, { parent: "engines.p" }),
    auto("fluids.after", 3, { dependsOn: ["engines.child"] }), // depends INTO the subtree
    auto("structures.clear", 3),
  ];

  it("previews the subtree and the outside dependents that would be cleaned up", () => {
    const preview = removalPreview("engines.p", graph);
    expect(preview.descendants).toEqual(["engines.child"]);
    expect(preview.dependents).toEqual(["fluids.after"]); // its dep is inside the subtree
  });

  it("a clean leaf with no dependents previews empty", () => {
    expect(removalPreview("structures.clear", graph)).toEqual({
      descendants: [],
      dependents: [],
    });
  });
});

describe("removeWithCleanup", () => {
  const graph: Task[] = [
    auto("engines.a", 5),
    auto("engines.b", 3, { dependsOn: ["engines.a", "engines.other"] }),
    auto("fluids.c", 3, { dependsOn: [{ task: "engines.a", type: "SS" }] }),
    auto("engines.other", 2),
  ];

  it("stages the delete AND strips every dangling dependency edge", () => {
    const { state, removed, dependents } = removeWithCleanup(
      { patches: {}, added: [], removed: [] },
      "engines.a",
      graph,
    );
    expect(removed).toEqual(["engines.a"]);
    expect(state.removed).toEqual(["engines.a"]);
    // engines.b keeps its OTHER dep; fluids.c loses its only dep (→ []).
    expect(new Set(dependents)).toEqual(new Set(["engines.b", "fluids.c"]));
    expect(state.patches["engines.b"].dependsOn).toEqual(["engines.other"]);
    expect(state.patches["fluids.c"].dependsOn).toEqual([]);
  });

  it("cascades a summary delete to its subtree and cleans deps into it", () => {
    const tree: Task[] = [
      auto("engines.p", 0),
      auto("engines.x", 3, { parent: "engines.p" }),
      auto("engines.y", 3, { parent: "engines.p" }),
      auto("fluids.after", 3, { dependsOn: ["engines.y"] }),
    ];
    const { state, removed, dependents } = removeWithCleanup(
      { patches: {}, added: [], removed: [] },
      "engines.p",
      tree,
    );
    expect(new Set(removed)).toEqual(
      new Set(["engines.p", "engines.x", "engines.y"]),
    );
    expect(new Set(state.removed)).toEqual(
      new Set(["engines.p", "engines.x", "engines.y"]),
    );
    expect(dependents).toEqual(["fluids.after"]);
    expect(state.patches["fluids.after"].dependsOn).toEqual([]);
  });

  it("deleting an unsaved add just un-adds it (never reaches a file)", () => {
    let state: EditState = { patches: {}, added: [], removed: [] };
    state = { ...state, added: [newSquadTask("engines.new", "New")] };
    const { state: after } = removeWithCleanup(state, "engines.new", [
      newSquadTask("engines.new", "New"),
    ]);
    expect(after.added).toEqual([]);
    expect(after.removed).toEqual([]);
  });
});

describe("clearChart", () => {
  it("stages every existing item removed and un-adds unsaved adds", () => {
    const working: Task[] = [
      auto("engines.a", 5),
      { id: "review.pdr", name: "PDR", milestone: true, gate: "review", schedule: { mode: "auto", duration: 0 } },
      newSquadTask("fluids.fresh", "Fresh"), // an unsaved add present in the working graph
    ];
    const state: EditState = {
      patches: { "engines.a": { status: "done" } },
      added: [newSquadTask("fluids.fresh", "Fresh")],
      removed: [],
    };
    const next = clearChart(state, working);
    // The two existing items are staged removed; the add is dropped, not removed.
    expect(new Set(next.removed)).toEqual(new Set(["engines.a", "review.pdr"]));
    expect(next.added).toEqual([]);
    expect(next.patches).toEqual({}); // the removed task's patch is dropped
  });
});

// ── spine id + item creation ──────────────────────────────────────────────────────

describe("makeSpineId / newSpineItem", () => {
  it("mints review.* and gate.* ids, bumping suffixes on collision", () => {
    expect(makeSpineId("review", "Preliminary Design Review", [])).toBe(
      "review.preliminary-design-review",
    );
    expect(makeSpineId("test", "First engine hotfire", [])).toBe(
      "gate.first-engine-hotfire",
    );
    expect(makeSpineId("test", "Hotfire", ["gate.hotfire"])).toBe(
      "gate.hotfire-2",
    );
  });

  it("newSpineItem is a zero-duration auto milestone carrying its gate kind", () => {
    expect(newSpineItem("review.new", "New review", "review")).toEqual({
      id: "review.new",
      name: "New review",
      milestone: true,
      gate: "review",
      schedule: { mode: "auto", duration: 0 },
      status: "not-started",
    });
    expect(newSpineItem("gate.new", "New test", "test").gate).toBe("test");
  });
});

// ── new-task id generation ────────────────────────────────────────────────────────

describe("kebab / makeTaskId / newSquadTask", () => {
  it("kebab slugs a display name, empty → 'task'", () => {
    expect(kebab("  Flow Bench Test!  ")).toBe("flow-bench-test");
    expect(kebab("Injector — v2")).toBe("injector-v2");
    expect(kebab("")).toBe("task");
    expect(kebab("!!!")).toBe("task");
  });

  it("makeTaskId namespaces + bumps a numeric suffix on collision", () => {
    expect(makeTaskId("engines", "Flow bench", [])).toBe("engines.flow-bench");
    expect(makeTaskId("engines", "Flow bench", ["engines.flow-bench"])).toBe(
      "engines.flow-bench-2",
    );
    expect(
      makeTaskId("engines", "Flow bench", [
        "engines.flow-bench",
        "engines.flow-bench-2",
      ]),
    ).toBe("engines.flow-bench-3");
  });

  it("newSquadTask is auto/7d/not-started/guess with no deps (§10 defaults)", () => {
    expect(newSquadTask("engines.x", "X")).toEqual({
      id: "engines.x",
      name: "X",
      schedule: { mode: "auto", duration: 7 },
      status: "not-started",
      confidence: "guess",
    });
  });
});

// ── commit message (add/remove aware) ─────────────────────────────────────────────

describe("commitMessageFor", () => {
  it("composes add; update; remove in a stable order", () => {
    expect(
      commitMessageFor("engines", {
        added: ["engines.foo"],
        edited: ["engines.bar"],
        removed: ["engines.baz"],
      }),
    ).toBe("engines: add foo; update bar; remove baz (First Light)");
  });
  it("omits empty verbs", () => {
    expect(
      commitMessageFor("fluids", { added: ["fluids.n"], edited: [], removed: [] }),
    ).toBe("fluids: add n (First Light)");
  });
});
