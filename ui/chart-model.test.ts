import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { computeSchedule } from "../engine";
import type { Task, Config, ScheduleResult } from "../engine/types";
import { mergeProject, type SourceFile } from "../storage/merge";
import type { ProjectData, Squad } from "../storage/types";
import { buildChartModel, nextGateId, NEUTRAL_COLOR } from "./chart-model";

// buildChartModel is pure, so every test here is: assemble a ProjectData, run
// the real engine over it, and assert the resulting ChartModel. The DHTMLX
// adapter is deliberately untested (visual QA) — all testable chart decisions
// live in this file's subject.

const NOW = "2026-01-01";

const SQUADS: Squad[] = [
  { id: "engines", name: "Engines", color: "#D85A30" },
  { id: "fluids", name: "Fluids", color: "#378ADD" },
  { id: "structures", name: "Structures", color: "#1D9E75" },
  { id: "avionics", name: "Avionics", color: "#7F77DD" },
];

function project(tasks: Task[], squads: Squad[] = SQUADS, today = NOW): ProjectData {
  const config: Config = { calendar: "calendar-days", today };
  return { projectName: "P", team: "T", squads, tasks, config, issues: [] };
}

function modelOf(tasks: Task[], squads: Squad[] = SQUADS, today = NOW) {
  const p = project(tasks, squads, today);
  const schedule = computeSchedule(p.tasks, p.config);
  return { model: buildChartModel(p, schedule), schedule };
}

const auto = (id: string, duration: number, extra: Partial<Task> = {}): Task => ({
  id,
  name: id,
  schedule: { mode: "auto", duration },
  ...extra,
});

// ── real repo data ────────────────────────────────────────────────────────────

function realProject(): ProjectData {
  const paths = [
    "data/project.yaml",
    "data/subgroups/engines.yaml",
    "data/subgroups/fluids.yaml",
    "data/subgroups/structures.yaml",
    "data/subgroups/avionics.yaml",
  ];
  const files: SourceFile[] = paths.map((path) => ({
    path,
    text: readFileSync(path, "utf8"),
  }));
  return mergeProject(files, "2026-07-04");
}

describe("real repo data → ChartModel", () => {
  const p = realProject();
  const schedule = computeSchedule(p.tasks, p.config);
  const model = buildChartModel(p, schedule);

  it("has a schedule and puts the Mission spine group first", () => {
    expect(model.hasSchedule).toBe(true);
    expect(model.rows[0].kind).toBe("group");
    expect(model.rows[0].name).toBe("Mission spine");
    expect(model.rows[0].id.startsWith("group:")).toBe(true);
    expect(model.rows[0].squadColor).toBe(NEUTRAL_COLOR);
  });

  it("emits 31 task rows + 5 group rows = 36 rows", () => {
    const groups = model.rows.filter((r) => r.kind === "group");
    expect(groups.map((g) => g.name)).toEqual([
      "Mission spine",
      "Engines",
      "Fluids",
      "Structures",
      "Avionics",
    ]);
    expect(model.rows).toHaveLength(36);
  });

  it("renders all 8 spine gates as review/test diamonds under the spine group", () => {
    const spineGroup = model.rows[0];
    const gates = model.rows.filter(
      (r) => r.parentId === spineGroup.id,
    );
    expect(gates).toHaveLength(8);
    expect(gates.filter((g) => g.kind === "gate-review")).toHaveLength(5);
    expect(gates.filter((g) => g.kind === "gate-test")).toHaveLength(3);
  });

  it("spine gates are ordered by earliest start", () => {
    const spineGroup = model.rows[0];
    const gates = model.rows.filter((r) => r.parentId === spineGroup.id);
    const starts = gates.map((g) => g.startISO);
    expect([...starts].sort()).toEqual(starts);
  });

  it("squad leaves inherit their squad's colour", () => {
    const eng = model.rows.find((r) => r.id === "engines.prelim-design")!;
    expect(eng.squadColor).toBe("#D85A30");
    expect(eng.squadId).toBe("engines");
  });

  it("has a critical path and marks at least one critical link", () => {
    expect(model.rows.some((r) => r.critical)).toBe(true);
    expect(model.links.some((l) => l.critical)).toBe(true);
  });

  it("carries the today + projected-finish markers", () => {
    expect(model.markers.todayISO).toBe("2026-07-04");
    expect(model.markers.projectFinishISO).toBe(schedule.projectFinish);
  });
});

// ── date convention: endISO is EXCLUSIVE (== engine earliestFinish) ───────────

