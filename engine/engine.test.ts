import { describe, it, expect } from "vitest";
import { computeSchedule } from "./index";
import type { Task, Config } from "./index";

// The eleven §6.3 acceptance tests, implemented faithfully — same inputs, same
// expected values. This suite IS the engine's contract (§2.2, §6.3). Extra
// edge-case tests live at the bottom, clearly separated.

const CONFIG: Config = { calendar: "calendar-days", today: "2026-01-01" };

/** Strip the pass-through decoration so date output can be compared alone. */
function dateShape(r: ReturnType<typeof computeSchedule>) {
  const out: Record<string, unknown> = {};
  for (const [id, t] of Object.entries(r.tasks)) {
    out[id] = {
      earliestStart: t.earliestStart,
      earliestFinish: t.earliestFinish,
      latestStart: t.latestStart,
      latestFinish: t.latestFinish,
      slack: t.slack,
      critical: t.critical,
    };
  }
  return {
    tasks: out,
    criticalPath: r.criticalPath,
    projectFinish: r.projectFinish,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe("§6.3 engine acceptance suite", () => {
  it("TEST 1 — simple finish-to-start chain", () => {
    const tasks: Task[] = [
      { id: "A", name: "A", schedule: { mode: "auto", duration: 5 } },
      {
        id: "B",
        name: "B",
        schedule: { mode: "auto", duration: 3 },
        dependsOn: ["A"],
      },
      {
        id: "C",
        name: "C",
        schedule: { mode: "auto", duration: 2 },
        dependsOn: ["B"],
      },
    ];
    const r = computeSchedule(tasks, CONFIG);

    expect(r.tasks.A.earliestStart).toBe("2026-01-01");
    expect(r.tasks.A.earliestFinish).toBe("2026-01-06");
    expect(r.tasks.B.earliestStart).toBe("2026-01-06");
    expect(r.tasks.B.earliestFinish).toBe("2026-01-09");
    expect(r.tasks.C.earliestStart).toBe("2026-01-09");
    expect(r.tasks.C.earliestFinish).toBe("2026-01-11");

    expect(r.projectFinish).toBe("2026-01-11");
    expect(r.criticalPath).toEqual(["A", "B", "C"]);
    expect(r.tasks.A.slack).toBe(0);
    expect(r.tasks.B.slack).toBe(0);
    expect(r.tasks.C.slack).toBe(0);
    expect(r.conflicts).toEqual([]);
  });

  it("TEST 2 — parallel branch produces slack", () => {
    // A→C directly, and A→B→C. C depends on both A and B.
    const tasks: Task[] = [
      { id: "A", name: "A", schedule: { mode: "auto", duration: 5 } },
      {
        id: "B",
        name: "B",
        schedule: { mode: "auto", duration: 2 },
        dependsOn: ["A"],
      },
      {
        id: "C",
        name: "C",
        schedule: { mode: "auto", duration: 2 },
        dependsOn: ["A", "B"],
      },
    ];
    const r = computeSchedule(tasks, CONFIG);

    // A→B→C is the longer path, so B is critical.
    expect(r.tasks.B.critical).toBe(true);
    expect(r.tasks.B.slack).toBe(0);
    expect(r.criticalPath).toEqual(["A", "B", "C"]);
    expect(r.projectFinish).toBe("2026-01-10");
    // The direct A→C branch carries float: C cannot start until B finishes
    // (Jan 8), two days after A finishes (Jan 6). That float lives on the edge,
    // not on any task, so all three tasks are on the critical path.
    expect(r.tasks.A.earliestFinish).toBe("2026-01-06"); // A done Jan 6…
    expect(r.tasks.C.earliestStart).toBe("2026-01-08"); // …but C waits for B.
    expect(r.conflicts).toEqual([]);
  });

  it("TEST 3 — summary rollup", () => {
    const tasks: Task[] = [
      { id: "P", name: "Parent", schedule: { mode: "auto", duration: 0 } },
      {
        id: "X",
        name: "X",
        parent: "P",
        schedule: { mode: "auto", duration: 4 },
      },
      {
        id: "Y",
        name: "Y",
        parent: "P",
        schedule: { mode: "auto", duration: 6 },
        dependsOn: ["X"],
      },
    ];
    const r = computeSchedule(tasks, CONFIG);

    expect(r.tasks.P.earliestStart).toBe(r.tasks.X.earliestStart); // P.ES = X.ES
    expect(r.tasks.P.earliestFinish).toBe(r.tasks.Y.earliestFinish); // P.EF = Y.EF
    expect(r.tasks.P.earliestStart).toBe("2026-01-01"); // spans Jan 1 …
    expect(r.tasks.P.earliestFinish).toBe("2026-01-11"); // … Jan 11
    expect(r.tasks.P.summary).toBe(true);
    // Weighted rollup: both children not-started ⇒ 0% ⇒ P = 0%.
    expect(r.tasks.P.percent).toBe(0);
    expect(r.conflicts).toEqual([]);
  });

  it("TEST 4 — unpinned, capability-driven (our default today)", () => {
    // A fans out to B and C; a gate fans them back in. Nothing pinned.
    const tasks: Task[] = [
      { id: "a", name: "a", schedule: { mode: "auto", duration: 5 } },
      {
        id: "b",
        name: "b",
        schedule: { mode: "auto", duration: 3 },
        dependsOn: ["a"],
      },
      {
        id: "c",
        name: "c",
        schedule: { mode: "auto", duration: 4 },
        dependsOn: ["a"],
      },
      {
        id: "g",
        name: "gate",
        milestone: true,
        schedule: { mode: "auto", duration: 0 },
        dependsOn: ["b", "c"],
      },
    ];
    const r = computeSchedule(tasks, CONFIG);

    // Backward pass anchors on projectFinish (no pins).
    expect(r.projectFinish).toBe("2026-01-10");
    expect(r.tasks.g.earliestStart).toBe("2026-01-10");
    // Valid critical path + relative slack still produced.
    expect(r.criticalPath).toEqual(["a", "c", "g"]);
    expect(r.tasks.a.slack).toBe(0);
    expect(r.tasks.c.slack).toBe(0);
    expect(r.tasks.b.slack).toBe(1); // shorter parallel branch → float
    expect(r.tasks.g.slack).toBe(0);
    expect(r.conflicts).toEqual([]);
  });

  it("TEST 5 — pinned date that can't be met", () => {
    // Chain finishing Mar 10 feeds a gate pinned + hard to Mar 1.
    const tasks: Task[] = [
      { id: "c1", name: "c1", schedule: { mode: "auto", duration: 40 } }, // Jan1→Feb10
      {
        id: "c2",
        name: "c2",
        schedule: { mode: "auto", duration: 28 },
        dependsOn: ["c1"],
      }, // →Mar10
      {
        id: "gate",
        name: "gate",
        milestone: true,
        gate: "review",
        schedule: { mode: "pinned", start: "2026-03-01" },
        deadline: { date: "2026-03-01", hard: true },
        dependsOn: ["c2"],
      },
    ];
    const r = computeSchedule(tasks, CONFIG);

    expect(r.conflicts).toEqual([
      {
        kind: "hard-deadline-miss",
        task: "gate",
        deadline: "2026-03-01",
        overrunDays: 9,
      },
    ]);
    // Dates NOT silently altered: the pin stays exactly where it was set.
    expect(r.tasks.gate.earliestStart).toBe("2026-03-01");
    expect(r.tasks.gate.earliestFinish).toBe("2026-03-01");
    expect(r.tasks.c2.earliestFinish).toBe("2026-03-10");
  });

  it("TEST 6 — dependency cycle", () => {
    const tasks: Task[] = [
      {
        id: "A",
        name: "A",
        schedule: { mode: "auto", duration: 3 },
        dependsOn: ["B"],
      },
      {
        id: "B",
        name: "B",
        schedule: { mode: "auto", duration: 3 },
        dependsOn: ["A"],
      },
    ];
    const r = computeSchedule(tasks, CONFIG);

    expect(r.conflicts).toEqual([{ kind: "cycle", tasks: ["A", "B"] }]);
    expect(r.tasks).toEqual({}); // no schedule emitted
    expect(r.criticalPath).toEqual([]);
    expect(r.projectFinish).toBe("2026-01-01");
  });

  it("TEST 7 — start-to-start dependency with lag", () => {
    const tasks: Task[] = [
      { id: "A", name: "A", schedule: { mode: "auto", duration: 5 } },
      {
        id: "B",
        name: "B",
        schedule: { mode: "auto", duration: 4 },
        dependsOn: [{ task: "A", type: "SS", lag: 2 }],
      },
    ];
    const r = computeSchedule(tasks, CONFIG);

    expect(r.tasks.A.earliestStart).toBe("2026-01-01");
    expect(r.tasks.A.earliestFinish).toBe("2026-01-06");
    // B tracks A's START not finish: B.ES = A.ES + 2 = Jan 3, B.EF = Jan 7.
    expect(r.tasks.B.earliestStart).toBe("2026-01-03");
    expect(r.tasks.B.earliestFinish).toBe("2026-01-07");
    expect(r.projectFinish).toBe("2026-01-07");
    expect(r.criticalPath).toEqual(["A", "B"]);
    expect(r.tasks.A.slack).toBe(0);
    expect(r.tasks.B.slack).toBe(0);
    expect(r.conflicts).toEqual([]);
  });

  it("TEST 8 — missing dependency id", () => {
    const tasks: Task[] = [
      { id: "a", name: "a", schedule: { mode: "auto", duration: 3 } },
      {
        id: "b",
        name: "b",
        schedule: { mode: "auto", duration: 2 },
        dependsOn: ["engines.ghost"],
      },
    ];
    const r = computeSchedule(tasks, CONFIG);

    expect(r.conflicts).toEqual([
      { kind: "missing-dependency", task: "b", missing: "engines.ghost" },
    ]);
    // The invalid edge is ignored, not fatal.
    expect(r.tasks.b.earliestStart).toBe("2026-01-01");
    expect(r.tasks.b.earliestFinish).toBe("2026-01-03");
    expect(r.tasks.a.earliestStart).toBe("2026-01-01");
    expect(r.tasks.a.earliestFinish).toBe("2026-01-04");
    expect(r.projectFinish).toBe("2026-01-04");
  });

  it("TEST 9 — gate with mixed feeders", () => {
    const tasks: Task[] = [
      {
        id: "eng.prelim",
        name: "eng",
        schedule: { mode: "auto", duration: 10 },
      },
      {
        id: "flu.prelim",
        name: "flu",
        schedule: { mode: "auto", duration: 14 },
      },
      {
        id: "str.prelim",
        name: "str",
        schedule: { mode: "auto", duration: 7 },
      },
      {
        id: "avi.prelim",
        name: "avi",
        schedule: { mode: "auto", duration: 12 },
      },
      {
        id: "review.pdr",
        name: "PDR",
        milestone: true,
        gate: "review",
        schedule: { mode: "auto", duration: 0 },
        dependsOn: ["eng.prelim", "flu.prelim", "str.prelim", "avi.prelim"],
      },
    ];
    const r = computeSchedule(tasks, CONFIG);

    // Gate reached at the LATEST feeder (fluids, Jan 15).
    expect(r.tasks["review.pdr"].earliestStart).toBe("2026-01-15");
    expect(r.tasks["review.pdr"].earliestFinish).toBe("2026-01-15");
    expect(r.projectFinish).toBe("2026-01-15");
    expect(r.criticalPath).toEqual(["flu.prelim", "review.pdr"]);
    // Slack per feeder = Jan 15 − its EF.
    expect(r.tasks["flu.prelim"].slack).toBe(0);
    expect(r.tasks["avi.prelim"].slack).toBe(2);
    expect(r.tasks["eng.prelim"].slack).toBe(4);
    expect(r.tasks["str.prelim"].slack).toBe(7);
    expect(r.conflicts).toEqual([]);
  });

  it("TEST 10 — a pin that IS met becomes the anchor and creates upstream slack", () => {
    const tasks: Task[] = [
      { id: "A", name: "A", schedule: { mode: "auto", duration: 3 } },
      {
        id: "M",
        name: "M",
        milestone: true,
        schedule: { mode: "pinned", start: "2026-01-10" },
        dependsOn: ["A"],
      },
    ];
    const r = computeSchedule(tasks, CONFIG);

    // Earliest possible for M is Jan 4; pinned Jan 10 ≥ Jan 4 → no conflict.
    expect(r.conflicts).toEqual([]);
    // Backward pass anchors on the pin: A.LS = Jan 7, A.slack = 6 (A not critical).
    expect(r.tasks.A.latestStart).toBe("2026-01-07");
    expect(r.tasks.A.slack).toBe(6);
    expect(r.tasks.A.critical).toBe(false);
    expect(r.projectFinish).toBe("2026-01-10");
    // The pinned milestone M is the critical constraint.
    expect(r.criticalPath).toContain("M");
    expect(r.criticalPath).not.toContain("A");
    expect(r.tasks.M.slack).toBe(0);
  });

  it("TEST 11 — status / percent / confidence are pass-through", () => {
    const base: Task[] = [
      { id: "A", name: "A", schedule: { mode: "auto", duration: 5 } },
      {
        id: "B",
        name: "B",
        schedule: { mode: "auto", duration: 3 },
        dependsOn: ["A"],
      },
      {
        id: "C",
        name: "C",
        schedule: { mode: "auto", duration: 2 },
        dependsOn: ["B"],
      },
    ];
    const decorated: Task[] = [
      { id: "A", name: "A", schedule: { mode: "auto", duration: 5 } },
      {
        id: "B",
        name: "B",
        schedule: { mode: "auto", duration: 3 },
        dependsOn: ["A"],
        status: "blocked",
        percent: 40,
        confidence: "guess",
      },
      {
        id: "C",
        name: "C",
        schedule: { mode: "auto", duration: 2 },
        dependsOn: ["B"],
      },
    ];
    const plain = computeSchedule(base, CONFIG);
    const r = computeSchedule(decorated, CONFIG);

    // Dates, criticalPath and slack are IDENTICAL to TEST 1's undecorated run.
    expect(dateShape(r)).toEqual(dateShape(plain));
    // The metadata is returned unchanged and blocked is easy to surface.
    expect(r.tasks.B.status).toBe("blocked");
    expect(r.tasks.B.percent).toBe(40);
    expect(r.tasks.B.confidence).toBe("guess");
    expect(r.conflicts).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Extra edge-case tests beyond §6.3 (guard the semantic decisions in the brief).
describe("engine — extra edge cases", () => {
  it("summary percent is duration-weighted over its leaves", () => {
    const tasks: Task[] = [
      { id: "P", name: "P", schedule: { mode: "auto", duration: 0 } },
      {
        id: "X",
        name: "X",
        parent: "P",
        schedule: { mode: "auto", duration: 4 },
        status: "in-progress",
        percent: 50,
      },
      {
        id: "Y",
        name: "Y",
        parent: "P",
        schedule: { mode: "auto", duration: 6 },
        status: "done",
        dependsOn: ["X"],
      },
    ];
    const r = computeSchedule(tasks, CONFIG);
    // (4·50 + 6·100) / 10 = 80. A "done" leaf reads as 100% regardless of input.
    expect(r.tasks.P.percent).toBe(80);
    expect(r.tasks.P.status).toBe("in-progress");
    expect(r.tasks.P.summary).toBe(true);
  });

  it("a blocked leaf makes its summary blocked", () => {
    const tasks: Task[] = [
      { id: "P", name: "P", schedule: { mode: "auto", duration: 0 } },
      {
        id: "X",
        name: "X",
        parent: "P",
        schedule: { mode: "auto", duration: 4 },
        status: "done",
      },
      {
        id: "Y",
        name: "Y",
        parent: "P",
        schedule: { mode: "auto", duration: 6 },
        status: "blocked",
      },
    ];
    const r = computeSchedule(tasks, CONFIG);
    expect(r.tasks.P.status).toBe("blocked");
  });

  it("multiple independent cycles are each reported", () => {
    const tasks: Task[] = [
      {
        id: "A",
        name: "A",
        schedule: { mode: "auto", duration: 1 },
        dependsOn: ["B"],
      },
      {
        id: "B",
        name: "B",
        schedule: { mode: "auto", duration: 1 },
        dependsOn: ["A"],
      },
      {
        id: "C",
        name: "C",
        schedule: { mode: "auto", duration: 1 },
        dependsOn: ["D"],
      },
      {
        id: "D",
        name: "D",
        schedule: { mode: "auto", duration: 1 },
        dependsOn: ["C"],
      },
    ];
    const r = computeSchedule(tasks, CONFIG);
    expect(r.conflicts).toEqual([
      { kind: "cycle", tasks: ["A", "B"] },
      { kind: "cycle", tasks: ["C", "D"] },
    ]);
    expect(r.tasks).toEqual({});
  });

  it("a pin in the past with no predecessors is legal (no conflict)", () => {
    const tasks: Task[] = [
      {
        id: "P",
        name: "P",
        schedule: { mode: "pinned", start: "2025-12-01", duration: 3 },
      },
    ];
    const r = computeSchedule(tasks, CONFIG);
    expect(r.conflicts).toEqual([]);
    expect(r.tasks.P.earliestStart).toBe("2025-12-01");
    expect(r.tasks.P.earliestFinish).toBe("2025-12-04");
  });

  it("depending on a summary means depending on all of its leaves", () => {
    // D depends on summary S, whose latest leaf finishes Jan 8 → D starts Jan 8.
    const tasks: Task[] = [
      { id: "S", name: "S", schedule: { mode: "auto", duration: 0 } },
      {
        id: "S.a",
        name: "Sa",
        parent: "S",
        schedule: { mode: "auto", duration: 4 },
      },
      {
        id: "S.b",
        name: "Sb",
        parent: "S",
        schedule: { mode: "auto", duration: 7 },
      },
      {
        id: "D",
        name: "D",
        schedule: { mode: "auto", duration: 2 },
        dependsOn: ["S"],
      },
    ];
    const r = computeSchedule(tasks, CONFIG);
    expect(r.tasks["S.b"].earliestFinish).toBe("2026-01-08");
    expect(r.tasks.D.earliestStart).toBe("2026-01-08");
    expect(r.tasks.D.earliestFinish).toBe("2026-01-10");
  });

  it("does not mutate its input tasks", () => {
    const tasks: Task[] = [
      { id: "A", name: "A", schedule: { mode: "auto", duration: 5 } },
      {
        id: "B",
        name: "B",
        schedule: { mode: "auto", duration: 3 },
        dependsOn: ["A"],
      },
    ];
    const snapshot = JSON.stringify(tasks);
    computeSchedule(tasks, CONFIG);
    expect(JSON.stringify(tasks)).toBe(snapshot);
  });
});
