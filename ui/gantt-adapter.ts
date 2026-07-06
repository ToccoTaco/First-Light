// ui/gantt-adapter.ts — the ONLY file in the codebase allowed to import DHTMLX.
//
// It is a thin translator: a ChartModel (all the honest decisions already made
// in chart-model.ts) goes in, DHTMLX pixels come out. No scheduling, grouping
// or criticality logic lives here — only the mechanical mapping of our shapes to
// DHTMLX's, plus the read-only view configuration.
//
// The library's OWN auto-scheduler and critical-path (PRO) plugins are never
// enabled — our engine computes everything. We enable only `marker` and
// `tooltip`, both MIT/Community. If DHTMLX is ever swapped, this file is the
// blast radius; nothing else imports it.
//
// Type boundary note: at PARSE time we hand DHTMLX ISO date *strings* (it parses
// them via `date_format`); at TEMPLATE time DHTMLX hands us Date *objects* back.
// Our extra per-row fields ride along under an `fl_` prefix and are read through
// a single cast helper, so the rest of the file stays strongly typed.

import { Gantt } from "dhtmlx-gantt";
import type { Task as DHXTask, Link as DHXLink } from "dhtmlx-gantt";
import "dhtmlx-gantt/codebase/dhtmlxgantt.css";
import "./gantt-theme.css";
import { NEUTRAL_COLOR } from "./chart-model";
import type { ChartModel, ChartRow } from "./chart-model";

export type Zoom = "week" | "month" | "quarter";

/**
 * Quick-edit events (Phase 3.2), decided and handled by the APP — the adapter
 * only reports gestures. `isEditable` is the app's pure edit-model decision;
 * rows it refuses get `readonly: true` (no drag affordance) and their clicks
 * surface `onReadOnlyAttempt` so the refusal is polite, never silent.
 */
export interface EditEvents {
  isEditable(id: string): boolean;
  /** A bar (or milestone) was dropped at a new start date. */
  onMove(id: string, newStartISO: string): void;
  /** A bar edge was dragged to a new length (whole calendar days, ≥ 1). */
  onResize(id: string, newDurationDays: number): void;
  /** A single click on an editable bar — the app cycles the status. */
  onStatusClick(id: string): void;
  /** Any edit gesture on a read-only row (spine, summary, group). */
  onReadOnlyAttempt(id: string): void;
}

export interface GanttView {
  render(model: ChartModel, zoom?: Zoom): void;
  setZoom(zoom: Zoom): void;
  destroy(): void;
}

// The neutral squad-colour sentinel is defined once in chart-model (the data
// layer); we reuse it here rather than repeat the literal, so this file stays
// free of raw colour values.
const NEUTRAL = NEUTRAL_COLOR;

// Scale presets: week = day cells, month = week cells, quarter = month cells.
const SCALES: Record<Zoom, { scales: object[]; minColWidth: number }> = {
  week: {
    scales: [
      { unit: "month", step: 1, format: "%F %Y" },
      { unit: "day", step: 1, format: "%j" },
    ],
    minColWidth: 28,
  },
  month: {
    scales: [
      { unit: "month", step: 1, format: "%F %Y" },
      { unit: "week", step: 1, format: "Wk %W" },
    ],
    minColWidth: 60,
  },
  quarter: {
    scales: [
      { unit: "year", step: 1, format: "%Y" },
      { unit: "month", step: 1, format: "%M" },
    ],
    minColWidth: 56,
  },
};

/** The per-row fields we attach to every DHTMLX task for the templates to read. */
interface FLFields {
  fl_kind: ChartRow["kind"];
  fl_name: string;
  fl_squadColor: string;
  fl_critical: boolean;
  fl_slack: number;
  fl_status: ChartRow["status"];
  fl_percent: number;
  fl_confidence?: string;
  fl_nextGate: boolean; // true on the single upcoming gate → the gold-glow halo
}

/** Read our fields off a DHTMLX task (dates on the task are Dates at this point). */
const flOf = (t: DHXTask): DHXTask & FLFields => t as DHXTask & FLFields;

const isDiamond = (kind: ChartRow["kind"]): boolean =>
  kind === "milestone" || kind === "gate-review" || kind === "gate-test";

