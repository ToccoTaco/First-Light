// storage/validate.ts — turn raw parsed nodes into trustworthy engine Tasks.
//
// Two layers of checking, both governed by one rule: report the problem, fix it
// the least-destructive way, keep going.
//
//   validateTask()  — per-task and per-field. A structurally broken task (no id,
//                     no usable schedule) is DROPPED with an error. A merely
//                     dodgy field (bad status, out-of-range percent…) is fixed
//                     in place with a warning and the task survives.
//
//   validateGraph() — the checks that only make sense once every file is merged:
//                     duplicate ids across files, and the `parent` links. The
//                     engine assumes `parent` forms a forest (no cycles) and
//                     would loop forever otherwise — so this function is the
//                     gatekeeper that makes that assumption safe. It breaks any
//                     parent self-loop or cycle before the graph reaches the engine.

import type { Task, Status } from "../engine/types";
import type { DataIssue } from "./types";

const STATUSES: Status[] = ["not-started", "in-progress", "blocked", "done"];

/** A validated task paired with the file it came from (needed for graph checks). */
export interface LocatedTask {
  task: Task;
  file: string;
}

export interface ValidateTaskResult {
  task?: Task; // absent ⇒ the task was dropped (see issues)
  issues: DataIssue[];
}

/**
 * Validate one raw task node from `file`. `squadNamespace`, when given (squad
 * files), is the prefix every id in that file is expected to carry, e.g.
 * "engines" for data/subgroups/engines.yaml.
 */
