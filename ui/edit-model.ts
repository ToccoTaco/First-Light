// ui/edit-model.ts — the PURE editing brain of Phase 3.2 (quick edits + save).
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │  Like chart-model.ts, this file knows NOTHING about DHTMLX, the DOM, git,   │
// │  or React. Every editing DECISION lives here as a pure function so it can   │
// │  be unit-tested: which file owns a task, how drags/clicks become task       │
// │  patches, how patches accumulate, which files are dirty, and how a save is  │
// │  orchestrated over an injected GitHub client. App.tsx and gantt-adapter.ts  │
// │  are the thin wiring that calls into this.                                  │
// └───────────────────────────────────────────────────────────────────────────┘
//
// A PATCH is a `Partial<Task>` capturing only the fields an edit changed. Its
// `schedule` is itself partial (a fragment merged over the task's existing
// schedule map) — that merge-not-replace is what makes "resize" preserve the
// pinned start and "move" preserve the duration, exactly as storage's
// `applyTaskEdit` merges the same fragment into the file text on save.

import type { ISODate, Status, Task } from "../engine/types";
import type {
  GitHubError,
  GitHubTarget,
  LoadResult,
  SaveResult,
} from "../storage/github";
import { applyTaskEdit, addTask, removeTask } from "../storage/serialize";

// A patch's schedule is a free-form fragment merged over the task's own schedule,
// so it need not be a complete `auto | pinned` union on its own. A `start` of
// `undefined` is meaningful: it's the RELEASE signal (pinned → auto) that must
// reach the serializer's undefined-deletes path to drop the stale `start` key.
export type SchedulePatch = Partial<{
  mode: "auto" | "pinned";
  start: ISODate | undefined;
  duration: number;
}>;

/** A dependency edge, either the compact string form or the advanced object form. */
export type Dependency = NonNullable<Task["dependsOn"]>[number];

// The full editing panel (Phase 3.3) can touch every field. Absent key = "leave
// alone"; `null` on a clearable field = "remove it". The full-restructuring
// fields (name, confidence, milestone, deadline, dependsOn) join the 3.2 quick
// fields (schedule, status) here so the whole editor speaks one patch language.
export interface TaskPatch {
  schedule?: SchedulePatch;
  status?: Status;
  name?: string;
  percent?: number | null; // null clears the field
  confidence?: "firm" | "estimate" | "guess";
  milestone?: boolean;
  deadline?: { date: ISODate; hard: boolean } | null; // null clears
  dependsOn?: Dependency[]; // full-array replace; [] clears
}
/** taskId → the accumulated patch for that task (later edits merged over earlier). */
export type PatchMap = Record<string, TaskPatch>;

// ── the full working state (Phase 3.3): edits + adds + removes ──────────────────
//
// Quick-tier 3.2 carried only a `PatchMap`. The full editor adds two more kinds
// of pending change: tasks CREATED (rolling-wave "+ Add task") and tasks DELETED,
// both of which only touch a file at save time. Together these three make one
// `EditState`. An added-then-deleted task is a clean no-op (it never reaches a
// file). Every derivation below (dirty count, dirty files, working graph, save)
// reads the whole EditState so a filtered-out change still counts and still saves.

/** A task created in the UI but not yet committed. Its id encodes its owning file. */
export interface EditState {
  patches: PatchMap;
  added: Task[]; // full new tasks (id namespaced → owning file)
  removed: string[]; // ids marked for deletion at save
}

export const EMPTY_EDIT: EditState = { patches: {}, added: [], removed: [] };

// ── id → owning file (§5: squad prefix owns the file) ───────────────────────────

export const PROJECT_FILE = "data/project.yaml";
export const squadFile = (squadId: string): string =>
  `data/subgroups/${squadId}.yaml`;

/**
 * Which data file owns a task. A namespaced id whose prefix is a known squad
 * (`engines.injector-fab`) lives in that squad's file; anything else — the spine
 * reviews/gates (`review.pdr`), or an unknown prefix — lives in the project file.
 * (The project file is read-only in this slice; see `isEditable`.)
 */
export function fileForTaskId(id: string, squadIds: readonly string[]): string {
  const prefix = id.slice(0, id.indexOf("."));
  return prefix && squadIds.includes(prefix)
    ? squadFile(prefix)
    : PROJECT_FILE;
}

