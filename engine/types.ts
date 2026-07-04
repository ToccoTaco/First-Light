// engine/types.ts — the §6.1 input/output contract for the pure scheduling core.
// This file declares types ONLY. No logic, no imports. Nothing about the DOM,
// git, or storage may ever leak in here.

export type ISODate = string; // "2026-02-14"
export type Status = "not-started" | "in-progress" | "blocked" | "done";

export interface Task {
  id: string; // namespaced, globally unique, e.g. "engines.injector-test"
  name: string;
  parent?: string; // having children makes a task a "summary" — never declared by hand
  milestone?: boolean; // zero duration
  gate?: "review" | "test"; // a milestone that fans in across squads
  schedule:
    | { mode: "auto"; duration: number }
    | { mode: "pinned"; start: ISODate; duration?: number };
  dependsOn?: (string | { task: string; type?: "FS" | "SS"; lag?: number })[];
  deadline?: { date: ISODate; hard: boolean };
  status?: Status;
  percent?: number; // optional
  confidence?: "firm" | "estimate" | "guess"; // pass-through, never affects scheduling math
}

export interface Config {
  calendar: "calendar-days";
  today: ISODate;
}

export interface ScheduleResult {
  tasks: Record<
    string,
    {
      earliestStart: ISODate;
      earliestFinish: ISODate;
      latestStart: ISODate;
      latestFinish: ISODate;
      slack: number; // days this task can slip before it becomes critical
      critical: boolean; // slack === 0
      // Approved contract extension (Phase 1): progress metadata carried through
      // so the UI needn't re-read the input. Leaves echo their inputs; summaries
      // carry rolled-up values. None of these ever affect the scheduling math.
      status: Status;
      percent: number;
      confidence?: "firm" | "estimate" | "guess";
      summary: boolean;
    }
  >;
  criticalPath: string[]; // ordered ids
  projectFinish: ISODate; // computed end of the whole graph
  conflicts: Conflict[];
}

export type Conflict =
  | { kind: "cycle"; tasks: string[] }
  | {
      kind: "hard-deadline-miss";
      task: string;
      deadline: ISODate;
      overrunDays: number;
    }
  | {
      kind: "pin-conflict";
      task: string;
      pinnedStart: ISODate;
      earliestPossible: ISODate;
    }
  | { kind: "missing-dependency"; task: string; missing: string };

// Phase 1 will add: export function computeSchedule(tasks: Task[], config: Config): ScheduleResult;
