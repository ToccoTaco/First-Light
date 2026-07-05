// ui/chart-model.ts — the PURE, renderer-agnostic bridge from engine + storage
// output to a flat list of rows and links a Gantt renderer can draw.
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │  This file knows NOTHING about DHTMLX or the DOM. It is the honest core of  │
// │  the chart: every decision about ordering, grouping, colour identity,       │
// │  criticality and link typing is made here, where it can be unit-tested.     │
// │  `gantt-adapter.ts` is a thin translator that turns a ChartModel into        │
// │  DHTMLX's own shapes — no chart *decisions* live there.                     │
// └───────────────────────────────────────────────────────────────────────────┘
//
// DATE CONVENTION — read this once and the rest is obvious:
//   `startISO` is the morning the row begins. `endISO` is EXCLUSIVE — the
//   morning AFTER the row's last active day, identical to the engine's
//   `earliestFinish` and to DHTMLX's own `end_date` convention. A 5-day task
//   starting 2026-01-01 has start 2026-01-01 and end 2026-01-06. A milestone
//   has start === end (zero width). Because both the engine and DHTMLX agree on
//   exclusive ends, the adapter passes these straight through with no ±1 fudge.

import type { ISODate, ScheduleResult, Status } from "../engine/types";
import type { ProjectData, Squad } from "../storage/types";

/** What a row *is* — drives glyph, bar style and grid treatment in the theme. */
export type ChartRowKind =
  | "group" // virtual header (Mission spine / a squad) — no bar, just a label
  | "summary" // a real parent task — thin neutral bracket bar
  | "task" // an ordinary leaf task — squad-coloured bar
  | "milestone" // a zero-duration leaf marker — squad-coloured diamond
  | "gate-review" // a spine review gate — outlined ink diamond
  | "gate-test"; // a spine test gate — filled ink diamond

/** A neutral colour token for spine rows that carry no squad identity. */
export const NEUTRAL_COLOR = "#57606A";

export interface ChartRow {
  id: string;
  name: string;
  parentId: string | null; // tree parent; null = top-level row
  startISO: ISODate;
  endISO: ISODate; // EXCLUSIVE (== engine earliestFinish == DHTMLX end_date)
  kind: ChartRowKind;
  squadId: string | null; // null for the spine group + spine gates
  squadColor: string; // squad colour, or NEUTRAL_COLOR for spine/neutral rows
  critical: boolean; // on the critical path (slack === 0)
  slack: number; // days of float before this row becomes critical
  status: Status;
  percent: number; // 0..100
  confidence?: "firm" | "estimate" | "guess";
  isOpen: boolean; // group rows open by default
}

export interface ChartLink {
  id: string;
  sourceId: string;
  targetId: string;
  type: "0" | "1"; // DHTMLX link type: "0" = finish-to-start, "1" = start-to-start
  critical: boolean; // both endpoints critical → critical-path link colouring
}

export interface ChartModel {
  rows: ChartRow[];
  links: ChartLink[];
  markers: { todayISO: ISODate; projectFinishISO: ISODate };
  /**
   * False when the engine returned an empty schedule (a cycle) even though the
   * project has tasks. The app shows the conflicts banner as the hero instead of
   * an empty chart that would lie about the world (§ "never blank the schedule").
   */
  hasSchedule: boolean;
  /**
   * The id of the NEXT upcoming gate (kind gate-review / gate-test) — the first
   * whose date is on or after `config.today`, ties broken by input order. Null
   * when there are no gates or every gate is in the past. The renderer turns this
   * into the one allowed `--gold-glow` halo (DESIGN_DIRECTION §4).
   */
  nextGateId: string | null;
}

/**
 * The next upcoming gate: earliest gate date on or after `today`; ties broken by
 * input order (the order gates appear in `gates`). Returns null when there are no
 * gates or all gates are already in the past. Pure — the one piece of "which gate
 * is next" logic, unit-tested here rather than eyeballed in the adapter.
 */
export function nextGateId(
  gates: { id: string; dateISO: ISODate }[],
  today: ISODate,
): string | null {
  let best: { id: string; dateISO: ISODate } | null = null;
  for (const g of gates) {
    if (g.dateISO < today) continue; // strictly past → skip; == today qualifies
    // Earliest wins; on a tie keep the earlier input-order entry (best already set).
    if (best === null || g.dateISO < best.dateISO) best = g;
  }
  return best ? best.id : null;
}

/**
 * Turn a merged project + its computed schedule into a flat, ordered ChartModel.
 *
 * Row order is deliberate and stable:
 *   1. a virtual "Mission spine" group holding every review/gate, ordered by
 *      earliest start (ties broken by input order);
 *   2. then one virtual group per squad (project.yaml order), each holding that
 *      squad's tasks in file order with real parent/child nesting;
 *   3. finally, if any leaf task matches no squad, a virtual "Other" group so
 *      nothing is ever silently dropped from view.
 */