/** The squad id a task belongs to, or null if it isn't a squad-owned leaf. */
export function squadOfTaskId(
  id: string,
  squadIds: readonly string[],
): string | null {
  const prefix = id.slice(0, id.indexOf("."));
  return prefix && squadIds.includes(prefix) ? prefix : null;
}

// ── which rows may be quick-edited (§8 quick tier: leaf SQUAD tasks only) ────────

/** The minimal row shape editability depends on — a subset of ChartRow. */
export interface EditableRowInfo {
  kind: string; // ChartRowKind
  squadId: string | null;
}

/**
 * Quick-editable iff the row is an ordinary leaf task or a leaf milestone that
 * belongs to a squad. Spine gates/reviews, summaries, and group headers are NOT
 * editable in 3.2 (the full editor + project-file serializer arrive in 3.3).
 */
export function isEditable(row: EditableRowInfo): boolean {
  return (
    (row.kind === "task" || row.kind === "milestone") && row.squadId !== null
  );
}

// ── status cycle (§8: one click cycles status) ─────────────────────────────────

const STATUS_CYCLE: Status[] = [
  "not-started",
  "in-progress",
  "done",
  "blocked",
];

/** not-started → in-progress → done → blocked → (wrap) not-started. */
export function nextStatus(current: Status): Status {
  const i = STATUS_CYCLE.indexOf(current);
  // Unknown/absent → treat as the start of the cycle.
  return STATUS_CYCLE[(i + 1) % STATUS_CYCLE.length] ?? "in-progress";
}

// ── drag → patch mappings ──────────────────────────────────────────────────────

/**
 * Dragging a bar to a new position is the honest act of pinning it there: the
 * task becomes `pinned` at the dropped start. Duration is NOT in the patch, so
 * `applyPatchToTask`/`applyTaskEdit` merge only mode+start and the existing
 * duration survives (that's the "preserved duration" guarantee).
 */
export function movePatch(newStart: ISODate): TaskPatch {
  return { schedule: { mode: "pinned", start: newStart } };
}

/**
 * Resizing the right edge changes only the duration; `mode` is untouched, so an
 * auto task stays auto and a pinned task stays pinned at its start.
 */
export function resizePatch(newDurationDays: number): TaskPatch {
  return { schedule: { duration: Math.max(0, Math.round(newDurationDays)) } };
}

// ── full-panel patch builders (§8) ──────────────────────────────────────────────

/**
 * RELEASE a pinned task back to auto (the panel's "Auto — after dependencies"
 * timing choice). Crucially it sets `start: undefined`, not just `mode: auto`, so
 * both the in-memory merge and the serializer DROP the stale pinned start rather
 * than leaving a dead key behind. Duration is preserved.
 */
export function releasePatch(currentDurationDays: number): TaskPatch {
  return {
    schedule: {
      mode: "auto",
      start: undefined,
      duration: Math.max(0, Math.round(currentDurationDays)),
    },
  };
}

/**
 * Toggle the milestone flag. Turning it ON forces duration 0 (§5.3: a milestone
 * is zero-duration); turning it OFF just drops the flag and leaves the duration
 * for the user to set. `mode` is untouched either way.
 */
export function milestonePatch(on: boolean): TaskPatch {
  return on
    ? { milestone: true, schedule: { duration: 0 } }
    : { milestone: false };
}

// ── patch accumulation + application to the in-memory task graph ────────────────

/** Merge a new patch over any existing patch for a task (schedule merged too). */
export function accumulate(
  patches: PatchMap,
  id: string,
  patch: TaskPatch,
): PatchMap {
  const prev = patches[id];
  const merged: TaskPatch = { ...prev, ...patch };
  if (prev?.schedule || patch.schedule) {
    merged.schedule = { ...prev?.schedule, ...patch.schedule };
  }
  return { ...patches, [id]: merged };
}

