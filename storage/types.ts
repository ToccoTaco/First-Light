// storage/types.ts — the data-layer contract (Phase 2A).
//
// Storage mirrors the engine's test-8 philosophy: bad data is *reported*, never
// fatal, and never blanks the chart. Every loader returns whatever was
// salvageable plus a plain-language list of issues. The engine types (Task,
// Config) are the single source of truth for the graph shape — we import them,
// never redeclare them.

import type { Task, Config } from "../engine/types";

/**
 * One thing that was wrong with a data file, plus what the loader did about it.
 * The `message` is written for a human: it names the exact problem AND the fix
 * that was applied (dropped the field, dropped the task, defaulted the value…),
 * so a squad lead reading the load report knows precisely what to correct.
 */
export interface DataIssue {
  severity: "error" | "warning";
  file: string; // repo-relative path, e.g. "data/subgroups/engines.yaml"
  taskId?: string; // set when the issue is attributable to one task
  field?: string; // set when the issue is attributable to one field
  message: string; // plain language: the problem AND what was done about it
}

/** A squad as declared in project.yaml (the coloured swim-lanes of the chart). */
export interface Squad {
  id: string;
  name: string;
  color: string;
}

/**
 * The fully merged, validated, hierarchy-safe project — ready to hand straight
 * to `computeSchedule`. Producing one of these is the ONLY supported way to
 * reach the engine (see merge.ts); nothing else may build a Task[] by hand.
 */
export interface ProjectData {
  projectName: string;
  team: string;
  squads: Squad[];
  tasks: Task[]; // merged + validated + forest-safe (no parent cycles)
  config: Config; // `today: auto` already resolved to the injected `now`
  issues: DataIssue[]; // everything the load had to fix, across all files
}

/** ISO calendar date, "YYYY-MM-DD" — same convention as the engine. */
export type ISODate = string;