export function buildChartModel(
  project: ProjectData,
  schedule: ScheduleResult,
): ChartModel {
  const markers = {
    todayISO: project.config.today,
    projectFinishISO: schedule.projectFinish,
  };

  // Cycle case: the engine emitted no dates. Return no rows + a flag so the app
  // shows the banner instead of an empty chart. (§6.2 step 1 / test-6.)
  const scheduledIds = Object.keys(schedule.tasks);
  if (scheduledIds.length === 0 && project.tasks.length > 0) {
    return { rows: [], links: [], markers, hasSchedule: false, nextGateId: null };
  }

  const tasks = project.tasks;
  const squads = project.squads;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const sched = schedule.tasks;

  // A task is a "summary" iff another task names it as `parent` (§5.3). Mirrors
  // the engine; we also read `summary` off the schedule result where present.
  const hasChildren = new Set<string>();
  for (const t of tasks) if (t.parent) hasChildren.add(t.parent);
  const isSummary = (id: string) => hasChildren.has(id);

  // ── group ids that can never collide with a real task id ────────────────────
  // The brief guarantees group ids are prefixed "group:", but a task could in
  // principle be named "group:engines". So we mint ids against the live id set
  // and keep bumping a suffix until we land on one nobody uses.
  const usedIds = new Set(tasks.map((t) => t.id));
  const freeId = (base: string): string => {
    let id = base;
    let n = 1;
    while (usedIds.has(id)) id = `${base}~${n++}`;
    usedIds.add(id);
    return id;
  };

  const rows: ChartRow[] = [];

  // ── which squad does a leaf belong to? by namespaced id prefix (§5.3) ───────
  const squadOf = (id: string): Squad | undefined =>
    squads.find((s) => id.startsWith(s.id + "."));

  // Spine = every task carrying a `gate` field (reviews + test gates, §7).
  const spineTasks = tasks.filter((t) => t.gate !== undefined);

  // Leaves (everything the engine actually scheduled that isn't a gate) get
  // bucketed by squad; summaries ride along in their squad too.
  const nonSpine = tasks.filter((t) => t.gate === undefined);

  // Helper: build a ChartRow for a real task, reading its computed values.
  const rowFor = (
    taskId: string,
    kind: ChartRowKind,
    parentId: string | null,
    squad: Squad | null,
  ): ChartRow => {
    const t = byId.get(taskId)!;
    const c = sched[taskId];
    return {
      id: taskId,
      name: t.name,
      parentId,
      startISO: c.earliestStart,
      endISO: c.earliestFinish,
      kind,
      squadId: squad ? squad.id : null,
      squadColor: squad ? squad.color : NEUTRAL_COLOR,
      critical: c.critical,
      slack: c.slack,
      status: c.status,
      percent: c.percent,
      ...(c.confidence !== undefined ? { confidence: c.confidence } : {}),
      isOpen: true,
    };
  };

  // Aggregate a virtual group row from the member rows already emitted for it.
  const groupRow = (
    id: string,
    name: string,
    members: ChartRow[],
    squad: Squad | null,
  ): ChartRow => {
    const startISO = members.reduce(
      (min, r) => (r.startISO < min ? r.startISO : min),
      members[0].startISO,
    );
    const endISO = members.reduce(
      (max, r) => (r.endISO > max ? r.endISO : max),
      members[0].endISO,
    );
    const slack = members.reduce((m, r) => Math.min(m, r.slack), Infinity);
    const critical = members.some((r) => r.critical);
    const status = rollupStatus(members.map((r) => r.status));
    const percent =
      members.reduce((sum, r) => sum + r.percent, 0) / members.length;
    return {
      id,
      name,
      parentId: null,
      startISO,
      endISO,
      kind: "group",
      squadId: squad ? squad.id : null,
      squadColor: squad ? squad.color : NEUTRAL_COLOR,
      critical,
      slack: Number.isFinite(slack) ? slack : 0,
      status,
      percent,
      isOpen: true,
    };
  };

  // ── 1 · Mission spine ───────────────────────────────────────────────────────
  if (spineTasks.length > 0) {
    const spineGroupId = freeId("group:spine");
    const ordered = [...spineTasks]
      .map((t, inputOrder) => ({ t, inputOrder }))
      .sort((a, b) => {
        const sa = sched[a.t.id].earliestStart;
        const sb = sched[b.t.id].earliestStart;
        if (sa !== sb) return sa < sb ? -1 : 1;
        return a.inputOrder - b.inputOrder;
      });
    const spineRows = ordered.map(({ t }) =>
      rowFor(
        t.id,
        t.gate === "review" ? "gate-review" : "gate-test",
        spineGroupId,
        null,
      ),
    );
    rows.push(groupRow(spineGroupId, "Mission spine", spineRows, null));
    rows.push(...spineRows);
  }

  // ── 2 · one group per squad, in project.yaml order ──────────────────────────
  const claimed = new Set<string>();
  for (const squad of squads) {
    const members = nonSpine.filter((t) => squadOf(t.id)?.id === squad.id);
    if (members.length === 0) continue;
    members.forEach((t) => claimed.add(t.id));
    const squadGroupId = freeId(`group:${squad.id}`);
    const memberRows = emitSquadRows(members, squadGroupId, squad);
    rows.push(groupRow(squadGroupId, squad.name, memberRows, squad));
    rows.push(...memberRows);
  }

  // ── 3 · anything unclaimed by a squad — never drop it silently ──────────────
  const orphans = nonSpine.filter((t) => !claimed.has(t.id));
  if (orphans.length > 0) {
    const otherGroupId = freeId("group:other");
    const orphanRows = emitSquadRows(orphans, otherGroupId, null);
    rows.push(groupRow(otherGroupId, "Other", orphanRows, null));
    rows.push(...orphanRows);
  }

  // ── links from dependsOn ────────────────────────────────────────────────────
  const rowIds = new Set(rows.map((r) => r.id));
  const criticalRow = new Map(rows.map((r) => [r.id, r.critical]));
  const links: ChartLink[] = [];
  const seenLink = new Set<string>();
  for (const t of tasks) {
    // Skip links whose target is a summary (drawn on its leaves already) or that
    // never made it into a row. Storage/engine reported those; we stay silent.
    if (isSummary(t.id) || !rowIds.has(t.id)) continue;
    for (const dep of t.dependsOn ?? []) {
      const depId = typeof dep === "string" ? dep : dep.task;
      const type = typeof dep === "string" ? "FS" : (dep.type ?? "FS");
      // Skip to/from summaries or ids that aren't rows (missing / dropped).
      if (!rowIds.has(depId) || isSummary(depId)) continue;
      const dhType: "0" | "1" = type === "SS" ? "1" : "0";
      const id = `${depId}->${t.id}:${dhType}`;
      if (seenLink.has(id)) continue;
      seenLink.add(id);
      links.push({
        id,
        sourceId: depId,
        targetId: t.id,
        type: dhType,
        // Critical link iff BOTH endpoints are on the critical path.
        critical: !!criticalRow.get(depId) && !!criticalRow.get(t.id),
      });
    }
  }

  // Next gate: gates in INPUT order (spineTasks preserves file order) paired with
  // their scheduled start, resolved against today. Computed here so the adapter
  // only maps a class, never decides which gate is next.
  const gateDates = spineTasks.map((t) => ({
    id: t.id,
    dateISO: sched[t.id].earliestStart,
  }));
  const nextGate = nextGateId(gateDates, project.config.today);

  return { rows, links, markers, hasSchedule: true, nextGateId: nextGate };

  // ── local helpers that close over the maps above ────────────────────────────

  /**
   * Emit the rows for one squad's tasks: file order preserved, real parent/child
   * nesting honoured, summaries as bracket rows. A task nests under its `parent`
   * only when that parent lives in the same group; otherwise it hangs off the
   * group row so the "grouped by squad" invariant always holds.
   */
  function emitSquadRows(
    members: import("../engine/types").Task[],
    groupId: string,
    squad: Squad | null,
  ): ChartRow[] {
    const memberIds = new Set(members.map((t) => t.id));
    const parentInGroup = (t: import("../engine/types").Task): string | null =>
      t.parent && memberIds.has(t.parent) ? t.parent : null;

    const childrenByParent = new Map<string, string[]>();
    const roots: string[] = [];
    for (const t of members) {
      const p = parentInGroup(t);
      if (p) {
        const arr = childrenByParent.get(p) ?? [];
        arr.push(t.id);
        childrenByParent.set(p, arr);
      } else {
        roots.push(t.id);
      }
    }

    const kindOf = (t: import("../engine/types").Task): ChartRowKind => {
      if (isSummary(t.id)) return "summary";
      if (t.milestone === true) return "milestone";
      return "task";
    };

    const out: ChartRow[] = [];
    const walk = (id: string, parentRowId: string) => {
      const t = byId.get(id)!;
      out.push(rowFor(id, kindOf(t), parentRowId, squad));
      for (const childId of childrenByParent.get(id) ?? []) walk(childId, id);
    };
    for (const rootId of roots) walk(rootId, groupId);
    return out;
  }
}

/** any-blocked → blocked; all-done → done; all-not-started → not-started; else in-progress. */
function rollupStatus(statuses: Status[]): Status {
  if (statuses.some((s) => s === "blocked")) return "blocked";
  if (statuses.length > 0 && statuses.every((s) => s === "done")) return "done";
  if (statuses.length > 0 && statuses.every((s) => s === "not-started"))
    return "not-started";
  return "in-progress";
}