/** Produce a full, engine-valid Task by merging a patch onto a loaded task. */
export function applyPatchToTask(task: Task, patch: TaskPatch): Task {
  const next: Task = { ...task };
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.confidence !== undefined) next.confidence = patch.confidence;
  if (patch.percent !== undefined) {
    if (patch.percent === null) delete next.percent;
    else next.percent = patch.percent;
  }
  if (patch.milestone !== undefined) {
    if (patch.milestone) next.milestone = true;
    else delete next.milestone;
  }
  if (patch.deadline !== undefined) {
    if (patch.deadline === null) delete next.deadline;
    else next.deadline = patch.deadline;
  }
  if (patch.dependsOn !== undefined) {
    if (patch.dependsOn.length === 0) delete next.dependsOn;
    else next.dependsOn = patch.dependsOn;
  }
  if (patch.schedule) {
    // Merge the schedule fragment over the existing schedule, then coerce back
    // to a valid union. Pinning without an explicit start keeps the old start if
    // any; a pinned task always carries a start (callers always supply one).
    const merged = { ...task.schedule, ...patch.schedule } as Record<
      string,
      unknown
    >;
    if (merged.mode === "pinned") {
      next.schedule = {
        mode: "pinned",
        start: String(merged.start ?? ""),
        ...(typeof merged.duration === "number"
          ? { duration: merged.duration }
          : {}),
      };
    } else {
      next.schedule = {
        mode: "auto",
        duration: typeof merged.duration === "number" ? merged.duration : 0,
      };
    }
  }
  return next;
}

/** Apply every accumulated patch to the loaded task list → the working graph. */
export function applyPatchesToTasks(tasks: Task[], patches: PatchMap): Task[] {
  if (Object.keys(patches).length === 0) return tasks;
  return tasks.map((t) => (patches[t.id] ? applyPatchToTask(t, patches[t.id]) : t));
}

/** The effective status of a task under the current patches (for the click cycle). */
export function effectiveStatus(task: Task, patch: TaskPatch | undefined): Status {
  return patch?.status ?? task.status ?? "not-started";
}

// ── dirty-file derivation ──────────────────────────────────────────────────────

/**
 * The set of files touched by the current patches, in a stable order (squad
 * files by squad order, project file last). Files own tasks by id prefix.
 */
export function dirtyFiles(
  patches: PatchMap,
  squadIds: readonly string[],
): string[] {
  const files = new Set<string>();
  for (const id of Object.keys(patches)) files.add(fileForTaskId(id, squadIds));
  const ordered: string[] = [];
  for (const s of squadIds) if (files.has(squadFile(s))) ordered.push(squadFile(s));
  if (files.has(PROJECT_FILE)) ordered.push(PROJECT_FILE);
  return ordered;
}

/** Count of tasks with an accumulated patch — the "N unsaved changes" note. */
export function dirtyCount(patches: PatchMap): number {
  return Object.keys(patches).length;
}

// ── EditState derivations (patches + adds + removes together) ────────────────────

/** The set of ids the state has created (fast membership test). */
function addedIds(state: EditState): Set<string> {
  return new Set(state.added.map((t) => t.id));
}

/**
 * The working task graph: start from the loaded tasks, drop everything removed,
 * append everything added, then apply every patch (added tasks get their
 * refinement patches applied too, since they're in the list by the time we map).
 */
export function applyEditsToTasks(tasks: Task[], state: EditState): Task[] {
  const removed = new Set(state.removed);
  const base = tasks.filter((t) => !removed.has(t.id));
  const withAdds = state.added.length ? [...base, ...state.added] : base;
  return applyPatchesToTasks(withAdds, state.patches);
}

/**
 * Add a freshly-created task to the working state. It carries its own id, so no
 * patch is needed yet — the panel opens on it and any refinement lands as a patch.
 */
export function addTaskToState(state: EditState, task: Task): EditState {
  return { ...state, added: [...state.added, task] };
}

/**
 * Mark a task for deletion. An added task that hasn't been saved is simply
 * un-added (a clean no-op — it never touched a file); an existing task joins the
 * `removed` list. Either way any pending patch on that id is dropped.
 */
export function removeTaskFromState(state: EditState, id: string): EditState {
  const patches = { ...state.patches };
  delete patches[id];
  if (addedIds(state).has(id)) {
    return { patches, added: state.added.filter((t) => t.id !== id), removed: state.removed };
  }
  const removed = state.removed.includes(id)
    ? state.removed
    : [...state.removed, id];
  return { patches, added: state.added, removed };
}

