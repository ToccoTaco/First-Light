import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { computeSchedule } from "../engine";
import { mergeProject, type SourceFile } from "./merge";

// merge.ts is the ONE gate to the engine. These tests exercise it end to end,
// including against the REAL repo data files — which doubles as a starter-data
// integrity check.

const NOW = "2026-07-04";

/** Load the real project + squad files, project first (file order = tie-breaker). */
function realFiles(): SourceFile[] {
  const paths = [
    "data/project.yaml",
    "data/subgroups/engines.yaml",
    "data/subgroups/fluids.yaml",
    "data/subgroups/structures.yaml",
    "data/subgroups/avionics.yaml",
  ];
  return paths.map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

describe("happy path — the real repo data files", () => {
  it("merges into one clean ProjectData with zero issues", () => {
    const data = mergeProject(realFiles(), NOW);
    expect(data.issues).toEqual([]); // starter-data integrity: nothing to salvage
    expect(data.projectName).toContain("First Liquid Rocket");
    expect(data.team).toBe("Notre Dame Experimental Propulsion");
    expect(data.squads.map((s) => s.id)).toEqual([
      "engines",
      "fluids",
      "structures",
      "avionics",
    ]);
  });

  it("has the right task count: 23 leaves + 5 reviews + 3 gates = 31", () => {
    const data = mergeProject(realFiles(), NOW);
    // 4 squads × 6/5/6/6 leaves = 23; plus the 8-node spine. Count what loads.
    const ids = new Set(data.tasks.map((t) => t.id));
    expect(ids.has("review.pdr")).toBe(true);
    expect(ids.has("gate.first-flight")).toBe(true);
    expect(ids.has("engines.chamber-ready")).toBe(true);
    expect(data.tasks).toHaveLength(31);
  });

  it("feeds computeSchedule cleanly — no cycles, no missing dependencies", () => {
    const data = mergeProject(realFiles(), NOW);
    const result = computeSchedule(data.tasks, data.config);
    expect(result.conflicts).toEqual([]);
    expect(result.projectFinish).toBeTruthy();
    expect(result.criticalPath.length).toBeGreaterThan(0);
  });
});

describe("config resolution — the clock is injected, never read", () => {
  it("`today: auto` resolves to the injected now", () => {
    const files: SourceFile[] = [
      {
        path: "data/project.yaml",
        text: "squads: []\nschedule: { calendar: calendar-days, today: auto }\n",
      },
    ];
    expect(mergeProject(files, NOW).config.today).toBe(NOW);
  });

  it("a literal `today` date is respected", () => {
    const files: SourceFile[] = [
      {
        path: "data/project.yaml",
        text: "squads: []\nschedule: { today: 2026-01-15 }\n",
      },
    ];
    expect(mergeProject(files, NOW).config.today).toBe("2026-01-15");
  });

  it("an invalid literal `today` → warning + fall back to now", () => {
    const files: SourceFile[] = [
      {
        path: "data/project.yaml",
        text: "squads: []\nschedule: { today: someday }\n",
      },
    ];
    const data = mergeProject(files, NOW);
    expect(data.config.today).toBe(NOW);
    expect(
      data.issues.some(
        (i) => i.field === "schedule.today" && i.severity === "warning",
      ),
    ).toBe(true);
  });
});

describe("merge behaviour", () => {
  it("is deterministic — identical input yields deeply-equal output", () => {
    const a = mergeProject(realFiles(), NOW);
    const b = mergeProject(realFiles(), NOW);
    expect(a).toEqual(b);
  });

  it("a broken squad file does not sink the rest of the project", () => {
    const files: SourceFile[] = [
      {
        path: "data/project.yaml",
        text: 'squads: [{ id: engines, name: E, color: "#111" }]\n',
      },
      { path: "data/subgroups/engines.yaml", text: "tasks: [oops\n" }, // unparseable
      {
        path: "data/subgroups/fluids.yaml",
        text: "tasks:\n  - id: fluids.a\n    name: A\n    schedule: { mode: auto, duration: 4 }\n",
      },
    ];
    const data = mergeProject(files, NOW);
    expect(data.tasks.map((t) => t.id)).toEqual(["fluids.a"]); // fluids still loaded
    expect(
      data.issues.some(
        (i) => i.severity === "error" && i.file.includes("engines"),
      ),
    ).toBe(true);
  });

  it("duplicate id across two squad files is reported and de-duplicated", () => {
    const files: SourceFile[] = [
      { path: "data/project.yaml", text: "squads: []\n" },
      {
        path: "data/subgroups/engines.yaml",
        text: "tasks:\n  - id: engines.a\n    name: first\n    schedule: { mode: auto, duration: 3 }\n",
      },
      {
        path: "data/subgroups/fluids.yaml",
        text: "tasks:\n  - id: engines.a\n    name: second\n    schedule: { mode: auto, duration: 9 }\n",
      },
    ];
    const data = mergeProject(files, NOW);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].name).toBe("first");
    expect(
      data.issues.some(
        (i) => i.taskId === "engines.a" && i.severity === "error",
      ),
    ).toBe(true);
  });
});
