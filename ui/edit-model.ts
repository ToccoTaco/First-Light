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
import { applyTaskEdit } from "../storage/serialize";

// A patch's schedule is a free-form fragment merged over the task's own schedule,
// so it need not be a complete `auto | pinned` union on its own.
export type SchedulePatch = Partial<{
  mode: "auto" | "pinned";
  start: ISODate;
  duration: number;
}>;
export interface TaskPatch {
  schedule?: SchedulePatch;
  status?: Status;
}
/** taskId → the accumulated patch for that task (later edits merged over earlier). */
export type PatchMap = Record<string, TaskPatch>;

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
  const { patches, originalTexts, squadIds, target, token } = input;
  if (!token || token.trim() === "") return { results: [], noToken: true };

  const files = dirtyFiles(patches, squadIds);
  const results: FileSaveResult[] = [];

  for (const path of files) {
    const taskIds = Object.keys(patches).filter(
      (id) => fileForTaskId(id, squadIds) === path,
    );
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

    // 3 · Replay the patches onto the original text (tiny, reviewable diff).
    let newText = original;
    for (const id of taskIds) {
      newText = applyTaskEdit(newText, id, patchToTaskEdit(patches[id]));
    }

    // 4 · Commit against the fresh sha.
    const saved = await client.saveFile(
      target,
      path,
      newText,
      commitMessage(label, taskIds),
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
  if (patch.schedule) out.schedule = patch.schedule as Task["schedule"];
  return out;
}