/**
 * Total unsaved changes across edits, adds and removes. A patch on an
 * already-added task is refinement of that one add, so it isn't double-counted.
 */
export function editDirtyCount(state: EditState): number {
  const added = addedIds(state);
  const patchedExisting = Object.keys(state.patches).filter(
    (id) => !added.has(id),
  ).length;
  return state.added.length + state.removed.length + patchedExisting;
}

/** Every file any pending change touches, in stable order (squads, then project). */
export function editDirtyFiles(
  state: EditState,
  squadIds: readonly string[],
): string[] {
  const files = new Set<string>();
  for (const id of Object.keys(state.patches))
    files.add(fileForTaskId(id, squadIds));
  for (const t of state.added) files.add(fileForTaskId(t.id, squadIds));
  for (const id of state.removed) files.add(fileForTaskId(id, squadIds));
  const ordered: string[] = [];
  for (const s of squadIds)
    if (files.has(squadFile(s))) ordered.push(squadFile(s));
  if (files.has(PROJECT_FILE)) ordered.push(PROJECT_FILE);
  return ordered;
}

// ── dependency helpers + eligibility (the §8 dependency picker) ──────────────────

/** The plain id of a dependency entry, whichever form it takes. */
export function depId(dep: Dependency): string {
  return typeof dep === "string" ? dep : dep.task;
}

/** All ids a task currently depends on. */
export function dependsOnIds(deps: Task["dependsOn"]): string[] {
  return (deps ?? []).map(depId);
}

/** Whether a task is a "published" marker other squads may depend on (§8). */
function isPublishedMilestone(t: Task): boolean {
  return t.milestone === true;
}

/** Whether a task is a spine review/gate (§7). */
function isSpine(t: Task): boolean {
  return t.gate !== undefined;
}

/** One selectable dependency target, tagged with the group it should list under. */
export interface EligibleTarget {
  id: string;
  name: string;
  /** "Spine" for reviews/gates, else the squad name — for grouping the picker. */
  group: string;
}

/**
 * The eligible dependency targets for `current`, as a pure, testable list — the
 * heart of the §8 cross-squad rule.
 *
 * For a SQUAD task: its own squad's tasks (any, including summaries — the engine
 * expands them) + ALL spine reviews/gates + OTHER squads' published milestones
 * ONLY. A different squad's ordinary internal tasks are deliberately absent —
 * you couple across squads through their published gates/milestones, never their
 * guts.
 *
 * For a SPINE task: every squad's published milestones + all other spine items.
 *
 * Self and anything already depended-on are removed in both cases. No cycle
 * filtering — the engine reports a loop and the panel warns; picking is free.
 */
export function eligibleDependencyTargets(
  current: Task,
  allTasks: readonly Task[],
  squads: readonly { id: string; name: string }[],
  squadIds: readonly string[],
): EligibleTarget[] {
  const already = new Set(dependsOnIds(current.dependsOn));
  const squadName = new Map(squads.map((s) => [s.id, s.name]));
  const currentSquad = squadOfTaskId(current.id, squadIds);
  const currentIsSpine = isSpine(current);

  const out: EligibleTarget[] = [];
  for (const t of allTasks) {
    if (t.id === current.id || already.has(t.id)) continue;
    const tSquad = squadOfTaskId(t.id, squadIds);

    let eligible: boolean;
    if (currentIsSpine) {
      // spine: all squads' published milestones + other spine items.
      eligible = isSpine(t) || isPublishedMilestone(t);
    } else {
      // squad task: own squad (anything) + all spine + other squads' milestones.
      eligible =
        (tSquad !== null && tSquad === currentSquad) ||
        isSpine(t) ||
        (tSquad !== null && tSquad !== currentSquad && isPublishedMilestone(t));
    }
    if (!eligible) continue;

    out.push({
      id: t.id,
      name: t.name,
      group: isSpine(t) ? "Spine" : (squadName.get(tSquad ?? "") ?? "Other"),
    });
  }
  return out;
}

/** Tasks that depend on `id` — the delete-block list ("X and N others depend…"). */
export function blockingDependents(
  id: string,
  tasks: readonly Task[],
): Task[] {
  return tasks.filter((t) => dependsOnIds(t.dependsOn).includes(id));
}

