import { describe, it, expect } from "vitest";
import { computeSchedule } from "../engine";
import type { Config, ScheduleResult, Task } from "../engine/types";
import type { Meta } from "../storage/meta";
import type { ProjectData, Squad } from "../storage/types";
import {
  baselineScheduleFromMeta,
  buildDashboard,
  computeBlocked,
  computeCountdown,
  computeCritical,
  computeRollups,
  computeSlippage,
  computeStaleness,
  dayDiff,
  type BaselineSchedule,
} from "./dashboard-model";

// The dashboard model is pure, so every test is: assemble a ProjectData, run the
// REAL engine over it, and assert the derived numbers. Baseline-dependent tests
// build a second (synthetic) schedule and diff against it. Nothing here touches
// git or the real meta.json (which changes) — fixtures only.

const NOW = "2026-01-01";

const SQUADS: Squad[] = [
  { id: "engines", name: "Engines", color: "#D85A30" },
  { id: "fluids", name: "Fluids", color: "#378ADD" },
  { id: "structures", name: "Structures", color: "#1D9E75" },
];

function project(tasks: Task[], squads: Squad[] = SQUADS, today = NOW): ProjectData {
  const config: Config = { calendar: "calendar-days", today };
  return { projectName: "P", team: "T", squads, tasks, config, issues: [] };
}

function scheduleOf(tasks: Task[], today = NOW): ScheduleResult {
  return computeSchedule(tasks, { calendar: "calendar-days", today });
}

const auto = (id: string, duration: number, extra: Partial<Task> = {}): Task => ({
  id,
  name: id,
  schedule: { mode: "auto", duration },
  ...extra,
});

const gate = (id: string, deps: string[], extra: Partial<Task> = {}): Task => ({
  id,
  name: id,
  milestone: true,
  gate: "test",
  schedule: { mode: "auto", duration: 0 },
  dependsOn: deps,
  ...extra,
});

function baselineFrom(tasks: Task[], today = NOW): BaselineSchedule {
  return {
    schedule: scheduleOf(tasks, today),
    tag: "baseline/2026-06-20",
    taggedAt: "2026-06-20T12:00:00-04:00",
  };
}

// ── dayDiff ───────────────────────────────────────────────────────────────────

describe("dayDiff", () => {
  it("counts whole calendar days, signed", () => {
    expect(dayDiff("2026-01-01", "2026-01-06")).toBe(5);
    expect(dayDiff("2026-01-06", "2026-01-01")).toBe(-5);
    expect(dayDiff("2026-01-01", "2026-01-01")).toBe(0);
    expect(dayDiff("2026-02-28", "2026-03-01")).toBe(1); // 2026 is not a leap year
  });
});

// ── countdown (deliverable 1) ─────────────────────────────────────────────────

describe("computeCountdown", () => {
  it("normal: days to the next upcoming gate", () => {
    const tasks = [auto("engines.a", 5), gate("gate.first-flight", ["engines.a"])];
    const c = computeCountdown(project(tasks), scheduleOf(tasks), NOW);
    expect(c).toEqual({
      kind: "countdown",
      days: 5, // a finishes Jan6, gate reached Jan6
      gateId: "gate.first-flight",
      gateName: "gate.first-flight",
      gateDateISO: "2026-01-06",
    });
  });

  it("gate today → T–0 DAYS", () => {
    const tasks = [
      gate("gate.now", [], { schedule: { mode: "pinned", start: NOW } }),
    ];
    const c = computeCountdown(project(tasks), scheduleOf(tasks), NOW);
    expect(c.kind).toBe("countdown");
    if (c.kind === "countdown") expect(c.days).toBe(0);
  });

  it("all gates in the past → all-passed", () => {
    const tasks = [
      gate("gate.old", [], {
        schedule: { mode: "pinned", start: "2025-12-01" },
      }),
    ];
    const c = computeCountdown(project(tasks), scheduleOf(tasks), NOW);
    expect(c.kind).toBe("all-passed");
  });

  it("tasks but no gates → no-gates (distinct from all-passed)", () => {
    const tasks = [auto("engines.a", 5)];
    const c = computeCountdown(project(tasks), scheduleOf(tasks), NOW);
    expect(c.kind).toBe("no-gates");
  });

  it("a fully empty project → no-gates", () => {
    const c = computeCountdown(project([]), scheduleOf([]), NOW);
    expect(c.kind).toBe("no-gates");
  });

  it("cycle blanks the schedule → no-schedule (hero yields)", () => {
    const tasks = [
      auto("engines.a", 5, { dependsOn: ["engines.b"] }),
      auto("engines.b", 5, { dependsOn: ["engines.a"] }),
    ];
    const sched = scheduleOf(tasks);
    expect(Object.keys(sched.tasks).length).toBe(0); // sanity: cycle → empty
    expect(computeCountdown(project(tasks), sched, NOW).kind).toBe("no-schedule");
  });
});

