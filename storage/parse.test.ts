import { describe, it, expect } from "vitest";
import { parseTaskFile, parseProjectFile } from "./parse-file";

// Per-file robustness: the two failures that happen BEFORE any per-task rule can
// run — the YAML won't parse, or the top-level shape is wrong. Neither may throw;
// each yields empty content + one plain-language error naming the file.

describe("parseTaskFile — squad file shape", () => {
  it("unparseable YAML → empty tasks + one error naming the file and the fault", () => {
    // Unclosed flow sequence: a hard syntax error the parser can locate.
    const bad = "tasks:\n  - id: a\n    dependsOn: [oops\n";
    const { tasks, issues } = parseTaskFile("data/subgroups/engines.yaml", bad);
    expect(tasks).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].file).toBe("data/subgroups/engines.yaml");
    expect(issues[0].message.toLowerCase()).toContain("yaml");
  });

  it("`tasks` missing → error, no tasks", () => {
    const { tasks, issues } = parseTaskFile(
      "data/subgroups/engines.yaml",
      "other: 1\n",
    );
    expect(tasks).toEqual([]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].message).toContain("tasks");
  });

  it("`tasks` not a list → error, no tasks", () => {
    const { tasks, issues } = parseTaskFile(
      "data/subgroups/engines.yaml",
      "tasks: 42\n",
    );
    expect(tasks).toEqual([]);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].message).toContain("not a list");
  });

  it("top-level is not a mapping (a bare list) → error, no tasks", () => {
    const { tasks, issues } = parseTaskFile(
      "data/subgroups/engines.yaml",
      "- 1\n- 2\n",
    );
    expect(tasks).toEqual([]);
    expect(issues[0].severity).toBe("error");
  });

  it("a well-formed file returns its raw task nodes with no issues", () => {
    const text =
      "tasks:\n  - id: engines.a\n    name: A\n    schedule: { mode: auto, duration: 3 }\n";
    const { tasks, issues } = parseTaskFile(
      "data/subgroups/engines.yaml",
      text,
    );
    expect(issues).toEqual([]);
    expect(tasks).toHaveLength(1);
    expect((tasks[0] as { id: string }).id).toBe("engines.a");
  });
});

describe("parseProjectFile — project file shape", () => {
  it("missing `squads` → error, squads default to []", () => {
    const { squads, issues } = parseProjectFile(
      "data/project.yaml",
      "project: X\nteam: Y\n",
    );
    expect(squads).toEqual([]);
    expect(
      issues.some(
        (i) => i.severity === "error" && i.message.includes("squads"),
      ),
    ).toBe(true);
  });

  it("`squads` not a list → error, squads default to []", () => {
    const { squads, issues } = parseProjectFile(
      "data/project.yaml",
      "squads: nope\n",
    );
    expect(squads).toEqual([]);
    expect(issues.some((i) => i.severity === "error")).toBe(true);
  });

  it("reads project name, team, squads, and reads reviews/gates as spine tasks", () => {
    const text = [
      'project: "P"',
      "team: T",
      "schedule: { calendar: calendar-days, today: auto }",
      "squads:",
      '  - { id: engines, name: Engines, color: "#D85A30" }',
      "reviews:",
      "  - id: review.pdr",
      "    milestone: true",
      "    gate: review",
      "gates:",
      "  - id: gate.first-flight",
      "    milestone: true",
      "    gate: test",
      "",
    ].join("\n");
    const p = parseProjectFile("data/project.yaml", text);
    expect(p.projectName).toBe("P");
    expect(p.team).toBe("T");
    expect(p.todayRaw).toBe("auto");
    expect(p.squads).toEqual([
      { id: "engines", name: "Engines", color: "#D85A30" },
    ]);
    expect(p.spineTasks).toHaveLength(2);
  });

  it("a malformed squad entry is dropped with a warning; the rest survive", () => {
    const text = [
      "squads:",
      '  - { id: engines, name: Engines, color: "#111" }',
      "  - name: NoId",
      "",
    ].join("\n");
    const p = parseProjectFile("data/project.yaml", text);
    expect(p.squads).toHaveLength(1);
    expect(p.issues.some((i) => i.severity === "warning")).toBe(true);
  });

  it("unparseable project file → everything defaulted, one error, never throws", () => {
    const p = parseProjectFile("data/project.yaml", "squads: [oops\n");
    expect(p.squads).toEqual([]);
    expect(p.issues[0].severity).toBe("error");
  });
});