// ── new-task id generation (rolling-wave "+ Add task", §10) ──────────────────────

/** A url/id-safe kebab slug of a display name. Empty input → "task". */
export function kebab(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "task";
}

/**
 * A fresh, unique namespaced id `squad.slug-of-name`, bumping a numeric suffix
 * (`-2`, `-3`, …) until it clears every existing id. Pure so it's unit-tested.
 */
export function makeTaskId(
  squadId: string,
  name: string,
  existingIds: Iterable<string>,
): string {
  const used = new Set(existingIds);
  const base = `${squadId}.${kebab(name)}`;
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** A brand-new squad task: auto, 7-day default, not-started, guess, no deps (§10). */
export function newSquadTask(id: string, name: string): Task {
  return {
    id,
    name,
    schedule: { mode: "auto", duration: 7 },
    status: "not-started",
    confidence: "guess",
  };
}

// ── commit message ─────────────────────────────────────────────────────────────

/** The local part of a namespaced id: `engines.injector-fab` → `injector-fab`. */
export function localId(id: string): string {
  const dot = id.indexOf(".");
  return dot >= 0 ? id.slice(dot + 1) : id;
}

/**
 * A plain-language commit subject for one file's save, e.g.
 * `engines: update injector-fab, igniter-test-campaign (First Light)`.
 * `label` is the squad id (or "project" for the spine file).
 */
export function commitMessage(label: string, taskIds: string[]): string {
  const names = taskIds.map(localId).join(", ");
  return `${label}: update ${names} (First Light)`;
}

/**
 * A richer commit subject for a save that adds and/or removes tasks (not just
 * edits), e.g. `engines: add flow-bench; update injector-fab; remove old (First Light)`.
 * Pure-edit files keep the simpler `commitMessage` above unchanged.
 */
export function commitMessageFor(
  label: string,
  change: { added: string[]; edited: string[]; removed: string[] },
): string {
  const parts: string[] = [];
  if (change.added.length)
    parts.push(`add ${change.added.map(localId).join(", ")}`);
  if (change.edited.length)
    parts.push(`update ${change.edited.map(localId).join(", ")}`);
  if (change.removed.length)
    parts.push(`remove ${change.removed.map(localId).join(", ")}`);
  return `${label}: ${parts.join("; ")} (First Light)`;
}

// ── save orchestration (injected GitHub client — testable without a network) ────

/** The two GitHub calls the save flow needs, injected so tests pass fakes. */
export interface GitHubClient {
  loadFile: (
    target: GitHubTarget,
    path: string,
    token: string,
  ) => Promise<LoadResult>;
  saveFile: (
    target: GitHubTarget,
    path: string,
    newText: string,
    message: string,
    base: { sha: string; text: string },
    token: string,
  ) => Promise<SaveResult>;
}

export interface SaveInput {
  patches: PatchMap;
  /** Tasks created in the UI, to be appended to their files at save. */
  added?: Task[];
  /** Ids to delete from their files at save. */
  removed?: string[];
  /** The text each file was ORIGINALLY loaded with (from static hosting). */
  originalTexts: Record<string, string>;
  squadIds: readonly string[];
  target: GitHubTarget;
  token: string;
}

/** Per-file outcome of a save attempt. */
export interface FileSaveResult {
  path: string;
  taskIds: string[]; // the tasks this file's save covered
  ok: boolean;
  error?: GitHubError;
  newText?: string; // on success: the committed text (becomes the new base)
  newSha?: string; // on success: the new blob sha
}

export interface SaveOutcome {
  results: FileSaveResult[];
  /** True when nothing was attempted because no token is configured. */
  noToken: boolean;
}

/**
 * Save every dirty file, sequentially. Reads are static in this app (Phase-0),
 * so we do a JUST-IN-TIME `loadFile` per dirty file to obtain {sha, text}. If
 * that remote text differs from what we originally loaded, we treat it as a
 * conflict BEFORE touching the file — the user's edits are never applied blind
 * over someone else's. Otherwise we replay this file's task patches onto the
 * original text (comment-preserving, minimal diff) and commit against the fresh
 * sha. Files are independent: one file's failure leaves its edits dirty but does
 * not stop the others, and each success clears only its own tasks.
 */
export async function saveAll(
  input: SaveInput,
  client: GitHubClient,
): Promise<SaveOutcome> {
  const { patches, added = [], removed = [], originalTexts, squadIds, target, token } =
    input;
  if (!token || token.trim() === "") return { results: [], noToken: true };

  const state: EditState = { patches, added, removed };
  const files = editDirtyFiles(state, squadIds);
  const addedById = new Map(added.map((t) => [t.id, t]));
  const results: FileSaveResult[] = [];

  for (const path of files) {
    const inFile = (id: string) => fileForTaskId(id, squadIds) === path;
    const removedIds = removed.filter(inFile);
    const addedForFile = added.filter((t) => inFile(t.id));
    // Patches on added tasks are baked into the add below, not replayed as edits.
    const editIds = Object.keys(patches).filter(
      (id) => inFile(id) && !addedById.has(id),
    );
    // Every id this file's save covers — the app clears exactly these on success.
    const taskIds = [
      ...editIds,
      ...addedForFile.map((t) => t.id),
      ...removedIds,
    ];
    const label =
      path === PROJECT_FILE ? "project" : squadOfTaskId(taskIds[0], squadIds)!;

    // 1 · JIT fetch of the live file to get its sha + current remote text.
    const loaded = await client.loadFile(target, path, token);
    if (!loaded.ok) {
      results.push({ path, taskIds, ok: false, error: loaded.error });
      continue;
    }

    // 2 · Conflict guard: if the remote drifted from what we loaded statically,
    //     surface it and keep the edits — never apply over an unseen change.
    const original = originalTexts[path] ?? "";
    if (loaded.file.text !== original) {
      results.push({
        path,
        taskIds,
        ok: false,
        error: { kind: "conflict", remote: loaded.file },
      });
      continue;
    }

    // 3 · One text pass: removes, then adds (with their refinement patches baked
    //     in), then edits — a tiny, reviewable diff either way.
    let newText = original;
    for (const id of removedIds) newText = removeTask(newText, id);
    for (const t of addedForFile) {
      const p = patches[t.id];
      newText = addTask(newText, p ? applyPatchToTask(t, p) : t);
    }
    for (const id of editIds) {
      newText = applyTaskEdit(newText, id, patchToTaskEdit(patches[id]));
    }

    // 4 · Commit against the fresh sha. Pure-edit files keep the original
    //     one-verb message; add/remove files get the richer three-verb one.
    const message =
      addedForFile.length || removedIds.length
        ? commitMessageFor(label, {
            added: addedForFile.map((t) => t.id),
            edited: editIds,
            removed: removedIds,
          })
        : commitMessage(label, editIds);
    const saved = await client.saveFile(
      target,
      path,
      newText,
      message,
      { sha: loaded.file.sha, text: loaded.file.text },
      token,
    );
    if (saved.ok) {
      results.push({
        path,
        taskIds,
        ok: true,
        newText,
        newSha: saved.newSha,
      });
    } else {
      results.push({ path, taskIds, ok: false, error: saved.error });
    }
  }

  return { results, noToken: false };
}

/**
 * Translate a UI TaskPatch into the `Partial<Task>` shape `applyTaskEdit` expects.
 * The schedule fragment passes straight through — `applyTaskEdit` merges it into
 * the file's existing schedule map key-by-key, so unchanged keys stay put.
 */
function patchToTaskEdit(patch: TaskPatch): Partial<Task> {
  const out: Partial<Task> = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.confidence !== undefined) out.confidence = patch.confidence;
  // A cleared field becomes `undefined` in the patch object so applyTaskEdit's
  // undefined-deletes path drops the key from the YAML entirely.
  if (patch.percent !== undefined)
    out.percent = patch.percent === null ? undefined : patch.percent;
  if (patch.milestone !== undefined)
    out.milestone = patch.milestone ? true : undefined;
  if (patch.deadline !== undefined)
    out.deadline = patch.deadline === null ? undefined : patch.deadline;
  if (patch.dependsOn !== undefined)
    out.dependsOn = patch.dependsOn.length === 0 ? undefined : patch.dependsOn;
  if (patch.schedule) out.schedule = patch.schedule as Task["schedule"];
  return out;
}
