// dashboard/dashboard-model.ts — the PURE brain of the landing view (Phase 4).
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │  Mirrors chart-model's discipline: EVERY dashboard number is decided here, │
// │  in plain functions with no DOM, no React, no network. `Dashboard.tsx` is  │
// │  a thin renderer of the `DashboardModel` this file produces. That keeps    │
// │  the countdown / rollups / slippage / critical / blocked / staleness logic │
// │  unit-testable against fixtures rather than eyeballed in components.        │
// └───────────────────────────────────────────────────────────────────────────┘
//
// The one impurity-shaped thing here — turning a baseline's captured file text
// into a schedule — is still a pure function of its inputs: it runs the SAME
// `mergeProject` + `computeSchedule` pipeline the viewer uses, on the file text
// git handed us at deploy time (via storage/meta). No git, no clock: the caller
// injects `today`, exactly as the chart does.

import { computeSchedule } from "../engine";
import type { ISODate, ScheduleResult, Status } from "../engine/types";
import { mergeProject, type SourceFile } from "../storage/merge";
import type { Meta } from "../storage/meta";
import type { ProjectData, Squad } from "../storage/types";
import { nextGateId } from "../ui/chart-model";

// ── date math (calendar days, TZ-safe via UTC midnight) ──────────────────────

/** Parse "YYYY-MM-DD" to a UTC-midnight epoch ms — no local-timezone drift. */
function isoToUTC(iso: ISODate): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
}

/** Whole calendar days from `from` to `to` (positive = `to` is later). */
export function dayDiff(from: ISODate, to: ISODate): number {
  return Math.round((isoToUTC(to) - isoToUTC(from)) / 86_400_000);
}

// ── the model shapes the UI renders ──────────────────────────────────────────

/** Per-bucket task tallies for the quiet counts line under a progress bar. */
export interface StatusCounts {
  done: number;
  inProgress: number;
  notStarted: number;
  blocked: number;
}

/**
 * The T-minus hero (§4/§9). `countdown` is the normal state; `all-passed` is the
 * calm end-of-mission state; `no-schedule` means a cycle blanked the schedule, so
 * the hero yields to the conflicts message.
 */
export type CountdownModel =
  | {
      kind: "countdown";
      days: number; // days from today to the next gate (0 = today)
      gateId: string;
      gateName: string;
      gateDateISO: ISODate;
    }
  | { kind: "all-passed" }
  | { kind: "no-schedule" };

/** One squad's (or the overall) progress: duration-weighted % + a counts line. */
export interface Rollup {
  percent: number; // 0..100, duration-weighted (done=100, milestones weight 0)
  counts: StatusCounts;
}
export interface SquadRollup extends Rollup {
  squadId: string;
  name: string;
  color: string;
}
export interface RollupsModel {
  overall: Rollup;
  squads: SquadRollup[];
}

/** One row of the quiet per-gate delta table beneath the slippage headline. */
export interface GateDelta {
  gateId: string;
  name: string;
  baselineISO: ISODate | null; // null = gate absent from the baseline schedule
  currentISO: ISODate | null;
  deltaDays: number | null; // + later, − earlier; null when either date is missing
}

/**
 * THE baseline slippage story (§9). `tracked` carries the one headline number
 * (direction + magnitude) plus the supporting per-gate table; `no-baseline` is
 * the honest empty state when meta has no baseline tag.
 */
export type SlippageModel =
  | {
      kind: "tracked";
      baselineTag: string;
      baselineLabel: string; // the date part, e.g. "2026-06-20"
      metricLabel: string; // "Projected first flight" or the finish fallback
      direction: "later" | "earlier" | "steady";
      days: number; // absolute magnitude of the headline move
      gateDeltas: GateDelta[];
    }
  | { kind: "no-baseline" };

/** One node of the compacted critical-path breadcrumb. */
export interface CriticalNode {
  id: string;
  label: string;
  isGate: boolean;
}
/** Critical-path health at a glance (§9) — quiet, no gold on this tile. */
export interface CriticalModel {
  finishISO: ISODate;
  chain: CriticalNode[]; // 3–5 most significant nodes (first · key gates · last)
  taskCount: number; // tasks on the critical thread
  nearestSlackDays: number | null; // min slack OFF the thread (null = all critical)
}

/** One highlighted blocked task (§9). */
export interface BlockedItem {
  id: string;
  name: string;
  squadName: string | null;
  squadColor: string | null;
  daysOpen: number; // how long its window has been open (today − earliest start)
  blocksName: string | null; // first downstream dependent, or null if nothing waits
}

