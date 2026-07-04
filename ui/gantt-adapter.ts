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
import type { ChartModel, ChartRow } from "./chart-model";

export type Zoom = "week" | "month" | "quarter";

export interface GanttView {
  render(model: ChartModel, zoom?: Zoom): void;
  setZoom(zoom: Zoom): void;
  destroy(): void;
}

const NEUTRAL = "#57606A";

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
}

/** Read our fields off a DHTMLX task (dates on the task are Dates at this point). */
const flOf = (t: DHXTask): DHXTask & FLFields => t as DHXTask & FLFields;

const isDiamond = (kind: ChartRow["kind"]): boolean =>
  kind === "milestone" || kind === "gate-review" || kind === "gate-test";

export function createGanttView(container: HTMLElement): GanttView {
  const gantt = Gantt.getGanttInstance();

  // Borrow pixels only — the engine owns scheduling. Auto-scheduling / critical
  // path (PRO) stay OFF. Only `tooltip` is enabled: it is the one extension we
  // need that IS bundled in the ES build. The `marker` extension is NOT bundled
  // there, so the today / projected-finish lines are drawn by hand below via
  // posFromDate (the fallback the brief anticipated).
  gantt.plugins({ tooltip: true });

  gantt.config.readonly = true;
  gantt.config.date_format = "%Y-%m-%d"; // how our ISO strings are parsed
  gantt.config.row_height = 28;
  gantt.config.bar_height = 22;
  gantt.config.scale_height = 46;
  gantt.config.grid_width = 434; // 260 + 90 + 84
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
      width: 90,
      align: "left",
      template: (task: DHXTask) => {
        const f = flOf(task);
        return f.fl_kind === "group" ? "" : statusCell(f.fl_status);
      },
    },
    {
      name: "finish",
      label: "Finish",
      width: 84,
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
  gantt.templates.task_class = (_s: Date, _e: Date, task: DHXTask) => {
    const f = flOf(task);
    const c: string[] = [];
    if (f.fl_kind === "group") c.push("fl-hide-bar");
    if (f.fl_kind === "summary") c.push("fl-summary");
    if (f.fl_kind === "gate-review") c.push("fl-gate-review");
    if (f.fl_kind === "gate-test") c.push("fl-gate-test");
    if (f.fl_critical) c.push("fl-critical");
    if (f.fl_status === "done") c.push("fl-done");
    if (f.fl_confidence === "guess") c.push("fl-conf-guess");
    else if (f.fl_confidence === "estimate") c.push("fl-conf-estimate");
    return c.join(" ");
  };
  gantt.templates.grid_row_class = (_s: Date, _e: Date, task: DHXTask) =>
    flOf(task).fl_kind === "group" ? "fl-group-row" : "";
  gantt.templates.task_row_class = (_s: Date, _e: Date, task: DHXTask) =>
    flOf(task).fl_kind === "group" ? "fl-group-row" : "";

  // Bars stay clean; names live in the grid. Gates get a direct label; blocked
  // rows get a chip — both via the right-side content.
  gantt.templates.task_text = () => "";
  gantt.templates.rightside_text = (_s: Date, _e: Date, task: DHXTask) => {
    const f = flOf(task);
    const parts: string[] = [];
    if (isDiamond(f.fl_kind)) parts.push(escapeHTML(f.fl_name));
    if (f.fl_status === "blocked")
      parts.push(`<span class="fl-blocked-chip">⚠ Blocked</span>`);
    return parts.join(" ");
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
    const line = (label: string, value: string) =>
      `<div class="fl-tt-row">${label}: <b>${value}</b></div>`;
    if (f.fl_kind === "group") {
      out.push(line("Rows span", `${shortDate(start)} → ${shortDate(lastDay)}`));
      return out.join("");
    }
    if (diamond) {
      out.push(line("Target", shortDate(start)));
    } else {
      out.push(line("Dates", `${shortDate(start)} → ${shortDate(lastDay)}`));
      out.push(
        line("Duration", `${durationDays} day${durationDays === 1 ? "" : "s"}`),
      );
    }
    out.push(line("Status", statusWord(f.fl_status)));
    if (f.fl_percent > 0)
      out.push(line("Progress", `${Math.round(f.fl_percent)}%`));
    out.push(
      line(
        "Slack",
        f.fl_critical
          ? "0 days (on the critical path)"
          : `${f.fl_slack} day${f.fl_slack === 1 ? "" : "s"}`,
      ),
    );
    if (f.fl_confidence)
      out.push(line("Confidence", confidenceWord(f.fl_confidence)));
    return out.join("");
  };

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
    if (!initialised) {
      gantt.init(container);
      initialised = true;
    }
    gantt.clearAll();
    const payload = {
      data: model.rows.map(toGanttTask),
      links: model.links.map((l) => ({
        id: l.id,
        source: l.sourceId,
        target: l.targetId,
        type: l.type,
        fl_critical: l.critical,
      })),
    };
    gantt.parse(payload as Parameters<typeof gantt.parse>[0]);
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
}

function toGanttTask(row: ChartRow): RawGanttTask {
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
    ...(row.confidence !== undefined ? { fl_confidence: row.confidence } : {}),
  };

  // Colour identity: only leaf tasks + squad milestones wear a squad fill.
  // Groups + summaries stay neutral, gates ink — all handled by CSS.
  if (row.kind === "task" || row.kind === "milestone") base.color = row.squadColor;

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