export function createGanttView(
  container: HTMLElement,
  edits?: EditEvents,
): GanttView {
  const gantt = Gantt.getGanttInstance();

  // Borrow pixels only — the engine owns scheduling. Auto-scheduling / critical
  // path (PRO) stay OFF. Only `tooltip` is enabled: it is the one extension we
  // need that IS bundled in the ES build. The `marker` extension is NOT bundled
  // there, so the today / projected-finish lines are drawn by hand below via
  // posFromDate (the fallback the brief anticipated).
  gantt.plugins({ tooltip: true });

  // ── editing surface (Phase 3.2) ──────────────────────────────────────────────
  // Global readonly OFF only when the app wires edit events; the ONLY enabled
  // gestures are drag-to-move and drag-to-resize. Everything else the library
  // offers stays off for good: drag_links (dependencies are 3.3's picker),
  // drag_progress (percent is panel territory), details_on_dblclick (no DHTMLX
  // lightbox EVER — we build our own panel in 3.3), select_task (a click means
  // "cycle status", not "select"). Its auto-scheduler is never enabled; every
  // date the chart shows comes from OUR engine re-running after each edit.
  gantt.config.readonly = !edits;
  gantt.config.drag_move = true;
  gantt.config.drag_resize = true;
  gantt.config.drag_links = false;
  gantt.config.drag_progress = false;
  gantt.config.details_on_dblclick = false;
  gantt.config.select_task = false;
  // Snap drags to whole days ourselves (below), not to the zoom's grid cell —
  // otherwise month view would snap a drop to week boundaries and lie about it.
  gantt.config.round_dnd_dates = false;
  gantt.config.date_format = "%Y-%m-%d"; // how our ISO strings are parsed
  // 22px bars in 34px rows: DHTMLX centres the bar, leaving ~6px of air above
  // and below — breathing room so rows read separately (user feedback), not
  // sprawl. The theme's bar height override matches (gantt-theme.css).
  gantt.config.row_height = 34;
  gantt.config.bar_height = 22;
  gantt.config.scale_height = 46;
  gantt.config.grid_width = 460; // 260 + 112 + 88
  gantt.config.grid_resize = true;

  const shortDate = gantt.date.date_to_str("%M %j"); // e.g. "Jul 25"
  const isoToDate = gantt.date.str_to_date("%Y-%m-%d");

  // ── grid columns: Task (tree) · Status · Finish — nothing else (low clutter) ─
  gantt.config.columns = [
    {
      name: "text",
      label: "Task",
      tree: true,
      width: 260,
      template: (task: DHXTask) => {
        const f = flOf(task);
        // Squad chip only on squad group headers (leaf identity is the bar).
        const chip =
          f.fl_kind === "group" && f.fl_squadColor !== NEUTRAL
            ? `<span class="fl-chip" style="background:${f.fl_squadColor}"></span>`
            : "";
        return `${chip}${escapeHTML(f.fl_name)}`;
      },
    },
    {
      name: "status",
      label: "Status",
      // Wide enough for "○ Not started" / "◑ In progress" untruncated (§3 type).
      width: 112,
      align: "left",
      template: (task: DHXTask) => {
        const f = flOf(task);
        return f.fl_kind === "group" ? "" : statusCell(f.fl_status);
      },
    },
    {
      name: "finish",
      label: "Finish",
      // Mono dates ("Sep 26") run a touch wider than the old sans — 88 clears it.
      width: 88,
      align: "left",
      template: (task: DHXTask) => {
        const f = flOf(task);
        if (f.fl_kind === "group") return "";
        // end_date is EXCLUSIVE; a task's human "finish" is its last active day.
        const finish = isDiamond(f.fl_kind)
          ? task.start_date
          : gantt.date.add(task.end_date as Date, -1, "day");
        return `<span class="fl-finish-cell">${shortDate(finish)}</span>`;
      },
    },
  ];

  // ── state → CSS class (never inline styles for state) ───────────────────────
  // §7 semantics: leaf-task bar FILL encodes STATE, not squad identity. The theme
  // resolves precedence (done ⊐ critical ⊐ blocked ⊐ in-progress ⊐ not-started)
  // via source order; here we just tag every state present. Squad identity now
  // lives only in the grid chip, so no `color` rides on the bar (see toGanttTask).
  gantt.templates.task_class = (_s: Date, _e: Date, task: DHXTask) => {
    const f = flOf(task);
    const c: string[] = [];
    if (f.fl_kind === "group") c.push("fl-hide-bar");
    if (f.fl_kind === "summary") c.push("fl-summary");
    if (f.fl_kind === "milestone") c.push("fl-milestone");
    if (f.fl_kind === "gate-review") c.push("fl-gate-review");
    if (f.fl_kind === "gate-test") c.push("fl-gate-test");
    if (f.fl_nextGate) c.push("fl-next-gate");
    // Leaf-task state fill (§7). Diamonds/summaries/groups carry their own look.
    if (f.fl_kind === "task") {
      c.push("fl-bar", `fl-st-${f.fl_status}`);
      if (f.fl_critical) c.push("fl-critical");
    }
    if (f.fl_confidence === "guess") c.push("fl-conf-guess");
    else if (f.fl_confidence === "estimate") c.push("fl-conf-estimate");
    return c.join(" ");
  };
  gantt.templates.grid_row_class = (_s: Date, _e: Date, task: DHXTask) =>
    flOf(task).fl_kind === "group" ? "fl-group-row" : "";
  gantt.templates.task_row_class = (_s: Date, _e: Date, task: DHXTask) =>
    flOf(task).fl_kind === "group" ? "fl-group-row" : "";

  // Bars stay clean; names live in the grid. Gates/milestones get a direct label.
  // Blocked is now shown by the bar's own fill + dot glyph and the grid status
  // cell — no extra right-side chip (§8 quieter option).
  gantt.templates.task_text = () => "";
  gantt.templates.rightside_text = (_s: Date, _e: Date, task: DHXTask) => {
    const f = flOf(task);
    return isDiamond(f.fl_kind) ? escapeHTML(f.fl_name) : "";
  };

  gantt.templates.link_class = (link: DHXLink) =>
    (link as DHXLink & { fl_critical?: boolean }).fl_critical
      ? "fl-link-critical"
      : "";

  // ── tooltip: plain-language card ────────────────────────────────────────────
  gantt.templates.tooltip_text = (start: Date, end: Date, task: DHXTask) => {
    const f = flOf(task);
    const diamond = isDiamond(f.fl_kind);
    const lastDay = diamond ? start : gantt.date.add(end, -1, "day");
    const durationDays = Math.max(
      0,
      Math.round((end.getTime() - start.getTime()) / 86_400_000),
    );
    const out: string[] = [
      `<div class="fl-tt-title">${escapeHTML(f.fl_name)}</div>`,
    ];
    // The id reads as a readout, so it goes in mono telemetry ink (§3). Group
    // rows carry synthetic ids ("group:…"), so we skip the line for them.
    if (f.fl_kind !== "group")
      out.push(`<div class="fl-tt-id">${escapeHTML(String(task.id))}</div>`);
    const line = (label: string, value: string) =>
      `<div class="fl-tt-row">${label}: <b>${value}</b></div>`;
    // Telemetry wrap — dates, durations, slack, progress render in mono (§3).
    const tel = (value: string) => `<span class="fl-tt-tel">${value}</span>`;
    if (f.fl_kind === "group") {
      out.push(
        line("Rows span", tel(`${shortDate(start)} → ${shortDate(lastDay)}`)),
      );
      return out.join("");
    }
    if (diamond) {
      out.push(line("Target", tel(shortDate(start))));
    } else {
      out.push(
        line("Dates", tel(`${shortDate(start)} → ${shortDate(lastDay)}`)),
      );
      out.push(
        line(
          "Duration",
          tel(`${durationDays} day${durationDays === 1 ? "" : "s"}`),
        ),
      );
    }
    out.push(line("Status", statusWord(f.fl_status)));
    if (f.fl_percent > 0)
      out.push(line("Progress", tel(`${Math.round(f.fl_percent)}%`)));
    out.push(
      line(
        "Slack",
        f.fl_critical
          ? tel("0 days") + " (on the critical path)"
          : tel(`${f.fl_slack} day${f.fl_slack === 1 ? "" : "s"}`),
      ),
    );
    if (f.fl_confidence)
      out.push(line("Confidence", confidenceWord(f.fl_confidence)));
    return out.join("");
  };

  // ── edit gestures → app events ──────────────────────────────────────────────
  if (edits) {
    // Belt-and-suspenders veto: read-only rows also carry `readonly: true` (set
    // in render, which hides the drag affordance), but if a drag somehow starts
    // we refuse it here and surface the polite notice.
    gantt.attachEvent("onBeforeTaskDrag", (id: string | number) => {
      if (edits.isEditable(String(id))) return true;
      edits.onReadOnlyAttempt(String(id));
      return false;
    });

    let lastDragEnd = 0; // suppress the synthetic click that follows a drop
    gantt.attachEvent("onAfterTaskDrag", (id: string | number, mode: string) => {
      lastDragEnd = Date.now();
      const task = gantt.getTask(id);
      if (mode === "move") {
        edits.onMove(String(id), nearestDayISO(task.start_date as Date));
      } else if (mode === "resize") {
        // Whole-day duration from the dragged span. Either edge maps to the
        // same honest patch: "this task now takes N days" (§8 quick tier).
        const ms =
          (task.end_date as Date).getTime() -
          (task.start_date as Date).getTime();
        edits.onResize(String(id), Math.max(1, Math.round(ms / 86_400_000)));
      }
    });

    // §8: one click on a BAR cycles status. Grid clicks keep their default
    // behaviour (tree expand/collapse); bar clicks never select — selection is
    // off and the click is consumed here. The hover tooltip is untouched.
    gantt.attachEvent(
      "onTaskClick",
      (id: string | number, e: MouseEvent | undefined) => {
        const target = e?.target as HTMLElement | null;
        const onBar = !!target?.closest(".gantt_task_line");
        if (!onBar) return true; // grid row → default handling
        if (Date.now() - lastDragEnd < 300) return false; // drop, not a click
        if (edits.isEditable(String(id))) edits.onStatusClick(String(id));
        else edits.onReadOnlyAttempt(String(id));
        return false;
      },
    );
  }

  let initialised = false;
  let currentZoom: Zoom = "month";
  let markerData: ChartModel["markers"] | null = null;
  const markerEls = new Map<string, HTMLDivElement>();

  const applyScales = (zoom: Zoom) => {
    gantt.config.scales = SCALES[zoom].scales as never;
    gantt.config.min_column_width = SCALES[zoom].minColWidth;
  };

  // Custom vertical markers (the `marker` plugin isn't bundled). Positioned by
  // posFromDate into the scrolling timeline layer and redrawn on every render.
  const drawMarkers = () => {
    const layer = gantt.$task_data;
    if (!markerData || !layer) return;
    const specs = [
      {
        key: "today",
        iso: markerData.todayISO,
        css: "fl-marker-today",
        label: "Today",
      },
      {
        key: "finish",
        iso: markerData.projectFinishISO,
        css: "fl-marker-finish",
        label: `Projected finish ${shortDate(isoToDate(markerData.projectFinishISO))}`,
      },
    ];
    for (const s of specs) {
      let el = markerEls.get(s.key);
      if (!el) {
        el = document.createElement("div");
        const label = document.createElement("div");
        label.className = "fl-marker-label";
        el.appendChild(label);
        markerEls.set(s.key, el);
      }
      el.className = `fl-marker ${s.css}`;
      (el.firstChild as HTMLDivElement).textContent = s.label;
      // DHTMLX may rebuild the data layer on render — (re)attach if detached.
      if (el.parentNode !== layer) layer.appendChild(el);
      el.style.left = `${gantt.posFromDate(isoToDate(s.iso))}px`;
    }
  };
  gantt.attachEvent("onGanttRender", drawMarkers);

  const render = (model: ChartModel, zoom?: Zoom) => {
    if (zoom) currentZoom = zoom;
    applyScales(currentZoom);
    // Re-renders now happen live after every edit (the auto-reschedule magic),
    // so the scroll position must survive the clearAll/parse round-trip.
    const scroll = initialised ? gantt.getScrollState() : null;
    if (!initialised) {
      gantt.init(container);
      initialised = true;
    }
    gantt.clearAll();
    const payload = {
      data: model.rows.map((r) => {
        const raw = toGanttTask(r, model.nextGateId);
        // Per-row lock: rows the app refuses (spine gates, summaries, groups)
        // get DHTMLX's own readonly flag, which hides the drag affordance.
        if (!edits || !edits.isEditable(r.id)) raw.readonly = true;
        return raw;
      }),
      links: model.links.map((l) => ({
        id: l.id,
        source: l.sourceId,
        target: l.targetId,
        type: l.type,
        fl_critical: l.critical,
      })),
    };
    gantt.parse(payload as Parameters<typeof gantt.parse>[0]);
    if (scroll) gantt.scrollTo(scroll.x, scroll.y);
    markerData = model.markers;
    drawMarkers();
  };

  return {
    render,
    setZoom(zoom: Zoom) {
      currentZoom = zoom;
      applyScales(zoom);
      if (initialised) gantt.render();
    },
    destroy() {
      markerEls.clear();
      if (initialised) gantt.destructor();
    },
  };
}