// ── rollups (deliverable 2) ───────────────────────────────────────────────────

describe("computeRollups", () => {
  const tasks = [
    auto("engines.e1", 10, { status: "in-progress", percent: 50 }),
    auto("engines.e2", 10, { status: "done" }), // done ⇒ 100 regardless of percent
    auto("fluids.f1", 20, { status: "not-started" }), // 0%
    // A milestone leaf: weight 0, so it never moves the weighted mean.
    { id: "fluids.f2", name: "m", milestone: true, status: "done", schedule: { mode: "auto", duration: 0 } } as Task,
  ];
  const r = computeRollups(project(tasks));

  it("done=100 and duration-weighting", () => {
    const eng = r.squads.find((s) => s.squadId === "engines")!;
    expect(eng.percent).toBeCloseTo(75); // (10*50 + 10*100)/20
    expect(eng.counts).toEqual({ done: 1, inProgress: 1, notStarted: 0, blocked: 0 });
  });

  it("milestone weighs 0 (does not move the mean) but still counts", () => {
    const flu = r.squads.find((s) => s.squadId === "fluids")!;
    expect(flu.percent).toBeCloseTo(0); // (20*0 + 0*100)/20 = 0
    expect(flu.counts).toEqual({ done: 1, inProgress: 0, notStarted: 1, blocked: 0 });
  });

  it("empty squad → 0% and zero counts", () => {
    const str = r.squads.find((s) => s.squadId === "structures")!;
    expect(str.percent).toBe(0);
    expect(str.counts).toEqual({ done: 0, inProgress: 0, notStarted: 0, blocked: 0 });
  });

  it("overall is duration-weighted across all squad leaves", () => {
    expect(r.overall.percent).toBeCloseTo(37.5); // (500+1000+0+0)/40
  });
});

// ── slippage (deliverable 3) ──────────────────────────────────────────────────

describe("computeSlippage", () => {
  it("later: first-flight moved out → later, magnitude in days", () => {
    const base = [auto("engines.a", 5), gate("gate.first-flight", ["engines.a"])];
    const cur = [auto("engines.a", 10), gate("gate.first-flight", ["engines.a"])];
    const s = computeSlippage(scheduleOf(cur), baselineFrom(base), project(cur));
    expect(s.kind).toBe("tracked");
    if (s.kind !== "tracked") return;
    expect(s.direction).toBe("later");
    expect(s.days).toBe(5);
    expect(s.metricLabel).toBe("Projected first flight");
    expect(s.baselineLabel).toBe("2026-06-20");
  });

  it("earlier: first-flight pulled in → earlier", () => {
    const base = [auto("engines.a", 10), gate("gate.first-flight", ["engines.a"])];
    const cur = [auto("engines.a", 5), gate("gate.first-flight", ["engines.a"])];
    const s = computeSlippage(scheduleOf(cur), baselineFrom(base), project(cur));
    if (s.kind !== "tracked") throw new Error("expected tracked");
    expect(s.direction).toBe("earlier");
    expect(s.days).toBe(5);
  });

  it("steady: identical → holding steady", () => {
    const t = [auto("engines.a", 7), gate("gate.first-flight", ["engines.a"])];
    const s = computeSlippage(scheduleOf(t), baselineFrom(t), project(t));
    if (s.kind !== "tracked") throw new Error("expected tracked");
    expect(s.direction).toBe("steady");
    expect(s.days).toBe(0);
  });

  it("no baseline → honest empty state", () => {
    const t = [auto("engines.a", 5)];
    expect(computeSlippage(scheduleOf(t), null, project(t)).kind).toBe("no-baseline");
  });

  it("missing first-flight → falls back to projectFinish", () => {
    // Neither schedule has gate.first-flight; the metric is the whole finish.
    const base = [auto("engines.a", 5)]; // finish Jan6
    const cur = [auto("engines.a", 9)]; // finish Jan10
    const s = computeSlippage(scheduleOf(cur), baselineFrom(base), project(cur));
    if (s.kind !== "tracked") throw new Error("expected tracked");
    expect(s.metricLabel).toBe("Projected finish");
    expect(s.direction).toBe("later");
    expect(s.days).toBe(4);
  });

  it("per-gate table: a gate absent from the baseline reports null delta", () => {
    const base = [auto("engines.a", 5), gate("gate.first-flight", ["engines.a"])];
    const cur = [
      auto("engines.a", 5),
      gate("gate.first-flight", ["engines.a"]),
      gate("gate.extra", ["engines.a"]), // not in the baseline
    ];
    const s = computeSlippage(scheduleOf(cur), baselineFrom(base), project(cur));
    if (s.kind !== "tracked") throw new Error("expected tracked");
    const extra = s.gateDeltas.find((g) => g.gateId === "gate.extra")!;
    expect(extra.baselineISO).toBeNull();
    expect(extra.deltaDays).toBeNull();
    expect(extra.currentISO).toBe("2026-01-06");
    const ff = s.gateDeltas.find((g) => g.gateId === "gate.first-flight")!;
    expect(ff.deltaDays).toBe(0);
  });
});

