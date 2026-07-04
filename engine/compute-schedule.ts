// engine/compute-schedule.ts — the pure scheduling core (brief §6).
//
// A single pure function turns a merged task graph into computed dates, the
// critical path, per-task slack, and a list of conflicts. It touches no DOM,
// no git, no storage — it is just a calendar-day calculator. The five numbered
// steps below mirror §6.2. The acceptance-test suite in `engine.test.ts` (the
// eleven §6.3 cases) is the contract; read it alongside this file.

import type { Task, Config, ScheduleResult, Conflict, Status } from "./types";
import { toDay, fromDay } from "./date-math";

type EdgeType = "FS" | "SS";
interface OutEdge {
  succ: string;
  type: EdgeType;
  lag: number;
}
interface InEdge {
  pred: string;
  type: EdgeType;
  lag: number;
}

/** Per-leaf scratch values carried between the forward and backward passes. */
interface Calc {
  es: number;
  ef: number;
  ls: number;
  lf: number;
  dur: number;
  pinned: boolean;
  pin: number;
  met: boolean; // a pinned task whose pin is >= its dependency-driven earliest
  depEarliest: number | null; // earliest start forced by predecessors (null = none)
}

export function computeSchedule(tasks: Task[], config: Config): ScheduleResult {
  const today = toDay(config.today);

  const byId = new Map<string, Task>();
  const inputOrder = new Map<string, number>();
  tasks.forEach((t, i) => {
    byId.set(t.id, t);
    inputOrder.set(t.id, i);
  });

  // A task is a "summary" iff some other task names it as `parent` (§5.3).
  // Summaries never participate in the passes; they roll up from their leaves.
  const childrenOf = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.parent !== undefined) {
      const arr = childrenOf.get(t.parent) ?? [];
      arr.push(t.id);
      childrenOf.set(t.parent, arr);
    }
  }
  const isSummary = (id: string) => childrenOf.has(id);

  // Leaf descendants of any id (a leaf resolves to itself). Depending on a
  // summary means depending on ALL of it, so edges are expanded across leaves.
  const leavesCache = new Map<string, string[]>();
  function leavesOf(id: string): string[] {
    const cached = leavesCache.get(id);
    if (cached) return cached;
    let res: string[];
    if (isSummary(id)) {
      res = [];
      for (const c of childrenOf.get(id)!) res.push(...leavesOf(c));
    } else {
      res = [id];
    }
    leavesCache.set(id, res);
    return res;
  }

  const leafIds = tasks.filter((t) => !isSummary(t.id)).map((t) => t.id);

  // ── Step 1: merge + build the leaf dependency graph ────────────────────────
  // Expand every declared edge onto leaf nodes. An edge to/from a summary
  // becomes edges at each of its leaves. An id that names no task drops the
  // edge and records a (non-fatal) missing-dependency conflict.
  const outEdges = new Map<string, OutEdge[]>();
  const inEdges = new Map<string, InEdge[]>();
  for (const id of leafIds) {
    outEdges.set(id, []);
    inEdges.set(id, []);
  }
  const missing: Conflict[] = [];
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      const depId = typeof dep === "string" ? dep : dep.task;
      const type: EdgeType =
        typeof dep === "string" ? "FS" : (dep.type ?? "FS");
      const lag = typeof dep === "string" ? 0 : (dep.lag ?? 0);
      if (!byId.has(depId)) {
        missing.push({
          kind: "missing-dependency",
          task: t.id,
          missing: depId,
        });
        continue;
      }
      const preds = leavesOf(depId);
      const succs = leavesOf(t.id);
      for (const s of succs) {
        for (const p of preds) {
          outEdges.get(p)!.push({ succ: s, type, lag });
          inEdges.get(s)!.push({ pred: p, type, lag });
        }
      }
    }
  }

  // ── Step 1 (continued): topological sort; stop on any cycle ────────────────
  // Every non-trivial strongly-connected component is a cycle. Nothing
  // downstream of a cycle can be trusted, so we emit only the cycle conflicts
  // and return an otherwise-empty result.
  const cycles = findCycles(leafIds, outEdges);
  if (cycles.length > 0) {
    return {
      tasks: {},
      criticalPath: [],
      projectFinish: config.today,
      conflicts: cycles.map((members) => ({ kind: "cycle", tasks: members })),
    };
  }

  // Kahn's algorithm, always taking the ready node of lowest input index, so
  // the order is deterministic and stable for identical input.
  const indeg = new Map<string, number>();
  for (const id of leafIds) {
    indeg.set(id, new Set(inEdges.get(id)!.map((e) => e.pred)).size);
  }
  const placed = new Set<string>();
  const topo: string[] = [];
  while (topo.length < leafIds.length) {
    let pick: string | null = null;
    for (const id of leafIds) {
      if (placed.has(id) || (indeg.get(id) ?? 0) !== 0) continue;
      if (pick === null || inputOrder.get(id)! < inputOrder.get(pick)!)
        pick = id;
    }
    if (pick === null) break; // unreachable: cycles already handled above
    placed.add(pick);
    topo.push(pick);
    for (const s of new Set(outEdges.get(pick)!.map((e) => e.succ))) {
      indeg.set(s, (indeg.get(s) ?? 0) - 1);
    }
  }
  const topoIndex = new Map<string, number>();
  topo.forEach((id, i) => topoIndex.set(id, i));

  // ── Step 2: forward pass — earliest start / finish, in dependency order ────
  const calc = new Map<string, Calc>();
  for (const id of topo) {
    const t = byId.get(id)!;
    const pinned = t.schedule.mode === "pinned";
    const milestone = t.milestone === true;

    let dur = 0;
    if (!milestone) {
      dur =
        t.schedule.mode === "auto"
          ? t.schedule.duration
          : (t.schedule.duration ?? 0);
    }

    // Earliest start forced by predecessors: FS tracks a pred's finish, SS its
    // start. `null` means this task has no predecessor constraint at all.
    let depEarliest: number | null = null;
    for (const e of inEdges.get(id)!) {
      const p = calc.get(e.pred)!;
      const c = e.type === "FS" ? p.ef + e.lag : p.es + e.lag;
      depEarliest = depEarliest === null ? c : Math.max(depEarliest, c);
    }

    const pin = pinned ? toDay((t.schedule as { start: string }).start) : 0;
    // Pins are constraints, never overrides: a pinned task's ES is EXACTLY its
    // pin, always. An auto task with no predecessors starts at `today`.
    const es = pinned ? pin : depEarliest === null ? today : depEarliest;
    const ef = es + dur;
    // A pin is "met" (and so a valid backward anchor) when it is no earlier
    // than its dependencies allow. No predecessors ⇒ any pin is met.
    const met = pinned ? depEarliest === null || pin >= depEarliest : true;

    calc.set(id, { es, ef, ls: 0, lf: 0, dur, pinned, pin, met, depEarliest });
  }

  // projectFinish = max earliest-finish across all non-summary tasks (§ "Other").
  let pf: number;
  if (leafIds.length === 0) {
    pf = today;
  } else {
    pf = -Infinity;
    for (const id of leafIds) pf = Math.max(pf, calc.get(id)!.ef);
  }

  // ── Step 3 + 4: anchor + backward pass — latest start / finish, slack ──────
  // A met pin anchors itself (LS = LF = pin, so it is critical). A true sink
  // with no pin anchors on projectFinish (capability-driven default). Every
  // other node derives its latest dates from its successors.
  for (let i = topo.length - 1; i >= 0; i--) {
    const c = calc.get(topo[i])!;
    if (c.pinned && c.met) {
      c.ls = c.pin;
      c.lf = c.pin;
      continue;
    }
    let lf = Infinity;
    for (const e of outEdges.get(topo[i])!) {
      const s = calc.get(e.succ)!;
      // FS bounds this task's finish; SS bounds its start (so add its own dur).
      lf = Math.min(lf, e.type === "FS" ? s.ls - e.lag : s.ls - e.lag + c.dur);
    }
    if (lf === Infinity) lf = pf; // sink / unconstrained → project anchor
    c.lf = lf;
    c.ls = lf - c.dur;
  }

  // ── Step 5: assemble result — leaf dates, roll-ups, conflicts ──────────────
  const resultTasks: ScheduleResult["tasks"] = {};

  for (const id of leafIds) {
    const c = calc.get(id)!;
    const t = byId.get(id)!;
    const slack = c.ls - c.es;
    const status: Status = t.status ?? "not-started";
    const percent = status === "done" ? 100 : (t.percent ?? 0);
    resultTasks[id] = {
      earliestStart: fromDay(c.es),
      earliestFinish: fromDay(c.ef),
      latestStart: fromDay(c.ls),
      latestFinish: fromDay(c.lf),
      slack,
      critical: slack === 0,
      status,
      percent,
      summary: false,
      ...(t.confidence !== undefined ? { confidence: t.confidence } : {}),
    };
  }

  // Roll summaries up from their leaf descendants. Dates take the widest span,
  // slack the tightest child, critical if any child is critical (§ "rollup").
  for (const t of tasks) {
    if (!isSummary(t.id)) continue;
    const descendants = leavesOf(t.id);
    const cs = descendants.map((l) => calc.get(l)!);
    const es = Math.min(...cs.map((c) => c.es));
    const ef = Math.max(...cs.map((c) => c.ef));
    const ls = Math.min(...cs.map((c) => c.ls));
    const lf = Math.max(...cs.map((c) => c.lf));
    const slack = Math.min(...cs.map((c) => c.ls - c.es));
    const critical = cs.some((c) => c.ls - c.es === 0);

    // Percent: duration-weighted mean over leaves (milestones weigh 0). If every
    // weight is 0, fall back to an unweighted mean so the number stays honest.
    let wSum = 0;
    let pwSum = 0;
    let pFlat = 0;
    for (const l of descendants) {
      const lt = byId.get(l)!;
      const st: Status = lt.status ?? "not-started";
      const p = st === "done" ? 100 : (lt.percent ?? 0);
      const w = calc.get(l)!.dur;
      wSum += w;
      pwSum += w * p;
      pFlat += p;
    }
    const percent =
      wSum > 0
        ? pwSum / wSum
        : descendants.length
          ? pFlat / descendants.length
          : 0;

    // Status: any blocked wins; else all-done, else all-not-started, else mixed.
    const statuses = descendants.map(
      (l) => (byId.get(l)!.status ?? "not-started") as Status,
    );
    let status: Status;
    if (statuses.some((s) => s === "blocked")) status = "blocked";
    else if (statuses.every((s) => s === "done")) status = "done";
    else if (statuses.every((s) => s === "not-started")) status = "not-started";
    else status = "in-progress";

    resultTasks[t.id] = {
      earliestStart: fromDay(es),
      earliestFinish: fromDay(ef),
      latestStart: fromDay(ls),
      latestFinish: fromDay(lf),
      slack,
      critical,
      status,
      percent,
      summary: true,
    };
  }

  // criticalPath: every non-summary task with zero slack (met pins included),
  // in topological order.
  const criticalPath = leafIds
    .filter((id) => calc.get(id)!.ls - calc.get(id)!.es === 0)
    .sort((a, b) => topoIndex.get(a)! - topoIndex.get(b)!);

  // Conflicts: missing-dependency (already gathered), then per-leaf hard-deadline
  // misses and pin-conflicts. If a task earns BOTH, only the deadline miss is
  // emitted (it is the more actionable truth).
  const conflicts: Conflict[] = [...missing];
  for (const t of tasks) {
    if (isSummary(t.id)) continue;
    const c = calc.get(t.id)!;

    let hardMiss: Conflict | null = null;
    if (t.deadline && t.deadline.hard) {
      const dl = toDay(t.deadline.date);
      const depEarliest = c.depEarliest === null ? today : c.depEarliest;
      const achievableFinish = depEarliest + c.dur;
      if (achievableFinish > dl) {
        hardMiss = {
          kind: "hard-deadline-miss",
          task: t.id,
          deadline: t.deadline.date,
          overrunDays: achievableFinish - dl,
        };
      }
    }

    let pinConflict: Conflict | null = null;
    if (c.pinned && !c.met) {
      pinConflict = {
        kind: "pin-conflict",
        task: t.id,
        pinnedStart: fromDay(c.pin),
        earliestPossible: fromDay(c.depEarliest!),
      };
    }

    if (hardMiss) conflicts.push(hardMiss);
    else if (pinConflict) conflicts.push(pinConflict);
  }

  return {
    tasks: resultTasks,
    criticalPath,
    projectFinish: fromDay(pf),
    conflicts,
  };
}

// Tarjan's SCC scan. Returns one member list per cycle (each sorted ascending;
// the list of cycles sorted by first member) so multiple independent cycles are
// reported separately and the output is deterministic.
function findCycles(nodes: string[], out: Map<string, OutEdge[]>): string[][] {
  const selfLoop = new Set<string>();
  for (const n of nodes) {
    for (const e of out.get(n)!) if (e.succ === n) selfLoop.add(n);
  }

  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  function strongconnect(v: string) {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const e of out.get(v)!) {
      const w = e.succ;
      if (w === v) continue; // self-loop tracked separately
      if (!idx.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      sccs.push(comp);
    }
  }

  for (const n of nodes) if (!idx.has(n)) strongconnect(n);

  const cycles: string[][] = [];
  for (const comp of sccs) {
    if (comp.length > 1 || selfLoop.has(comp[0])) cycles.push([...comp].sort());
  }
  cycles.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return cycles;
}
