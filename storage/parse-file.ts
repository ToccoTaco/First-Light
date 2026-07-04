// storage/parse-file.ts — YAML text → raw structures, robustly.
//
// This is the first stage of the load pipeline (parse → validate → merge). Its
// only job is to turn file *text* into raw JavaScript values and to catch the
// two failures that happen before any per-task rule can even run:
//   1. the YAML itself won't parse, or
//   2. the top-level shape is wrong (a squad file whose `tasks` isn't a list,
//      a project file with no `squads`).
//
// It NEVER throws. A broken file yields empty content plus one error issue that
// names the file and, where the YAML parser gives us one, the line/column of
// the fault. Deeper validation (per-task, per-field, graph) lives in validate.ts.

import { parseDocument } from "yaml";
import type { DataIssue, Squad } from "./types";

/** Raw task nodes are validated later; here they are just untyped mappings. */
export type RawTask = unknown;

export interface ParsedTaskFile {
  tasks: RawTask[];
  issues: DataIssue[];
}

export interface ParsedProjectFile {
  projectName: string;
  team: string;
  squads: Squad[];
  /** Verbatim `schedule.today` — "auto", a literal date, or "" if absent. */
  todayRaw: string;
  calendar: "calendar-days";
  /** Raw review + gate mappings — validated as tasks downstream. */
  spineTasks: RawTask[];
  issues: DataIssue[];
}

/**
 * Parse one squad file. On any parse error, or if `tasks` is missing or not a
 * list, returns zero tasks plus a single error issue — the rest of the project
 * still loads. A valid file returns its raw task nodes untouched.
 */
export function parseTaskFile(path: string, text: string): ParsedTaskFile {
  const { value, issues } = parseYaml(path, text);
  if (value === undefined) return { tasks: [], issues };

  if (!isPlainObject(value)) {
    return {
      tasks: [],
      issues: [
        {
          severity: "error",
          file: path,
          message:
            "file is not a YAML mapping (expected a top-level `tasks:` list) — no tasks loaded",
        },
      ],
    };
  }

  const tasksNode = (value as Record<string, unknown>).tasks;
  if (tasksNode === undefined) {
    return {
      tasks: [],
      issues: [
        {
          severity: "error",
          file: path,
          message: "no `tasks:` key found — no tasks loaded from this file",
        },
      ],
    };
  }
  if (!Array.isArray(tasksNode)) {
    return {
      tasks: [],
      issues: [
        {
          severity: "error",
          file: path,
          message: "`tasks` is not a list — no tasks loaded from this file",
        },
      ],
    };
  }

  return { tasks: tasksNode, issues };
}

/**
 * Parse the project file. Yields the squads, the resolved-later config, and the
 * spine (reviews + gates) as raw tasks. Missing `squads` is an error but not
 * fatal — squads default to `[]` and everything else still loads. Malformed
 * individual squad entries are dropped with a warning.
 */
export function parseProjectFile(
  path: string,
  text: string,
): ParsedProjectFile {
  const { value, issues } = parseYaml(path, text);

  const empty: ParsedProjectFile = {
    projectName: "",
    team: "",
    squads: [],
    todayRaw: "",
    calendar: "calendar-days",
    spineTasks: [],
    issues,
  };

  if (value === undefined) return empty;
  if (!isPlainObject(value)) {
    return {
      ...empty,
      issues: [
        {
          severity: "error",
          file: path,
          message:
            "project file is not a YAML mapping — squads, spine, and config all defaulted",
        },
      ],
    };
  }

  const obj = value as Record<string, unknown>;
  const out: ParsedProjectFile = { ...empty, issues: [...issues] };

  out.projectName = typeof obj.project === "string" ? obj.project : "";
  out.team = typeof obj.team === "string" ? obj.team : "";

  // config.schedule — calendar is fixed for v1; today is passed through raw and
  // resolved in merge.ts (never read the clock inside storage).
  if (isPlainObject(obj.schedule)) {
    const sched = obj.schedule as Record<string, unknown>;
    out.todayRaw = typeof sched.today === "string" ? sched.today : "";
  }

  // squads — the only per-file "fatal" shape check for project.yaml.
  if (obj.squads === undefined) {
    out.issues.push({
      severity: "error",
      file: path,
      message: "no `squads:` list in project file — squads defaulted to empty",
    });
  } else if (!Array.isArray(obj.squads)) {
    out.issues.push({
      severity: "error",
      file: path,
      message: "`squads` is not a list — squads defaulted to empty",
    });
  } else {
    obj.squads.forEach((raw, i) => {
      if (!isPlainObject(raw)) {
        out.issues.push({
          severity: "warning",
          file: path,
          message: `squad entry #${i + 1} is not a mapping — skipped`,
        });
        return;
      }
      const s = raw as Record<string, unknown>;
      if (typeof s.id !== "string" || s.id.length === 0) {
        out.issues.push({
          severity: "warning",
          file: path,
          message: `squad entry #${i + 1} has no valid \`id\` — skipped`,
        });
        return;
      }
      const squad: Squad = {
        id: s.id,
        name: typeof s.name === "string" && s.name.length > 0 ? s.name : s.id,
        color: typeof s.color === "string" ? s.color : "#888888",
      };
      if (typeof s.name !== "string" || s.name.length === 0) {
        out.issues.push({
          severity: "warning",
          file: path,
          taskId: s.id,
          field: "name",
          message: `squad "${s.id}" has no name — defaulted to its id`,
        });
      }
      if (typeof s.color !== "string") {
        out.issues.push({
          severity: "warning",
          file: path,
          taskId: s.id,
          field: "color",
          message: `squad "${s.id}" has no valid color — defaulted to #888888`,
        });
      }
      out.squads.push(squad);
    });
  }

  // The spine: reviews and gates are ordinary tasks that happen to live in the
  // project file. Collect their raw nodes for downstream validation.
  for (const key of ["reviews", "gates"] as const) {
    const node = obj[key];
    if (node === undefined) continue;
    if (!Array.isArray(node)) {
      out.issues.push({
        severity: "error",
        file: path,
        message: `\`${key}\` is not a list — those spine milestones were not loaded`,
      });
      continue;
    }
    out.spineTasks.push(...node);
  }

  return out;
}

// ── internals ────────────────────────────────────────────────────────────────

/**
 * Parse YAML without ever throwing. Returns the JS value (or `undefined` on a
 * fatal parse error) alongside any issues. We use `parseDocument` rather than
 * `parse` specifically so we can read the parser's error position and report it.
 */
function parseYaml(
  path: string,
  text: string,
): { value: unknown; issues: DataIssue[] } {
  let doc;
  try {
    doc = parseDocument(text);
  } catch (err) {
    // parseDocument collects errors rather than throwing, but guard anyway.
    return {
      value: undefined,
      issues: [
        {
          severity: "error",
          file: path,
          message: `could not parse YAML: ${errText(err)} — file skipped`,
        },
      ],
    };
  }

  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    const where = e.linePos
      ? ` at line ${e.linePos[0].line}, column ${e.linePos[0].col}`
      : "";
    return {
      value: undefined,
      issues: [
        {
          severity: "error",
          file: path,
          message: `could not parse YAML${where}: ${e.message.split("\n")[0]} — file skipped`,
        },
      ],
    };
  }

  return { value: doc.toJS(), issues: [] };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}
