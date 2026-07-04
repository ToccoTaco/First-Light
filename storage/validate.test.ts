import { describe, it, expect } from "vitest";
import { computeSchedule } from "../engine";
import {
  validateTask,
  validateGraph,
  isValidISODate,
  type LocatedTask,
} from "./validate";
import type { Task } from "../engine/types";

// Every rule in the brief's "Validation rules" section gets a focused test here,
// asserting BOTH the salvage behaviour (what survived) AND the issue raised
// (severity, file, taskId, and a message that names the id/field).

const FILE = "data/subgroups/engines.yaml";

/** Validate one raw node as if it came from the engines squad file. */
function vt(raw: unknown, namespace: string | undefined = "engines") {
  return validateTask(raw, FILE, namespace);
}

/** A minimal valid task we can spread + break one field at a time. */
function ok(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "engines.a",
    name: "A",
    schedule: { mode: "auto", duration: 5 },
    ...over,
  };
}

describe("per-task structural rules (drop the task)", () => {
  it("id missing → dropped with an error on the `id` field", () => {
    const { task, issues } = vt({
      name: "x",
      schedule: { mode: "auto", duration: 1 },
    });
    expect(task).toBeUndefined();
    expect(issues[0]).toMatchObject({
      severity: "error",
      file: FILE,
      field: "id",
    });
  });

  it("id empty string → dropped", () => {
    expect(vt(ok({ id: "" })).task).toBeUndefined();
  });

  it("id non-string → dropped", () => {
    expect(vt(ok({ id: 42 })).task).toBeUndefined();
  });

  it("schedule missing on a normal task → dropped with an error", () => {
    const { task, issues } = vt({ id: "engines.a", name: "A" });
    expect(task).toBeUndefined();
    expect(issues[0]).toMatchObject({
      severity: "error",
      taskId: "engines.a",
      field: "schedule",
    });
  });

  it("schedule missing on a MILESTONE → kept, defaulted to auto/0, no issue", () => {
    // No namespace (project-file style) — the spine lives in project.yaml.
    const { task, issues } = validateTask(
      { id: "review.pdr", name: "PDR", milestone: true, gate: "review" },
      FILE,
    );
    expect(task?.schedule).toEqual({ mode: "auto", duration: 0 });
    expect(issues).toEqual([]);
  });

  it("schedule.mode neither auto nor pinned → dropped", () => {
    const { task, issues } = vt(
      ok({ schedule: { mode: "sometime", duration: 5 } }),
    );
    expect(task).toBeUndefined();
    expect(issues[0]).toMatchObject({
      field: "schedule.mode",
      severity: "error",
    });
  });

  it("auto without a finite duration ≥ 0 → dropped", () => {
    expect(vt(ok({ schedule: { mode: "auto" } })).task).toBeUndefined();
  });

  it("duration negative → dropped", () => {
    const { task, issues } = vt(
      ok({ schedule: { mode: "auto", duration: -3 } }),
    );
    expect(task).toBeUndefined();
    expect(issues[0].field).toBe("schedule.duration");
  });

  it("duration non-number (NaN-ish string) → dropped", () => {
    expect(
      vt(ok({ schedule: { mode: "auto", duration: "soon" } })).task,
    ).toBeUndefined();
  });

  it("pinned without a valid start → dropped", () => {
    const { task, issues } = vt(ok({ schedule: { mode: "pinned" } }));
    expect(task).toBeUndefined();
    expect(issues[0].field).toBe("schedule.start");
  });

  it("pinned with an impossible calendar date (2026-02-30) → dropped", () => {
    expect(
      vt(ok({ schedule: { mode: "pinned", start: "2026-02-30" } })).task,
    ).toBeUndefined();
  });

  it("pinned with a real date is kept", () => {
    expect(
      vt(ok({ schedule: { mode: "pinned", start: "2026-03-01" } })).task
        ?.schedule,
    ).toEqual({
      mode: "pinned",
      start: "2026-03-01",
    });
  });
});

