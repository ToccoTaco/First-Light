import { describe, it, expect } from "vitest";
import { applyTaskEdit, addTask, removeTask } from "./serialize";
import { parseTaskFile, parseProjectFile } from "./parse-file";
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

// ── the sanctioned storage extension: spine-file (reviews:/gates:) edits ──────────
//
// project.yaml holds the spine in `reviews:` and `gates:` lists, not `tasks:`.
// applyTaskEdit/removeTask locate a task across all three, so the full editor can
// edit a review's dependsOn / status / pinned date with the same comment-
// preserving, minimal-diff guarantee. This fixture is project.yaml-shaped.

const SPINE_FIXTURE = `# project.yaml — the team lead owns this file.
project: "First Light"

squads:
  - { id: engines, name: Engines, color: "#D85A30" }
  - { id: fluids, name: Fluids, color: "#378ADD" }

reviews:
  # Preliminary Design Review
  - id: review.pdr
    name: "Preliminary Design Review (PDR)"
    milestone: true
    gate: review
    dependsOn: [ engines.prelim-design, fluids.prelim-design ]

  - id: review.cdr
    name: "Critical Design Review (CDR)"
    milestone: true
    gate: review
    dependsOn: [ review.pdr ]

gates:
  - id: gate.engine-hotfire
    name: "First engine hotfire"
    milestone: true
    gate: test
    dependsOn: [ review.pdr ]
`;

describe("applyTaskEdit on spine lists (reviews:/gates:)", () => {
  it("edits a review's dependsOn, leaving every other line byte-identical", () => {
    const out = applyTaskEdit(SPINE_FIXTURE, "review.pdr", {
      dependsOn: ["engines.prelim-design", "fluids.prelim-design", "structures.prelim-design"],
    });
    expect(out).toBe(
      SPINE_FIXTURE.replace(
        "dependsOn: [ engines.prelim-design, fluids.prelim-design ]",
        "dependsOn: [ engines.prelim-design, fluids.prelim-design, structures.prelim-design ]",
      ),
    );
    // comments + the other spine items are untouched.
    expect(out).toContain("# Preliminary Design Review");
    expect(out).toContain('name: "Critical Design Review (CDR)"');
  });

  it("adds a status field to a review without disturbing its neighbours", () => {
    const out = applyTaskEdit(SPINE_FIXTURE, "review.cdr", {
      status: "in-progress" as Task["status"],
    });
    expect(out).toMatch(/id: review\.cdr[\s\S]*status: in-progress/);
    // The gate below and the review above keep their exact text.
    expect(out).toContain("- id: gate.engine-hotfire");
    expect(out).toContain("dependsOn: [ review.pdr ]");
  });

  it("pins a review to a real date by writing its schedule map", () => {
    const out = applyTaskEdit(SPINE_FIXTURE, "review.pdr", {
      schedule: { mode: "pinned", start: "2026-11-01" } as Task["schedule"],
    });
    expect(out).toMatch(
      /id: review\.pdr[\s\S]*schedule:[\s\S]*mode: pinned[\s\S]*start: 2026-11-01/,
    );
    const { spineTasks, issues } = parseProjectFile("data/project.yaml", out);
    expect(issues).toEqual([]);
    const pdr = spineTasks
      .map((raw) => validateTask(raw, "data/project.yaml").task)
      .find((t) => t?.id === "review.pdr");
    expect(pdr?.schedule).toEqual({ mode: "pinned", start: "2026-11-01" });
  });

  it("edits a gate in the gates: list", () => {
    const out = applyTaskEdit(SPINE_FIXTURE, "gate.engine-hotfire", {
      status: "not-started" as Task["status"],
    });
    expect(out).toMatch(/id: gate\.engine-hotfire[\s\S]*status: not-started/);
  });

  it("an undefined value clears a spine key (undefined-deletes)", () => {
    // First set a status, then clear it — the key must vanish from that block.
    const withStatus = applyTaskEdit(SPINE_FIXTURE, "review.cdr", {
      status: "done" as Task["status"],
    });
    expect(withStatus).toContain("status: done");
    const cleared = applyTaskEdit(withStatus, "review.cdr", { status: undefined });
    const cdrBlock = cleared.slice(
      cleared.indexOf("review.cdr"),
      cleared.indexOf("gates:"),
    );
    expect(cdrBlock).not.toContain("status:");
  });
});

describe("removeTask on spine lists", () => {
  it("removes a gate from the gates: list, keeping the reviews intact", () => {
    const out = removeTask(SPINE_FIXTURE, "gate.engine-hotfire");
    expect(out).not.toContain("gate.engine-hotfire");
    expect(out).toContain("id: review.pdr");
    expect(out).toContain("id: review.cdr");
    const { spineTasks, issues } = parseProjectFile("data/project.yaml", out);
    expect(issues).toEqual([]);
    expect(spineTasks).toHaveLength(2); // both reviews remain, the gate is gone
  });
});

describe("addTask on spine lists (reviews:/gates: routing)", () => {
  it("routes a new review into reviews:, leaving gates: and every other line intact", () => {
    const review: Task = {
      id: "review.mrr",
      name: "Manufacturing Readiness Review (MRR)",
      milestone: true,
      gate: "review",
      schedule: { mode: "auto", duration: 0 },
      status: "not-started",
    };
    const out = addTask(SPINE_FIXTURE, review);
    // Original bytes preserved; the new review appended under reviews:, before gates:.
    expect(out).toContain("# Preliminary Design Review");
    expect(out).toContain('name: "Critical Design Review (CDR)"');
    expect(out.indexOf("id: review.mrr")).toBeGreaterThan(
      out.indexOf("id: review.cdr"),
    );
    expect(out.indexOf("id: review.mrr")).toBeLessThan(out.indexOf("gates:"));
    const { spineTasks, issues } = parseProjectFile("data/project.yaml", out);
    expect(issues).toEqual([]);
    const mrr = spineTasks
      .map((raw) => validateTask(raw, "data/project.yaml").task)
      .find((t) => t?.id === "review.mrr");
    expect(mrr?.gate).toBe("review");
    expect(mrr?.milestone).toBe(true);
  });

  it("routes a new test gate into gates:", () => {
    const gate: Task = {
      id: "gate.first-flight",
      name: "First flight",
      milestone: true,
      gate: "test",
      schedule: { mode: "auto", duration: 0 },
      status: "not-started",
    };
    const out = addTask(SPINE_FIXTURE, gate);
    expect(out.indexOf("id: gate.first-flight")).toBeGreaterThan(
      out.indexOf("id: gate.engine-hotfire"),
    );
    const { spineTasks, issues } = parseProjectFile("data/project.yaml", out);
    expect(issues).toEqual([]);
    expect(spineTasks.some((t) => (t as { id: string }).id === "gate.first-flight")).toBe(true);
  });

  it("creates the reviews: list when the file has none", () => {
    const bare = `# project.yaml\nproject: "Fresh"\n`;
    const out = addTask(bare, {
      id: "review.pdr",
      name: "PDR",
      milestone: true,
      gate: "review",
      schedule: { mode: "auto", duration: 0 },
    });
    expect(out).toContain("reviews:");
    expect(out).toContain("id: review.pdr");
  });
});