describe("date convention", () => {
  it("endISO equals the engine's exclusive earliestFinish", () => {
    // A 5-day task from Jan 1 occupies Jan 1..Jan 5; its exclusive end is Jan 6.
    const { model } = modelOf([auto("engines.a", 5)]);
    const row = model.rows.find((r) => r.id === "engines.a")!;
    expect(row.startISO).toBe("2026-01-01");
    expect(row.endISO).toBe("2026-01-06");
  });

  it("a milestone has zero width (start === end)", () => {
    const m = auto("engines.m", 0, { milestone: true });
    const { model } = modelOf([auto("engines.a", 3), { ...m, dependsOn: ["engines.a"] }]);
    const row = model.rows.find((r) => r.id === "engines.m")!;
    expect(row.startISO).toBe(row.endISO);
  });
});

// ── grouping, nesting, ordering ───────────────────────────────────────────────

describe("grouping + nesting", () => {
  it("buckets tasks by squad namespace, in project.yaml order", () => {
    const { model } = modelOf([auto("fluids.a", 4), auto("engines.a", 4)]);
    const groups = model.rows.filter((r) => r.kind === "group");
    // Engines declared before Fluids in SQUADS → Engines group comes first.
    expect(groups.map((g) => g.name)).toEqual(["Engines", "Fluids"]);
  });

  it("nests a child under its parent summary within the same squad", () => {
    const parent = auto("engines.chamber", 0); // becomes a summary via the child
    const child = auto("engines.injector", 5, { parent: "engines.chamber" });
    const { model } = modelOf([parent, child]);
    const group = model.rows.find((r) => r.kind === "group")!;
    const p = model.rows.find((r) => r.id === "engines.chamber")!;
    const c = model.rows.find((r) => r.id === "engines.injector")!;
    expect(p.kind).toBe("summary");
    expect(p.parentId).toBe(group.id);
    expect(c.parentId).toBe("engines.chamber"); // nested under the summary
    expect(c.kind).toBe("task");
  });

  it("orders spine gates by earliest start, ties by input order", () => {
    // review.slow waits on a 10d feeder; review.fast on a 5d feeder.
    const tasks: Task[] = [
      auto("engines.long", 10),
      auto("engines.short", 5),
      auto("review.slow", 0, {
        milestone: true,
        gate: "review",
        dependsOn: ["engines.long"],
      }),
      auto("review.fast", 0, {
        milestone: true,
        gate: "review",
        dependsOn: ["engines.short"],
      }),
    ];
    const { model } = modelOf(tasks);
    const spineGroup = model.rows[0];
    const gates = model.rows.filter((r) => r.parentId === spineGroup.id);
    expect(gates.map((g) => g.id)).toEqual(["review.fast", "review.slow"]);
  });

  it("puts leaves matching no squad into an 'Other' group instead of dropping them", () => {
    const { model } = modelOf([auto("mystery-task", 4)]);
    const other = model.rows.find((r) => r.kind === "group" && r.name === "Other");
    expect(other).toBeDefined();
    const orphan = model.rows.find((r) => r.id === "mystery-task")!;
    expect(orphan.parentId).toBe(other!.id);
  });
});

// ── links: FS vs SS, criticality, skipping ────────────────────────────────────

describe("links", () => {
  it("maps FS → '0' and SS → '1'", () => {
    const tasks: Task[] = [
      auto("engines.a", 5),
      auto("engines.b", 4, { dependsOn: ["engines.a"] }), // FS (string form)
      auto("engines.c", 4, {
        dependsOn: [{ task: "engines.a", type: "SS" }],
      }),
    ];
    const { model } = modelOf(tasks);
    const fs = model.links.find((l) => l.targetId === "engines.b")!;
    const ss = model.links.find((l) => l.targetId === "engines.c")!;
    expect(fs.type).toBe("0");
    expect(ss.type).toBe("1");
  });

  it("marks a link critical only when BOTH endpoints are critical", () => {
    // a→b→c is the long chain (all critical); a→d is a short slack branch.
    const tasks: Task[] = [
      auto("engines.a", 5),
      auto("engines.b", 5, { dependsOn: ["engines.a"] }),
      auto("engines.c", 5, { dependsOn: ["engines.b"] }),
      auto("engines.d", 1, { dependsOn: ["engines.a"] }), // slack branch
    ];
    const { model } = modelOf(tasks);
    const ab = model.links.find((l) => l.sourceId === "engines.a" && l.targetId === "engines.b")!;
    const ad = model.links.find((l) => l.sourceId === "engines.a" && l.targetId === "engines.d")!;
    expect(ab.critical).toBe(true);
    expect(ad.critical).toBe(false);
  });

  it("skips links to a summary (drawn on its leaves already) and to missing ids", () => {
    const tasks: Task[] = [
      auto("engines.parent", 0),
      auto("engines.leaf", 4, { parent: "engines.parent" }),
      auto("engines.b", 4, { dependsOn: ["engines.parent"] }), // → summary: skip
      auto("engines.c", 4, { dependsOn: ["engines.ghost"] }), // → missing: skip
    ];
    const { model } = modelOf(tasks);
    expect(model.links.some((l) => l.sourceId === "engines.parent")).toBe(false);
    expect(model.links.some((l) => l.sourceId === "engines.ghost")).toBe(false);
  });
});