// ── critical summary (deliverable 4) ──────────────────────────────────────────

describe("computeCritical", () => {
  it("null when the schedule is blank (cycle)", () => {
    const tasks = [
      auto("a", 5, { dependsOn: ["b"] }),
      auto("b", 5, { dependsOn: ["a"] }),
    ];
    expect(computeCritical(scheduleOf(tasks), project(tasks))).toBeNull();
  });

  it("compacts a long chain to first · key gates · last (≤5)", () => {
    // A→B→C→D→E→F→G linear; C and E are gates. Whole chain is critical.
    const tasks: Task[] = [
      auto("a", 3),
      auto("b", 3, { dependsOn: ["a"] }),
      gate("c", ["b"]),
      auto("d", 3, { dependsOn: ["c"] }),
      gate("e", ["d"]),
      auto("f", 3, { dependsOn: ["e"] }),
      auto("g", 3, { dependsOn: ["f"] }),
    ];
    const c = computeCritical(scheduleOf(tasks), project(tasks))!;
    expect(c.taskCount).toBe(7);
    expect(c.chain.map((n) => n.id)).toEqual(["a", "c", "e", "g"]);
    expect(c.chain.find((n) => n.id === "c")!.isGate).toBe(true);
    expect(c.chain.find((n) => n.id === "a")!.isGate).toBe(false);
  });

  it("nearest branch = min slack off the thread", () => {
    // a(10)→M and b(3)→M: a drives M (critical); b carries 7 days of slack.
    const tasks = [
      auto("a", 10),
      auto("b", 3),
      gate("m", ["a", "b"]),
    ];
    const c = computeCritical(scheduleOf(tasks), project(tasks))!;
    expect(c.taskCount).toBe(2); // a + m
    expect(c.nearestSlackDays).toBe(7);
  });
});

// ── blocked list (deliverable 5) ──────────────────────────────────────────────

describe("computeBlocked", () => {
  it("finds the first downstream dependent and the days open", () => {
    const tasks = [
      auto("avionics.x", 5, { status: "blocked" }),
      auto("avionics.y", 4, { dependsOn: ["avionics.x"] }),
    ];
    const b = computeBlocked(project(tasks), scheduleOf(tasks), "2026-01-08");
    expect(b).toHaveLength(1);
    expect(b[0].name).toBe("avionics.x");
    expect(b[0].squadName).toBeNull(); // "avionics" not in SQUADS fixture
    expect(b[0].blocksName).toBe("avionics.y");
    expect(b[0].daysOpen).toBe(7); // Jan1 → Jan8
  });

  it("carries squad identity and null dependent when nothing waits", () => {
    const tasks = [auto("engines.x", 5, { status: "blocked" })];
    const b = computeBlocked(project(tasks), scheduleOf(tasks), NOW);
    expect(b[0].squadName).toBe("Engines");
    expect(b[0].squadColor).toBe("#D85A30");
    expect(b[0].blocksName).toBeNull();
  });

  it("nothing blocked → empty list", () => {
    const tasks = [auto("engines.x", 5, { status: "in-progress" })];
    expect(computeBlocked(project(tasks), scheduleOf(tasks), NOW)).toEqual([]);
  });
});

// ── staleness (deliverable 6) ─────────────────────────────────────────────────