/** One squad file's freshness (§9), read from git-derived meta.staleness. */
export interface StalenessRow {
  path: string;
  label: string; // "Avionics", "Project spine"
  daysAgo: number | null; // null = never committed
  tier: "fresh" | "warn" | "stale"; // >14d warn, >30d stale
}
export type StalenessModel =
  | { kind: "present"; rows: StalenessRow[] }
  | { kind: "absent" };

/** Everything the landing view draws — one pure object built from the inputs. */
export interface DashboardModel {
  countdown: CountdownModel;
  rollups: RollupsModel;
  slippage: SlippageModel;
  critical: CriticalModel | null; // null when a cycle blanked the schedule
  blocked: BlockedItem[];
  staleness: StalenessModel;
}

// ── leaf / squad helpers ─────────────────────────────────────────────────────

interface Task {
  id: string;
  name: string;
  parent?: string;
  milestone?: boolean;
  gate?: "review" | "test";
  schedule:
    | { mode: "auto"; duration: number }
    | { mode: "pinned"; start: ISODate; duration?: number };
  dependsOn?: (string | { task: string; type?: "FS" | "SS"; lag?: number })[];
  status?: Status;
  percent?: number;
}

/** A task is a leaf iff no other task names it as `parent` (mirrors the engine). */
function leafTasks(tasks: Task[]): Task[] {
  const parents = new Set<string>();
  for (const t of tasks) if (t.parent) parents.add(t.parent);
  return tasks.filter((t) => !parents.has(t.id));
}

/** The squad a namespaced id belongs to (by `squad.id + "."` prefix), or null. */
function squadOf(id: string, squads: Squad[]): Squad | null {
  return squads.find((s) => id.startsWith(s.id + ".")) ?? null;
}

/** A leaf's scheduling weight: its duration; milestones (incl. gates) weigh 0. */
function weightOf(t: Task): number {
  if (t.milestone === true) return 0;
  return t.schedule.mode === "auto"
    ? t.schedule.duration
    : (t.schedule.duration ?? 0);
}

/** A leaf's effective percent: done ⇒ 100, else its own percent (default 0). */
function percentOf(t: Task): number {
  return (t.status ?? "not-started") === "done" ? 100 : (t.percent ?? 0);
}

/** Duration-weighted mean percent over a set of leaves (unweighted fallback). */
function rollupOf(leaves: Task[]): Rollup {
  let wSum = 0;
  let pwSum = 0;
  let pFlat = 0;
  const counts: StatusCounts = {
    done: 0,
    inProgress: 0,
    notStarted: 0,
    blocked: 0,
  };
  for (const t of leaves) {
    const p = percentOf(t);
    const w = weightOf(t);
    wSum += w;
    pwSum += w * p;
    pFlat += p;
    const st = t.status ?? "not-started";
    if (st === "done") counts.done++;
    else if (st === "in-progress") counts.inProgress++;
    else if (st === "blocked") counts.blocked++;
    else counts.notStarted++;
  }
  const percent =
    wSum > 0 ? pwSum / wSum : leaves.length ? pFlat / leaves.length : 0;
  return { percent, counts };
}

// ── countdown (§9 · deliverable 1) ───────────────────────────────────────────

export function computeCountdown(
  project: ProjectData,
  schedule: ScheduleResult,
  today: ISODate,
): CountdownModel {
  // A cycle blanks the schedule (engine returns no task dates) even though the
  // project has tasks — the hero must yield to the conflicts message (§9).
  if (project.tasks.length > 0 && Object.keys(schedule.tasks).length === 0) {
    return { kind: "no-schedule" };
  }
  const gates = project.tasks
    .filter((t) => t.gate !== undefined && schedule.tasks[t.id])
    .map((t) => ({ id: t.id, dateISO: schedule.tasks[t.id].earliestStart }));
  const nextId = nextGateId(gates, today);
  if (!nextId) return { kind: "all-passed" }; // no gates, or every gate is past
  const gate = project.tasks.find((t) => t.id === nextId)!;
  const dateISO = schedule.tasks[nextId].earliestStart;
  return {
    kind: "countdown",
    days: dayDiff(today, dateISO),
    gateId: nextId,
    gateName: gate.name,
    gateDateISO: dateISO,
  };
}

// ── rollups (§9 · deliverable 2) ─────────────────────────────────────────────