// ── row → DHTMLX task (plain record, string dates; cast to Task[] at parse) ────

interface RawGanttTask extends FLFields {
  id: string;
  text: string;
  start_date: string;
  end_date?: string;
  duration?: number;
  parent: string | number;
  type: string;
  open: boolean;
  progress: number;
  color?: string;
  readonly?: boolean; // per-row lock (spine / summaries / groups in 3.2)
}

/**
 * A dropped drag lands on arbitrary clock time (round_dnd_dates is off so the
 * zoom grid never lies); we snap to the NEAREST local midnight — add 12h, take
 * the date — because our whole data model speaks calendar days.
 */
function nearestDayISO(d: Date): string {
  const shifted = new Date(d.getTime() + 12 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getFullYear()}-${p(shifted.getMonth() + 1)}-${p(shifted.getDate())}`;
}

function toGanttTask(row: ChartRow, nextGateId: string | null): RawGanttTask {
  const diamond = isDiamond(row.kind);
  const container = row.kind === "group" || row.kind === "summary";
  const type = diamond ? "milestone" : container ? "project" : "task";

  const base: RawGanttTask = {
    id: row.id,
    text: row.name,
    start_date: row.startISO,
    parent: row.parentId ?? 0,
    type,
    open: row.isOpen,
    progress: Math.min(1, Math.max(0, row.percent / 100)),
    fl_kind: row.kind,
    fl_name: row.name,
    fl_squadColor: row.squadColor,
    fl_critical: row.critical,
    fl_slack: row.slack,
    fl_status: row.status,
    fl_percent: row.percent,
    fl_nextGate: row.id === nextGateId,
    ...(row.confidence !== undefined ? { fl_confidence: row.confidence } : {}),
  };

  // §7: timeline bars no longer carry squad identity — the bar FILL is STATE,
  // set by CSS off the state classes. Squad colour survives only as the grid
  // chip (fl_squadColor, read by the Task-column template). So no `color` here.

  if (diamond) {
    base.end_date = row.startISO; // zero width — DHTMLX draws a diamond
    base.duration = 0;
  } else if (!container) {
    base.end_date = row.endISO; // exclusive — matches DHTMLX end_date exactly
  }
  // Containers (project type) auto-derive their span from children.
  return base;
}

// ── grid cell + tooltip text helpers ─────────────────────────────────────────

const STATUS_META: Record<ChartRow["status"], { icon: string; word: string }> = {
  "not-started": { icon: "○", word: "Not started" },
  "in-progress": { icon: "◑", word: "In progress" },
  blocked: { icon: "⚠", word: "Blocked" },
  done: { icon: "✓", word: "Done" },
};

function statusCell(status: ChartRow["status"]): string {
  const { icon, word } = STATUS_META[status];
  return `<span class="fl-status fl-status-${status}">${icon} ${word}</span>`;
}

function statusWord(status: ChartRow["status"]): string {
  return STATUS_META[status].word;
}

function confidenceWord(c: string): string {
  return (
    { firm: "Firm", estimate: "Estimate", guess: "Guess (a genuine unknown)" }[
      c as "firm" | "estimate" | "guess"
    ] ?? c
  );
}

/** Minimal HTML escape for names flowing into template strings. */
function escapeHTML(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