// ── pass-through metadata + critical flag on rows ─────────────────────────────

describe("metadata pass-through", () => {
  it("carries status / percent / confidence straight onto the row", () => {
    const tasks: Task[] = [
      auto("engines.a", 5),
      auto("engines.b", 5, {
        dependsOn: ["engines.a"],
        status: "blocked",
        percent: 40,
        confidence: "guess",
      }),
    ];
    const { model } = modelOf(tasks);
    const b = model.rows.find((r) => r.id === "engines.b")!;
    expect(b.status).toBe("blocked");
    expect(b.percent).toBe(40);
    expect(b.confidence).toBe("guess");
    expect(b.critical).toBe(true); // longest chain
  });
});

// ── collision safety ──────────────────────────────────────────────────────────

describe("group-id collision safety", () => {
  it("does not break when a task is literally named 'group:engines'", () => {
    const tasks: Task[] = [
      auto("engines.a", 5),
      auto("group:engines", 4), // pathological id colliding with a group prefix
    ];
    const { model } = modelOf(tasks);
    // No two rows share an id, and the engines group is bumped off the taken id.
    const ids = model.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const enginesGroup = model.rows.find(
      (r) => r.kind === "group" && r.name === "Engines",
    )!;
    expect(enginesGroup.id).not.toBe("group:engines");
    expect(model.rows.some((r) => r.id === "group:engines")).toBe(true);
  });
});

// ── next gate (§4 the one gold glow) ──────────────────────────────────────────

describe("nextGateId", () => {
  it("picks the earliest gate on or after today (normal case)", () => {
    const gates = [
      { id: "g.past", dateISO: "2026-01-01" },
      { id: "g.soon", dateISO: "2026-03-01" },
      { id: "g.later", dateISO: "2026-06-01" },
    ];
    expect(nextGateId(gates, "2026-02-01")).toBe("g.soon");
  });

  it("breaks ties on the same date by input order", () => {
    const gates = [
      { id: "g.first", dateISO: "2026-03-01" },
      { id: "g.second", dateISO: "2026-03-01" },
    ];
    expect(nextGateId(gates, "2026-02-01")).toBe("g.first");
  });

  it("returns null when every gate is already in the past", () => {
    const gates = [
      { id: "g.a", dateISO: "2026-01-01" },
      { id: "g.b", dateISO: "2026-01-15" },
    ];
    expect(nextGateId(gates, "2026-06-01")).toBeNull();
  });

  it("returns null when there are no gates at all", () => {
    expect(nextGateId([], "2026-06-01")).toBeNull();
  });

  it("counts a gate whose date is exactly today as the next gate", () => {
    const gates = [
      { id: "g.today", dateISO: "2026-02-01" },
      { id: "g.later", dateISO: "2026-05-01" },
    ];
    expect(nextGateId(gates, "2026-02-01")).toBe("g.today");
  });

  it("is exposed on the ChartModel built from real data", () => {
    // Real repo data with today = 2026-07-04: whichever gate the engine places
    // first on/after today must be a real spine gate id, or null if all past.
    const p = realProject();
    const schedule = computeSchedule(p.tasks, p.config);
    const model = buildChartModel(p, schedule);
    const gateIds = model.rows
      .filter((r) => r.kind === "gate-review" || r.kind === "gate-test")
      .map((r) => r.id);
    if (model.nextGateId !== null) {
      expect(gateIds).toContain(model.nextGateId);
    }
  });
});

// ── empty schedule (cycle) ────────────────────────────────────────────────────

describe("empty schedule", () => {
  it("returns no rows + hasSchedule:false when the engine drops everything (cycle)", () => {
    const tasks: Task[] = [
      auto("engines.a", 5, { dependsOn: ["engines.b"] }),
      auto("engines.b", 5, { dependsOn: ["engines.a"] }),
    ];
    const p = project(tasks);
    const schedule: ScheduleResult = computeSchedule(p.tasks, p.config);
    expect(Object.keys(schedule.tasks)).toHaveLength(0); // engine emitted nothing
    const model = buildChartModel(p, schedule);
    expect(model.rows).toEqual([]);
    expect(model.links).toEqual([]);
    expect(model.hasSchedule).toBe(false);
    expect(model.markers.todayISO).toBe(NOW); // markers still present
  });
});