export function computeRollups(project: ProjectData): RollupsModel {
  const leaves = leafTasks(project.tasks);
  // Only squad-owned leaves count toward progress — spine gates (which carry no
  // squad prefix and weigh 0 as milestones) would only muddy the counts line.
  const squadLeaves = leaves.filter((t) => squadOf(t.id, project.squads));
  const squads: SquadRollup[] = project.squads.map((s) => {
    const own = squadLeaves.filter((t) => t.id.startsWith(s.id + "."));
    return { squadId: s.id, name: s.name, color: s.color, ...rollupOf(own) };
  });
  return { overall: rollupOf(squadLeaves), squads };
}

// ── baseline glue: meta's captured files → a schedule (§6.4) ──────────────────

export interface BaselineSchedule {
  schedule: ScheduleResult;
  tag: string;
  taggedAt: string;
}

/**
 * Run the SAME merge + compute pipeline the viewer uses over the data files as
 * they existed at the newest baseline tag (captured in meta). `today` is the
 * current schedule's today, so both schedules are computed on the same clock and
 * only the DATA differs — the diff is an honest "since baseline" delta.
 */
export function baselineScheduleFromMeta(
  meta: Meta | null,
  today: ISODate,
): BaselineSchedule | null {
  if (!meta || !meta.baseline) return null;
  const files: SourceFile[] = Object.entries(meta.baseline.files).map(
    ([path, text]) => ({ path, text }),
  );
  const merged = mergeProject(files, today);
  const schedule = computeSchedule(merged.tasks, merged.config);
  return { schedule, tag: meta.baseline.tag, taggedAt: meta.baseline.taggedAt };
}

// ── slippage (§9 · deliverable 3) ────────────────────────────────────────────

const FIRST_FLIGHT = "gate.first-flight";

/** The date part of a `baseline/<date>` tag, or the tag/date as a fallback. */
function baselineLabelOf(tag: string, taggedAt: string): string {
  const slash = tag.lastIndexOf("/");
  if (slash >= 0 && slash < tag.length - 1) return tag.slice(slash + 1);
  return taggedAt.slice(0, 10) || tag;
}

export function computeSlippage(
  current: ScheduleResult,
  baseline: BaselineSchedule | null,
  project: ProjectData,
): SlippageModel {
  if (!baseline) return { kind: "no-baseline" };

  // Headline metric: first-flight EF in BOTH schedules; if the gate is missing
  // from either, fall back to the whole-project finish (still an honest move).
  const curFF = current.tasks[FIRST_FLIGHT]?.earliestFinish;
  const baseFF = baseline.schedule.tasks[FIRST_FLIGHT]?.earliestFinish;
  const usingGate = !!curFF && !!baseFF;
  const curISO = usingGate ? curFF! : current.projectFinish;
  const baseISO = usingGate ? baseFF! : baseline.schedule.projectFinish;
  const delta = dayDiff(baseISO, curISO); // + later, − earlier

  const gateDeltas: GateDelta[] = project.tasks
    .filter((t) => t.gate !== undefined)
    .map((t) => {
      const b = baseline.schedule.tasks[t.id]?.earliestFinish ?? null;
      const c = current.tasks[t.id]?.earliestFinish ?? null;
      return {
        gateId: t.id,
        name: t.name,
        baselineISO: b,
        currentISO: c,
        deltaDays: b && c ? dayDiff(b, c) : null,
      };
    });

  return {
    kind: "tracked",
    baselineTag: baseline.tag,
    baselineLabel: baselineLabelOf(baseline.tag, baseline.taggedAt),
    metricLabel: usingGate ? "Projected first flight" : "Projected finish",
    direction: delta > 0 ? "later" : delta < 0 ? "earlier" : "steady",
    days: Math.abs(delta),
    gateDeltas,
  };
}

// ── critical-path health (§9 · deliverable 4) ────────────────────────────────

/** Compact an ordered critical path to 3–5 nodes: first · key gates · last. */
function compactChain(
  path: string[],
  gateIds: Set<string>,
  nameOf: (id: string) => string,
): CriticalNode[] {
  const node = (id: string): CriticalNode => ({
    id,
    label: nameOf(id),
    isGate: gateIds.has(id),
  });
  if (path.length <= 5) return path.map(node);
  const first = path[0];
  const last = path[path.length - 1];
  // Prefer the gates in the middle — they are the milestones people recognise.
  const middleGates = path.slice(1, -1).filter((id) => gateIds.has(id));
  const kept = middleGates.slice(0, 3); // first + up to 3 middles + last ≤ 5
  return [first, ...kept, last].map(node);
}