describe("per-field rules (keep the task, fix the field)", () => {
  it("name missing → warning, defaulted to the id", () => {
    const { task, issues } = vt({
      id: "engines.a",
      schedule: { mode: "auto", duration: 5 },
    });
    expect(task?.name).toBe("engines.a");
    expect(issues[0]).toMatchObject({
      severity: "warning",
      field: "name",
      taskId: "engines.a",
    });
  });

  it("dependsOn: malformed entries dropped, valid ones kept, each with an error", () => {
    const { task, issues } = vt(
      ok({
        dependsOn: [
          "engines.good", // kept
          { nope: 1 }, // object without `task` → dropped
          { task: "engines.x", type: "XX" }, // bad type → dropped
          { task: "engines.y", lag: "two" }, // bad lag → dropped
          { task: "engines.z", type: "SS", lag: 2 }, // kept
        ],
      }),
    );
    expect(task?.dependsOn).toEqual([
      "engines.good",
      { task: "engines.z", type: "SS", lag: 2 },
    ]);
    const depErrors = issues.filter(
      (i) => i.field === "dependsOn" && i.severity === "error",
    );
    expect(depErrors).toHaveLength(3);
  });

  it("dependsOn not a list → warning, field dropped", () => {
    const { task, issues } = vt(ok({ dependsOn: "engines.x" }));
    expect(task?.dependsOn).toBeUndefined();
    expect(issues[0]).toMatchObject({
      severity: "warning",
      field: "dependsOn",
    });
  });

  it("status not one of the four → warning, treated as unset", () => {
    const { task, issues } = vt(ok({ status: "waiting" }));
    expect(task?.status).toBeUndefined();
    expect(issues[0]).toMatchObject({ severity: "warning", field: "status" });
  });

  it("confidence invalid → warning, field dropped", () => {
    const { task, issues } = vt(ok({ confidence: "maybe" }));
    expect(task?.confidence).toBeUndefined();
    expect(issues[0]).toMatchObject({
      severity: "warning",
      field: "confidence",
    });
  });

  it("percent out of range → warning, field dropped", () => {
    expect(vt(ok({ percent: 140 })).task?.percent).toBeUndefined();
    expect(vt(ok({ percent: 140 })).issues[0]).toMatchObject({
      severity: "warning",
      field: "percent",
    });
  });

  it("percent non-number → warning, field dropped", () => {
    expect(vt(ok({ percent: "half" })).task?.percent).toBeUndefined();
  });

  it("deadline with an invalid date → warning, field dropped", () => {
    const { task, issues } = vt(
      ok({ deadline: { date: "2026-13-40", hard: true } }),
    );
    expect(task?.deadline).toBeUndefined();
    expect(issues[0]).toMatchObject({ severity: "warning", field: "deadline" });
  });

  it("deadline with non-boolean `hard` → warning, field dropped", () => {
    expect(
      vt(ok({ deadline: { date: "2026-03-01", hard: "yes" } })).task?.deadline,
    ).toBeUndefined();
  });

  it("a valid deadline is kept", () => {
    expect(
      vt(ok({ deadline: { date: "2026-03-01", hard: true } })).task?.deadline,
    ).toEqual({
      date: "2026-03-01",
      hard: true,
    });
  });

  it("milestone non-boolean → warning, field dropped", () => {
    const { task, issues } = vt(ok({ milestone: "yes" }));
    expect(task?.milestone).toBeUndefined();
    expect(issues[0]).toMatchObject({
      severity: "warning",
      field: "milestone",
    });
  });

  it("gate not review/test → warning, field dropped", () => {
    const { task, issues } = vt(ok({ gate: "checkpoint" }));
    expect(task?.gate).toBeUndefined();
    expect(issues[0]).toMatchObject({ severity: "warning", field: "gate" });
  });

  it("squad-file id not namespaced to its squad → warning only, task kept", () => {
    const { task, issues } = vt(ok({ id: "fluids.a" }), "engines");
    expect(task?.id).toBe("fluids.a");
    expect(issues[0]).toMatchObject({ severity: "warning", field: "id" });
    expect(issues[0].message).toContain("engines.");
  });
});

describe("isValidISODate", () => {
  it("accepts real dates and rejects impossible or malformed ones", () => {
    expect(isValidISODate("2026-02-28")).toBe(true);
    expect(isValidISODate("2026-02-30")).toBe(false);
    expect(isValidISODate("2026-13-01")).toBe(false);
    expect(isValidISODate("2026-2-1")).toBe(false); // needs zero-padding
    expect(isValidISODate("not-a-date")).toBe(false);
    expect(isValidISODate(20260201)).toBe(false);
  });
});