export function validateTask(
  raw: unknown,
  file: string,
  squadNamespace?: string,
): ValidateTaskResult {
  const issues: DataIssue[] = [];

  if (!isPlainObject(raw)) {
    issues.push({
      severity: "error",
      file,
      message: "task entry is not a mapping — task dropped",
    });
    return { issues };
  }
  const r = raw as Record<string, unknown>;

  // ── id — no id, no task. Everything keys off this. ──────────────────────────
  if (typeof r.id !== "string" || r.id.length === 0) {
    issues.push({
      severity: "error",
      file,
      field: "id",
      message:
        "task has a missing or non-string `id` — task dropped (a task with no id can't be scheduled or referenced)",
    });
    return { issues };
  }
  const id = r.id;

  // ── milestone / gate — parsed early because they license a missing schedule ─
  let milestone: boolean | undefined;
  if (r.milestone !== undefined) {
    if (typeof r.milestone === "boolean") milestone = r.milestone;
    else
      issues.push({
        severity: "warning",
        file,
        taskId: id,
        field: "milestone",
        message: `${id}: \`milestone\` is not true/false — field dropped`,
      });
  }
  let gate: "review" | "test" | undefined;
  if (r.gate !== undefined) {
    if (r.gate === "review" || r.gate === "test") gate = r.gate;
    else
      issues.push({
        severity: "warning",
        file,
        taskId: id,
        field: "gate",
        message: `${id}: \`gate\` is "${String(r.gate)}", not "review" or "test" — field dropped`,
      });
  }
  const isMilestone = milestone === true || gate !== undefined;

  // ── schedule — the other structural must-have (unless it's a milestone) ─────
  const schedule = validateSchedule(r.schedule, id, file, isMilestone, issues);
  if (schedule === undefined) return { issues }; // dropped; validateSchedule explained why

  // From here the task survives; remaining problems only trim fields.
  const task: Task = { id, name: "", schedule };

  // ── name — warn + default to id ─────────────────────────────────────────────
  if (typeof r.name === "string" && r.name.length > 0) {
    task.name = r.name;
  } else {
    task.name = id;
    issues.push({
      severity: "warning",
      file,
      taskId: id,
      field: "name",
      message: `${id}: \`name\` is missing — defaulted to the id`,
    });
  }

  if (milestone !== undefined) task.milestone = milestone;
  if (gate !== undefined) task.gate = gate;

  // ── parent — a non-string here is nonsense; drop the field, keep the task ───
  if (r.parent !== undefined) {
    if (typeof r.parent === "string" && r.parent.length > 0)
      task.parent = r.parent;
    else
      issues.push({
        severity: "warning",
        file,
        taskId: id,
        field: "parent",
        message: `${id}: \`parent\` is not a task id string — field dropped (task treated as a root)`,
      });
  }

  // ── dependsOn — validate entry by entry; drop only the bad ones ─────────────
  if (r.dependsOn !== undefined) {
    if (!Array.isArray(r.dependsOn)) {
      issues.push({
        severity: "warning",
        file,
        taskId: id,
        field: "dependsOn",
        message: `${id}: \`dependsOn\` is not a list — field dropped`,
      });
    } else {
      const deps = validateDependsOn(r.dependsOn, id, file, issues);
      if (deps.length > 0) task.dependsOn = deps;
    }
  }

  // ── status — bad value warns and is treated as unset (not-started) ──────────
  if (r.status !== undefined) {
    if (STATUSES.includes(r.status as Status)) task.status = r.status as Status;
    else
      issues.push({
        severity: "warning",
        file,
        taskId: id,
        field: "status",
        message: `${id}: \`status\` is "${String(r.status)}", not one of ${STATUSES.join("/")} — treated as not-started`,
      });
  }

  // ── confidence — pass-through metadata; drop if not one of the three ────────
  if (r.confidence !== undefined) {
    if (
      r.confidence === "firm" ||
      r.confidence === "estimate" ||
      r.confidence === "guess"
    )
      task.confidence = r.confidence;
    else
      issues.push({
        severity: "warning",
        file,
        taskId: id,
        field: "confidence",
        message: `${id}: \`confidence\` is "${String(r.confidence)}", not firm/estimate/guess — field dropped`,
      });
  }

  // ── percent — must be a number in 0..100 ────────────────────────────────────
  if (r.percent !== undefined) {
    if (
      typeof r.percent === "number" &&
      Number.isFinite(r.percent) &&
      r.percent >= 0 &&
      r.percent <= 100
    )
      task.percent = r.percent;
    else
      issues.push({
        severity: "warning",
        file,
        taskId: id,
        field: "percent",
        message: `${id}: \`percent\` is "${String(r.percent)}", not a number in 0–100 — field dropped`,
      });
  }

  // ── deadline — needs a real date and a boolean `hard` ───────────────────────
  if (r.deadline !== undefined) {
    if (
      isPlainObject(r.deadline) &&
      isValidISODate((r.deadline as Record<string, unknown>).date) &&
      typeof (r.deadline as Record<string, unknown>).hard === "boolean"
    ) {
      const d = r.deadline as Record<string, unknown>;
      task.deadline = { date: d.date as string, hard: d.hard as boolean };
    } else {
      issues.push({
        severity: "warning",
        file,
        taskId: id,
        field: "deadline",
        message: `${id}: \`deadline\` needs a real date and a true/false \`hard\` — field dropped`,
      });
    }
  }

  // ── namespace hygiene (squad files only) — a warning, never fatal ───────────
  if (squadNamespace !== undefined && !id.startsWith(squadNamespace + ".")) {
    issues.push({
      severity: "warning",
      file,
      taskId: id,
      field: "id",
      message: `${id}: id does not start with "${squadNamespace}." — kept, but squad-file ids should be namespaced to their squad`,
    });
  }

  return { task, issues };
}

/**
 * Graph-level validation over the merged task list, in the order the files were
 * passed. Removes duplicate-id tasks (keeping the first) and neutralises every
 * parent problem so the result is a clean forest the engine can walk safely.
 * Returns the surviving tasks (parent fields fixed in place) plus issues.
 */