describe("computeStaleness", () => {
  const meta: Meta = {
    generatedAt: "2026-07-20T10:00:00Z",
    staleness: {
      "data/project.yaml": "2026-07-18T09:00:00-04:00", // 2 days → fresh
      "data/subgroups/engines.yaml": "2026-07-01T09:00:00-04:00", // 19 days → warn
      "data/subgroups/fluids.yaml": "2026-06-10T09:00:00-04:00", // 40 days → stale
      "data/subgroups/structures.yaml": null, // never committed → stale, top
    },
    baseline: null,
  };

  it("day-count from generatedAt, stalest first, tiered, never-committed on top", () => {
    const s = computeStaleness(meta, SQUADS);
    expect(s.kind).toBe("present");
    if (s.kind !== "present") return;
    expect(s.rows.map((r) => r.label)).toEqual([
      "Structures", // null → top
      "Fluids", // 40
      "Engines", // 19
      "Project spine", // 2
    ]);
    expect(s.rows[1].daysAgo).toBe(40);
    expect(s.rows.map((r) => r.tier)).toEqual(["stale", "stale", "warn", "fresh"]);
  });

  it("missing meta → absent", () => {
    expect(computeStaleness(null, SQUADS).kind).toBe("absent");
  });
});

// ── meta → baseline-schedule glue (synthetic file fixture) ────────────────────

describe("baselineScheduleFromMeta", () => {
  const PROJECT = `project: "P"
team: "T"
schedule:
  calendar: calendar-days
  today: auto
squads:
  - { id: eng, name: Eng, color: "#111111" }
gates:
  - id: gate.first-flight
    name: "First flight"
    milestone: true
    gate: test
    dependsOn: [eng.work]
`;
  const ENG = `tasks:
  - id: eng.work
    name: "Work"
    schedule: { mode: auto, duration: 5 }
`;

  it("runs merge+compute over captured baseline files at the injected today", () => {
    const meta: Meta = {
      generatedAt: "2026-06-20T00:00:00Z",
      staleness: {},
      baseline: {
        tag: "baseline/2026-06-20",
        taggedAt: "2026-06-20T12:00:00-04:00",
        files: {
          "data/project.yaml": PROJECT,
          "data/subgroups/eng.yaml": ENG,
        },
      },
    };
    const b = baselineScheduleFromMeta(meta, NOW)!;
    expect(b.tag).toBe("baseline/2026-06-20");
    // eng.work Jan1→Jan6; first-flight gate reached Jan6.
    expect(b.schedule.tasks["gate.first-flight"].earliestFinish).toBe("2026-01-06");
  });

  it("no baseline in meta → null", () => {
    const meta: Meta = { generatedAt: "x", staleness: {}, baseline: null };
    expect(baselineScheduleFromMeta(meta, NOW)).toBeNull();
    expect(baselineScheduleFromMeta(null, NOW)).toBeNull();
  });
});

// ── the assembler wires all six pieces (smoke) ────────────────────────────────

describe("buildDashboard", () => {
  it("assembles every section from one project + schedule + meta", () => {
    const tasks = [
      auto("engines.a", 5, { status: "in-progress", percent: 40 }),
      gate("gate.first-flight", ["engines.a"]),
    ];
    const p = project(tasks);
    const sched = scheduleOf(tasks);
    const model = buildDashboard(p, sched, null, NOW);
    expect(model.countdown.kind).toBe("countdown");
    expect(model.rollups.overall.percent).toBeCloseTo(40);
    expect(model.slippage.kind).toBe("no-baseline");
    expect(model.critical).not.toBeNull();
    expect(model.blocked).toEqual([]);
    expect(model.staleness.kind).toBe("absent");
  });

  it("degrades gracefully on a fully empty project — no NaN, sensible empties", () => {
    const p = project([]);
    const sched = scheduleOf([]);
    const model = buildDashboard(p, sched, null, NOW);
    expect(model.countdown.kind).toBe("no-gates"); // quiet hero, no gold number
    expect(model.rollups.overall.percent).toBe(0); // 0, never NaN
    expect(Number.isNaN(model.rollups.overall.percent)).toBe(false);
    for (const s of model.rollups.squads) {
      expect(Number.isNaN(s.percent)).toBe(false);
      expect(s.percent).toBe(0);
    }
    expect(model.slippage.kind).toBe("no-baseline");
    expect(model.critical).toBeNull(); // no thread — Dashboard shows the calm copy
    expect(model.blocked).toEqual([]);
    expect(model.staleness.kind).toBe("absent");
  });
});
