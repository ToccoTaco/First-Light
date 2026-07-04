// storage/merge.ts — the one gate between the data files and the engine.
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │  EVERY caller that wants a schedule reaches the engine THROUGH this file.  │
// │  `mergeProject` is the single supported way to turn raw file text into the │
// │  Task[] + Config that `computeSchedule` consumes. Parsing, per-task        │
// │  validation, and graph-safety (no duplicate ids, no parent cycles) all run │
// │  here, in that order, so whatever comes out is guaranteed engine-safe.     │
// └───────────────────────────────────────────────────────────────────────────┘
//
// The clock is never read in here. The caller injects `now`; `schedule.today:
// auto` resolves to it. That keeps the whole data layer a pure function of its
// inputs — that is what makes it unit-testable in plain node.

import type { Config } from "../engine/types";
import type { DataIssue, ProjectData, ISODate } from "./types";
import { parseProjectFile, parseTaskFile } from "./parse-file";
import {
  validateTask,
  validateGraph,
  isValidISODate,
  type LocatedTask,
} from "./validate";

export interface SourceFile {
  path: string; // repo-relative, e.g. "data/subgroups/engines.yaml"
  text: string;
}

/**
 * Merge every project + squad file into one validated, hierarchy-safe
 * ProjectData. `now` (an ISO date) is what `schedule.today: auto` resolves to —
 * the caller supplies it so storage never touches the system clock.
 *
 * Files are processed in the order given; that order is the tie-breaker for
 * duplicate-id resolution (first wins) and for task ordering, so identical
 * input always yields deeply-equal output.
 */
export function mergeProject(files: SourceFile[], now: ISODate): ProjectData {
  const issues: DataIssue[] = [];

  let projectName = "";
  let team = "";
  let squads: ProjectData["squads"] = [];
  let todayRaw = "";
  const located: LocatedTask[] = [];

  for (const file of files) {
    if (isProjectFile(file.path)) {
      const parsed = parseProjectFile(file.path, file.text);
      issues.push(...parsed.issues);
      projectName = parsed.projectName;
      team = parsed.team;
      squads = parsed.squads;
      todayRaw = parsed.todayRaw;
      // Reviews + gates are ordinary tasks living in the project file.
      for (const raw of parsed.spineTasks) {
        const { task, issues: taskIssues } = validateTask(raw, file.path);
        issues.push(...taskIssues);
        if (task) located.push({ task, file: file.path });
      }
    } else {
      const namespace = squadNamespaceOf(file.path);
      const parsed = parseTaskFile(file.path, file.text);
      issues.push(...parsed.issues);
      for (const raw of parsed.tasks) {
        const { task, issues: taskIssues } = validateTask(
          raw,
          file.path,
          namespace,
        );
        issues.push(...taskIssues);
        if (task) located.push({ task, file: file.path });
      }
    }
  }

  // Graph-level safety: dedupe ids, break parent self-loops / cycles. After this
  // the task list is a clean forest the engine can walk without hanging.
  const graph = validateGraph(located);
  issues.push(...graph.issues);

  const config = resolveConfig(todayRaw, now, issues);

  return {
    projectName,
    team,
    squads,
    tasks: graph.tasks,
    config,
    issues,
  };
}

// ── internals ────────────────────────────────────────────────────────────────

/** `schedule.today: auto` → the injected `now`; a literal date is respected. */
function resolveConfig(
  todayRaw: string,
  now: ISODate,
  issues: DataIssue[],
): Config {
  let today: ISODate;
  if (todayRaw === "" || todayRaw === "auto") {
    today = now;
  } else if (isValidISODate(todayRaw)) {
    today = todayRaw;
  } else {
    today = now;
    issues.push({
      severity: "warning",
      file: "data/project.yaml",
      field: "schedule.today",
      message: `\`schedule.today\` is "${todayRaw}", not a valid date or "auto" — using today's date instead`,
    });
  }
  return { calendar: "calendar-days", today };
}

/** The project file is the one named project.yaml (at any path depth). */
function isProjectFile(path: string): boolean {
  return /(^|[\\/])project\.ya?ml$/i.test(path);
}

/** "data/subgroups/engines.yaml" → "engines" (the expected id prefix). */
function squadNamespaceOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.ya?ml$/i, "");
}