export function validateGraph(located: LocatedTask[]): {
  tasks: Task[];
  issues: DataIssue[];
} {
  const issues: DataIssue[] = [];

  // ── duplicate ids across all files: keep the first, drop the rest ───────────
  const firstFile = new Map<string, string>();
  const kept: LocatedTask[] = [];
  for (const lt of located) {
    const prev = firstFile.get(lt.task.id);
    if (prev !== undefined) {
      issues.push({
        severity: "error",
        file: lt.file,
        taskId: lt.task.id,
        message: `duplicate id "${lt.task.id}" — already defined in ${prev}; this later copy in ${lt.file} was dropped`,
      });
      continue;
    }
    firstFile.set(lt.task.id, lt.file);
    kept.push(lt);
  }

  const tasks = kept.map((lt) => lt.task);
  const fileOf = new Map<string, string>();
  kept.forEach((lt) => fileOf.set(lt.task.id, lt.file));
  const idSet = new Set(tasks.map((t) => t.id));

  // ── parent self-loops: x.parent === x ───────────────────────────────────────
  for (const t of tasks) {
    if (t.parent !== undefined && t.parent === t.id) {
      issues.push({
        severity: "error",
        file: fileOf.get(t.id)!,
        taskId: t.id,
        field: "parent",
        message: `${t.id}: parent refers to itself — parent link removed`,
      });
      delete t.parent;
    }
  }

  // ── parent points at an id that doesn't exist: treat as a root ──────────────
  for (const t of tasks) {
    if (t.parent !== undefined && !idSet.has(t.parent)) {
      issues.push({
        severity: "warning",
        file: fileOf.get(t.id)!,
        taskId: t.id,
        field: "parent",
        message: `${t.id}: parent "${t.parent}" does not exist — treated as a root task`,
      });
      delete t.parent;
    }
  }

  // ── parent cycles: a→b→c→a. Break EVERY member; children hanging off the ────
  // cycle (which point in but aren't part of it) keep their parent and resolve
  // once the loop is broken.
  const parentOf = new Map<string, string>();
  for (const t of tasks)
    if (t.parent !== undefined) parentOf.set(t.id, t.parent);

  const inCycle = new Set<string>();
  const settled = new Set<string>(); // nodes whose chain we've already resolved
  for (const start of parentOf.keys()) {
    if (settled.has(start)) continue;
    const path: string[] = [];
    const seen = new Map<string, number>();
    let cur: string | undefined = start;
    while (cur !== undefined && parentOf.has(cur) && !settled.has(cur)) {
      const at = seen.get(cur);
      if (at !== undefined) {
        // Found a loop: everything from the first sighting of `cur` onward.
        const chain = path.slice(at);
        for (const c of chain) inCycle.add(c);
        reportCycle(chain, fileOf, issues);
        break;
      }
      seen.set(cur, path.length);
      path.push(cur);
      cur = parentOf.get(cur);
    }
    for (const p of path) settled.add(p);
  }
  for (const t of tasks) {
    if (t.parent !== undefined && inCycle.has(t.id)) delete t.parent;
  }

  return { tasks, issues };
}

// ── internals ────────────────────────────────────────────────────────────────

type Schedule = Task["schedule"];

/**
 * Validate the `schedule` block. Returns the clean schedule, or `undefined` to
 * signal the caller must drop the whole task (a task with no usable schedule
 * can't be placed on a timeline). Milestones/gates without a schedule default
 * to a zero-duration auto task — that's the norm for the spine, so it's silent.
 */
function validateSchedule(
  raw: unknown,
  id: string,
  file: string,
  isMilestone: boolean,
  issues: DataIssue[],
): Schedule | undefined {
  if (raw === undefined) {
    if (isMilestone) return { mode: "auto", duration: 0 }; // normal for gates/reviews
    issues.push({
      severity: "error",
      file,
      taskId: id,
      field: "schedule",
      message: `${id}: no \`schedule\` block — task dropped (a non-milestone needs a duration or a pinned start)`,
    });
    return undefined;
  }
  if (!isPlainObject(raw)) {
    issues.push({
      severity: "error",
      file,
      taskId: id,
      field: "schedule",
      message: `${id}: \`schedule\` is not a mapping — task dropped`,
    });
    return undefined;
  }

  const s = raw as Record<string, unknown>;
  const mode = s.mode;

  if (mode === "auto") {
    const dur = s.duration;
    if (isMilestone && !isFiniteNumber(dur))
      return { mode: "auto", duration: 0 };
    if (!isFiniteNumber(dur) || dur < 0) {
      issues.push({
        severity: "error",
        file,
        taskId: id,
        field: "schedule.duration",
        message: `${id}: auto task needs a finite \`duration\` ≥ 0 (got "${String(dur)}") — task dropped`,
      });
      return undefined;
    }
    return { mode: "auto", duration: dur };
  }

  if (mode === "pinned") {
    if (!isValidISODate(s.start)) {
      issues.push({
        severity: "error",
        file,
        taskId: id,
        field: "schedule.start",
        message: `${id}: pinned task needs a valid YYYY-MM-DD \`start\` (got "${String(s.start)}") — task dropped`,
      });
      return undefined;
    }
    if (s.duration !== undefined) {
      if (!isFiniteNumber(s.duration) || s.duration < 0) {
        issues.push({
          severity: "error",
          file,
          taskId: id,
          field: "schedule.duration",
          message: `${id}: \`duration\` is "${String(s.duration)}", not a finite number ≥ 0 — task dropped`,
        });
        return undefined;
      }
      return { mode: "pinned", start: s.start as string, duration: s.duration };
    }
    return { mode: "pinned", start: s.start as string };
  }

  issues.push({
    severity: "error",
    file,
    taskId: id,
    field: "schedule.mode",
    message: `${id}: \`schedule.mode\` is "${String(mode)}", not "auto" or "pinned" — task dropped`,
  });
  return undefined;
}