// ── graph-level rules (after merge, before the engine) ─────────────────────────

/** Wrap validated Tasks with a source file for validateGraph. */
function loc(tasks: Task[], file = FILE): LocatedTask[] {
  return tasks.map((task) => ({ task, file }));
}

function leaf(id: string, over: Partial<Task> = {}): Task {
  return { id, name: id, schedule: { mode: "auto", duration: 3 }, ...over };
}

describe("graph-level rules", () => {
  it("duplicate id across files → keep the first, drop later, error naming BOTH files", () => {
    const a = { task: leaf("engines.a"), file: "data/subgroups/engines.yaml" };
    const dup = {
      task: leaf("engines.a", { name: "second" }),
      file: "data/subgroups/fluids.yaml",
    };
    const { tasks, issues } = validateGraph([a, dup]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe("engines.a"); // the FIRST one won
    const err = issues.find(
      (i) => i.severity === "error" && i.taskId === "engines.a",
    );
    expect(err?.message).toContain("data/subgroups/engines.yaml");
    expect(err?.message).toContain("data/subgroups/fluids.yaml");
  });

  it("parent === own id (self-loop) → drop parent, exact error message", () => {
    const { tasks, issues } = validateGraph(
      loc([leaf("engines.x", { parent: "engines.x" })]),
    );
    expect(tasks[0].parent).toBeUndefined();
    expect(issues[0]).toMatchObject({
      severity: "error",
      taskId: "engines.x",
      field: "parent",
    });
    expect(issues[0].message).toBe(
      "engines.x: parent refers to itself — parent link removed",
    );
  });

  it("parent names a missing id → warning, task kept as a root", () => {
    const { tasks, issues } = validateGraph(
      loc([leaf("engines.x", { parent: "engines.ghost" })]),
    );
    expect(tasks[0].parent).toBeUndefined();
    expect(issues[0]).toMatchObject({
      severity: "warning",
      taskId: "engines.x",
      field: "parent",
    });
  });

  it("2-cycle → parent dropped from both, one error listing the loop", () => {
    const { tasks, issues } = validateGraph(
      loc([
        leaf("engines.a", { parent: "engines.b" }),
        leaf("engines.b", { parent: "engines.a" }),
      ]),
    );
    expect(tasks.every((t) => t.parent === undefined)).toBe(true);
    const err = issues.find(
      (i) => i.field === "parent" && i.severity === "error",
    );
    expect(err?.message).toContain("engines.a");
    expect(err?.message).toContain("engines.b");
  });

  it("3-cycle → parent dropped from all three, chain listed in order", () => {
    const { tasks, issues } = validateGraph(
      loc([
        leaf("engines.a", { parent: "engines.b" }),
        leaf("engines.b", { parent: "engines.c" }),
        leaf("engines.c", { parent: "engines.a" }),
      ]),
    );
    expect(tasks.every((t) => t.parent === undefined)).toBe(true);
    const err = issues.find(
      (i) => i.field === "parent" && i.severity === "error",
    )!;
    expect(err.message).toContain(
      "engines.a → engines.b → engines.c → engines.a",
    );
    expect(err.message).toContain("removed");
  });

  it("cycle with a non-cycle child hanging off it → child keeps its parent and resolves", () => {
    const input = loc([
      leaf("engines.a", { parent: "engines.b" }),
      leaf("engines.b", { parent: "engines.c" }),
      leaf("engines.c", { parent: "engines.a" }),
      leaf("engines.child", { parent: "engines.a" }), // hangs off the loop, not part of it
    ]);
    const { tasks } = validateGraph(input);
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
    expect(byId["engines.a"].parent).toBeUndefined();
    expect(byId["engines.b"].parent).toBeUndefined();
    expect(byId["engines.c"].parent).toBeUndefined();
    expect(byId["engines.child"].parent).toBe("engines.a"); // preserved

    // HANG-GUARD: the engine assumes `parent` is a forest. After we break the
    // cycle the result must feed computeSchedule without looping forever.
    const result = computeSchedule(tasks, {
      calendar: "calendar-days",
      today: "2026-01-01",
    });
    expect(result.projectFinish).toBeTruthy();
    expect(result.tasks["engines.a"].summary).toBe(true); // now a valid summary of its child
  });
});