export function computeCritical(
  schedule: ScheduleResult,
  project: ProjectData,
): CriticalModel | null {
  if (Object.keys(schedule.tasks).length === 0) return null;
  const gateIds = new Set(
    project.tasks.filter((t) => t.gate !== undefined).map((t) => t.id),
  );
  const nameById = new Map(project.tasks.map((t) => [t.id, t.name]));
  const nameOf = (id: string) => nameById.get(id) ?? id;

  // Nearest branch: the smallest slack among tasks NOT on the thread (leaves
  // only — summaries carry rolled-up slack that would double-count).
  let nearest: number | null = null;
  for (const [, s] of Object.entries(schedule.tasks)) {
    if (s.summary || s.critical) continue;
    nearest = nearest === null ? s.slack : Math.min(nearest, s.slack);
  }

  return {
    finishISO: schedule.projectFinish,
    chain: compactChain(schedule.criticalPath, gateIds, nameOf),
    taskCount: schedule.criticalPath.length,
    nearestSlackDays: nearest,
  };
}

// ── blocked items (§9 · deliverable 5) ───────────────────────────────────────

export function computeBlocked(
  project: ProjectData,
  schedule: ScheduleResult,
  today: ISODate,
): BlockedItem[] {
  const depName = (id: string): string | null => {
    // The first task (input order) that names this id as a dependency.
    const dependent = project.tasks.find((t) =>
      (t.dependsOn ?? []).some(
        (d) => (typeof d === "string" ? d : d.task) === id,
      ),
    );
    return dependent ? dependent.name : null;
  };
  return project.tasks
    .filter((t) => t.status === "blocked")
    .map((t) => {
      const sched = schedule.tasks[t.id];
      const squad = squadOf(t.id, project.squads);
      const daysOpen = sched
        ? Math.max(0, dayDiff(sched.earliestStart, today))
        : 0;
      return {
        id: t.id,
        name: t.name,
        squadName: squad ? squad.name : null,
        squadColor: squad ? squad.color : null,
        daysOpen,
        blocksName: depName(t.id),
      };
    });
}

// ── staleness (§9 · deliverable 6) ───────────────────────────────────────────

/** "data/subgroups/avionics.yaml" → "avionics"; project.yaml → "project". */
function namespaceOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.ya?ml$/i, "");
}

function stalenessLabel(path: string, squads: Squad[]): string {
  const ns = namespaceOf(path);
  if (ns === "project") return "Project spine";
  return squads.find((s) => s.id === ns)?.name ?? ns;
}

function tierOf(daysAgo: number | null): StalenessRow["tier"] {
  if (daysAgo === null || daysAgo > 30) return "stale";
  if (daysAgo > 14) return "warn";
  return "fresh";
}

export function computeStaleness(
  meta: Meta | null,
  squads: Squad[],
): StalenessModel {
  if (!meta) return { kind: "absent" };
  const genDay = meta.generatedAt.slice(0, 10);
  const rows: StalenessRow[] = Object.entries(meta.staleness).map(
    ([path, committedAt]) => {
      const daysAgo =
        committedAt === null ? null : dayDiff(committedAt.slice(0, 10), genDay);
      return {
        path,
        label: stalenessLabel(path, squads),
        daysAgo,
        tier: tierOf(daysAgo),
      };
    },
  );
  // Stalest first; never-committed (null) sorts to the very top as most urgent.
  rows.sort((a, b) => {
    if (a.daysAgo === null) return b.daysAgo === null ? 0 : -1;
    if (b.daysAgo === null) return 1;
    return b.daysAgo - a.daysAgo;
  });
  return { kind: "present", rows };
}

// ── the assembler ────────────────────────────────────────────────────────────

/**
 * Build the whole dashboard model from the current project + schedule, the
 * git-derived meta (staleness + captured baseline files), and today. Pure: the
 * baseline schedule is derived from meta's file text, never from a live git call.
 */
export function buildDashboard(
  project: ProjectData,
  schedule: ScheduleResult,
  meta: Meta | null,
  today: ISODate,
): DashboardModel {
  const baseline = baselineScheduleFromMeta(meta, today);
  return {
    countdown: computeCountdown(project, schedule, today),
    rollups: computeRollups(project),
    slippage: computeSlippage(schedule, baseline, project),
    critical: computeCritical(schedule, project),
    blocked: computeBlocked(project, schedule, today),
    staleness: computeStaleness(meta, project.squads),
  };
}