/** Validate a dependsOn list, dropping only the malformed entries. */
function validateDependsOn(
  list: unknown[],
  id: string,
  file: string,
  issues: DataIssue[],
): NonNullable<Task["dependsOn"]> {
  const out: NonNullable<Task["dependsOn"]> = [];
  list.forEach((entry, i) => {
    if (typeof entry === "string") {
      if (entry.length > 0) out.push(entry);
      else
        issues.push({
          severity: "error",
          file,
          taskId: id,
          field: "dependsOn",
          message: `${id}: dependsOn entry #${i + 1} is an empty string — entry dropped`,
        });
      return;
    }
    if (isPlainObject(entry)) {
      const e = entry as Record<string, unknown>;
      if (typeof e.task !== "string" || e.task.length === 0) {
        issues.push({
          severity: "error",
          file,
          taskId: id,
          field: "dependsOn",
          message: `${id}: dependsOn entry #${i + 1} has no \`task\` id — entry dropped`,
        });
        return;
      }
      if (e.type !== undefined && e.type !== "FS" && e.type !== "SS") {
        issues.push({
          severity: "error",
          file,
          taskId: id,
          field: "dependsOn",
          message: `${id}: dependsOn on "${e.task}" has type "${String(e.type)}", not FS/SS — entry dropped`,
        });
        return;
      }
      if (e.lag !== undefined && !isFiniteNumber(e.lag)) {
        issues.push({
          severity: "error",
          file,
          taskId: id,
          field: "dependsOn",
          message: `${id}: dependsOn on "${e.task}" has a non-number \`lag\` ("${String(e.lag)}") — entry dropped`,
        });
        return;
      }
      const dep: { task: string; type?: "FS" | "SS"; lag?: number } = {
        task: e.task,
      };
      if (e.type !== undefined) dep.type = e.type as "FS" | "SS";
      if (e.lag !== undefined) dep.lag = e.lag as number;
      out.push(dep);
      return;
    }
    issues.push({
      severity: "error",
      file,
      taskId: id,
      field: "dependsOn",
      message: `${id}: dependsOn entry #${i + 1} is neither a task id nor a { task, … } mapping — entry dropped`,
    });
  });
  return out;
}

/** Emit one error naming the whole loop, in order, starting at the smallest id. */
function reportCycle(
  chain: string[],
  fileOf: Map<string, string>,
  issues: DataIssue[],
): void {
  // Rotate so the loop always starts at its lexicographically smallest member —
  // that makes the reported chain deterministic no matter which node we entered from.
  let min = 0;
  for (let i = 1; i < chain.length; i++) if (chain[i] < chain[min]) min = i;
  const rotated = [...chain.slice(min), ...chain.slice(0, min)];
  const arrow = [...rotated, rotated[0]].join(" → ");
  issues.push({
    severity: "error",
    file: fileOf.get(rotated[0])!,
    taskId: rotated[0],
    field: "parent",
    message: `parent loop detected: ${arrow} — parent links removed from all ${rotated.length} tasks in the loop`,
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** True only for a real calendar date in strict YYYY-MM-DD form (2026-02-30 fails). */
export function isValidISODate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}
