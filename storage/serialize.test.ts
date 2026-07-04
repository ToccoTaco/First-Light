import { describe, it, expect } from "vitest";
import { applyTaskEdit, addTask, removeTask } from "./serialize";
import { parseTaskFile } from "./parse-file";
import { validateTask } from "./validate";
import type { Task } from "../engine/types";

// The serializer's promise: editing ONE task leaves every other line — comments,
// key order, quoting — byte-for-byte identical. "Save = commit" only stays
// reviewable if a one-field change is a one-line diff.
//
// The fixture is written in yaml's canonical form (padded flow collections,
// single-space inline comments) so an untouched round-trip is byte-identical;
// see the caveat in serialize.ts. It still exercises comments-above-tasks,
// inline comments, and mixed quoting.

const FIXTURE = `# Owned by the Engines squad lead.
tasks:
  # Preliminary design phase
  - id: engines.prelim-design
    name: "Preliminary design" # quoted name
    schedule: { mode: auto, duration: 21 }
    status: not-started

  - id: engines.detailed-design
    name: Detailed design
    schedule: { mode: auto, duration: 28 }
    dependsOn: [ review.pdr ]
    status: not-started
`;

describe("applyTaskEdit", () => {
  it("changes only the target line; every other byte is identical", () => {
    const out = applyTaskEdit(FIXTURE, "engines.prelim-design", {
      schedule: { mode: "auto", duration: 30 },
    });
    // The ONLY change anywhere in the file is 21 → 30 on that one task's line.
    expect(out).toBe(FIXTURE.replace("duration: 21", "duration: 30"));
  });

  it("leaves the OTHER task and all comments untouched", () => {
    const out = applyTaskEdit(FIXTURE, "engines.prelim-design", {
      schedule: { mode: "auto", duration: 30 },
    });
    expect(out).toContain("# Owned by the Engines squad lead.");
    expect(out).toContain("# Preliminary design phase");
    expect(out).toContain('name: "Preliminary design" # quoted name');
    expect(out).toContain("schedule: { mode: auto, duration: 28 }"); // detailed-design unchanged
    expect(out).toContain("dependsOn: [ review.pdr ]");
  });

  it("setting a top-level scalar field replaces just that value", () => {
    const out = applyTaskEdit(FIXTURE, "engines.detailed-design", {
      status: "in-progress" as Task["status"],
    });
    expect(out).toContain("- id: engines.detailed-design");
    expect(out).toMatch(
      /id: engines\.detailed-design[\s\S]*status: in-progress/,
    );
    expect(out).toContain("status: not-started"); // prelim-design's status is untouched
  });

  it("an `undefined` value in the patch deletes that key", () => {
    const out = applyTaskEdit(FIXTURE, "engines.detailed-design", {
      status: undefined,
    });
    // detailed-design loses its status line; prelim-design keeps its own.
    const detailedBlock = out.slice(out.indexOf("engines.detailed-design"));
    expect(detailedBlock).not.toContain("status:");
    expect(out).toContain("status: not-started"); // prelim still has one
  });

  it("an unknown task id is a no-op (returns the text unchanged)", () => {
    expect(
      applyTaskEdit(FIXTURE, "engines.nope", {
        status: "done" as Task["status"],
      }),
    ).toBe(FIXTURE);
  });

  it("the edited text re-parses and re-validates clean", () => {
    const out = applyTaskEdit(FIXTURE, "engines.prelim-design", {
      schedule: { mode: "auto", duration: 30 },
    });
    const { tasks, issues } = parseTaskFile("data/subgroups/engines.yaml", out);
    expect(issues).toEqual([]);
    const problems = tasks.flatMap(
      (raw) =>
        validateTask(raw, "data/subgroups/engines.yaml", "engines").issues,
    );
    expect(problems).toEqual([]);
    const prelim = tasks
      .map((raw) => validateTask(raw, "x", "engines").task)
      .find((t) => t?.id === "engines.prelim-design");
    expect(prelim?.schedule).toEqual({ mode: "auto", duration: 30 });
  });
});

describe("addTask", () => {
  it("appends a new task without touching any existing line", () => {
    const task: Task = {
      id: "engines.new",
      name: "New task",
      schedule: { mode: "auto", duration: 5 },
    };
    const out = addTask(FIXTURE, task);
    expect(out.startsWith(FIXTURE)).toBe(true); // every original byte preserved, in place
    expect(out).toContain("id: engines.new");
  });

  it("creates a `tasks:` list when the file has none", () => {
    const out = addTask("# empty file\n", {
      id: "engines.a",
      name: "A",
      schedule: { mode: "auto", duration: 1 },
    });
    const { tasks } = parseTaskFile("x.yaml", out);
    expect((tasks[0] as { id: string }).id).toBe("engines.a");
  });
});

describe("removeTask", () => {
  it("removes exactly the named task and keeps the rest", () => {
    const out = removeTask(FIXTURE, "engines.prelim-design");
    expect(out).not.toContain("engines.prelim-design");
    expect(out).toContain("engines.detailed-design");
    expect(out).toContain("# Owned by the Engines squad lead."); // head comment survives
  });

  it("an unknown task id is a no-op", () => {
    expect(removeTask(FIXTURE, "engines.nope")).toBe(FIXTURE);
  });

  it("the file after a remove still parses clean", () => {
    const out = removeTask(FIXTURE, "engines.prelim-design");
    const { tasks, issues } = parseTaskFile("x.yaml", out);
    expect(issues).toEqual([]);
    expect(tasks).toHaveLength(1);
  });
});
