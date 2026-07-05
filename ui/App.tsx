// ui/App.tsx — the read-only viewer shell (Phase 3.1).
//
// Fetches the five data files, runs them through the SAME storage + engine
// pipeline the tests use, builds a renderer-agnostic ChartModel, and hands it to
// the DHTMLX adapter. Everything honest (grouping, criticality, conflicts) is
// decided upstream; this component only orchestrates load → compute → render and
// owns the three view states (loading / error / ready) plus the issues banner.

import { useEffect, useRef, useState } from "react";
import { computeSchedule } from "../engine";
import type { Conflict, ScheduleResult } from "../engine/types";
import { mergeProject, type SourceFile } from "../storage/merge";
import type { DataIssue, ProjectData } from "../storage/types";
import { buildChartModel, type ChartModel } from "./chart-model";
import { createGanttView, type GanttView, type Zoom } from "./gantt-adapter";
import {
  applyMode,
  otherMode,
  readMode,
  resolveMode,
  type Mode,
} from "./mode";
import "./app.css";

// The manifest is a constant: project file first (its order is the tie-breaker
// for duplicate ids), then one file per squad.
const BASE = import.meta.env.BASE_URL;
const PROJECT_FILE = `${BASE}data/project.yaml`;
const SQUAD_FILES = [
  `${BASE}data/subgroups/engines.yaml`,
  `${BASE}data/subgroups/fluids.yaml`,
  `${BASE}data/subgroups/structures.yaml`,
  `${BASE}data/subgroups/avionics.yaml`,
];

/** Local calendar date as YYYY-MM-DD — computed once, injected into the merge. */
function todayLocalISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Repo-relative path for issue messages, stripped of the deploy base + query. */
function repoPath(url: string): string {
  const withoutBase = url.startsWith(BASE) ? url.slice(BASE.length) : url;
  return withoutBase.replace(/^\/+/, "");
}

interface Ready {
  status: "ready";
  project: ProjectData;
  schedule: ScheduleResult;
  model: ChartModel;
}
type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | Ready;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function load(): Promise<LoadState> {
  // The project file is load-bearing (squads + spine). If it can't be fetched,
  // that's a real error card — not a silent degrade.
  let projectText: string;
  try {
    projectText = await fetchText(PROJECT_FILE);
  } catch {
    return {
      status: "error",
      message: `Could not load ${repoPath(PROJECT_FILE)}. The viewer needs the project file to draw the mission spine.`,
    };
  }

  const files: SourceFile[] = [{ path: repoPath(PROJECT_FILE), text: projectText }];
  const fetchIssues: DataIssue[] = [];

  // Squad files degrade gracefully: a failed fetch becomes a banner entry, and
  // the rest of the project still renders (mirrors storage's "never fatal" rule).
  const results = await Promise.allSettled(SQUAD_FILES.map(fetchText));
  results.forEach((r, i) => {
    const path = repoPath(SQUAD_FILES[i]);
    if (r.status === "fulfilled") {
      files.push({ path, text: r.value });
    } else {
      fetchIssues.push({
        severity: "warning",
        file: path,
        message: `Could not load ${path} (${String(r.reason?.message ?? r.reason)}) — this squad is missing from the chart; its tasks and dependencies won't appear until it loads.`,
      });
    }
  });

  try {
    const project = mergeProject(files, todayLocalISO());
    project.issues.push(...fetchIssues);
    const schedule = computeSchedule(project.tasks, project.config);
    const model = buildChartModel(project, schedule);
    return { status: "ready", project, schedule, model };
  } catch (e) {
    return {
      status: "error",
      message: `The data loaded but could not be scheduled: ${String((e as Error).message)}`,
    };
  }
}

export default function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [zoom, setZoom] = useState<Zoom>("month");
  // The pre-paint script in index.html already stamped data-mode; seed state
  // from it so the toggle is in sync without a flash.
  const [mode, setMode] = useState<Mode>(() => readMode(document.documentElement));
  const zoomRef = useRef<Zoom>("month");
  const viewRef = useRef<GanttView | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    load().then((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Authoritative resolve on mount (URL ?mode= wins and persists) — idempotent
  // with the pre-paint stamp. The chart recolours live off the CSS vars, so a
  // mode flip never rebuilds it.
  useEffect(() => {
    const resolved = resolveMode(window.location.search, window.localStorage);
    applyMode(resolved, document.documentElement, window.localStorage);
    setMode(resolved);
  }, []);

  const toggleMode = () => {
    const next = otherMode(mode);
    applyMode(next, document.documentElement, window.localStorage);
    setMode(next);
  };

  const model = state.status === "ready" ? state.model : null;
  const hasChart = !!model && model.hasSchedule && model.rows.length > 0;

  // Create / tear down the DHTMLX view whenever the model changes. Zoom changes
  // go through setZoom on the live view, so they don't rebuild the chart.
  useEffect(() => {
    if (!hasChart || !containerRef.current || !model) return;
    const view = createGanttView(containerRef.current);
    view.render(model, zoomRef.current);
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [hasChart, model]);

  const onZoom = (z: Zoom) => {
    setZoom(z);
    zoomRef.current = z;
    viewRef.current?.setZoom(z);
  };

  if (state.status === "loading") {
    return (
      <div className="fl-app">
        <Header mode={mode} onToggleMode={toggleMode} />
        <div className="fl-state">
          <div>Acquiring signal…</div>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="fl-app">
        <Header mode={mode} onToggleMode={toggleMode} />
        <div className="fl-state">
          <div className="fl-card">
            <h2>Couldn't load the timeline</h2>
            <p>{state.message}</p>
          </div>
        </div>
      </div>
    );
  }

  const { project, schedule } = state;
  return (
    <div className="fl-app">
      <Header project={project} mode={mode} onToggleMode={toggleMode} />
      <Toolbar zoom={zoom} onZoom={onZoom} />
      <Banner issues={project.issues} conflicts={schedule.conflicts} />
      {hasChart ? (
        <div className="fl-chart">
          <div className="fl-chart-inner" ref={containerRef} />
        </div>
      ) : (
        <div className="fl-state">
          <div className="fl-card">
            <h2>The schedule can't be drawn yet</h2>
            <p>
              A conflict in the plan is blocking the whole schedule. See the
              banner above for the exact fix — once it's resolved the chart comes
              back automatically.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Header({
  project,
  mode,
  onToggleMode,
}: {
  project?: ProjectData;
  mode: Mode;
  onToggleMode: () => void;
}) {
  const target = otherMode(mode);
  return (
    <header className="fl-header">
      <div>
        <h1>First Light</h1>
        <div className="fl-sub">
          {project
            ? `${project.projectName} · ${project.team}`
            : "ND Experimental Propulsion — mission timeline"}
        </div>
      </div>
      <button
        type="button"
        className="fl-mode-toggle"
        onClick={onToggleMode}
        aria-label={`Switch to ${target} mode`}
        title={`Switch to ${target} mode`}
      >
        {mode === "dark" ? "☀ Light" : "☾ Dark"}
      </button>
    </header>
  );
}

const ZOOMS: { id: Zoom; label: string }[] = [
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "quarter", label: "Quarter" },
];

function Toolbar({ zoom, onZoom }: { zoom: Zoom; onZoom: (z: Zoom) => void }) {
  return (
    <div className="fl-toolbar">
      <div className="fl-seg" role="group" aria-label="Zoom level">
        {ZOOMS.map((z) => (
          <button
            key={z.id}
            aria-pressed={zoom === z.id}
            onClick={() => onZoom(z.id)}
          >
            {z.label}
          </button>
        ))}
      </div>
      {/* The legend is the STATE vocabulary (§7); squad identity lives in the
          grid chips, not here. Ordered from the gold thread outward to quiet. */}
      <div className="fl-legend">
        <span className="fl-leg-item">
          <span className="fl-leg-sw fl-leg-crit" />
          Critical path
        </span>
        <span className="fl-leg-item">
          <span className="fl-leg-sw fl-leg-active" />
          In progress
        </span>
        <span className="fl-leg-item">
          <span className="fl-leg-sw fl-leg-notstarted" />
          Not started
        </span>
        <span className="fl-leg-item">
          <span className="fl-leg-sw fl-leg-done" />
          Done
        </span>
        <span className="fl-leg-item">
          <span className="fl-leg-sw fl-leg-guess" />
          Guess
        </span>
        <span className="fl-leg-item">
          <span className="fl-leg-glyph">◇</span> Review gate
        </span>
        <span className="fl-leg-item">
          <span className="fl-leg-glyph">◆</span> Test gate
        </span>
      </div>
    </div>
  );
}

/** Turn an engine Conflict into a one-line, plain-language fix. */
function conflictLine(c: Conflict): { severity: "error" | "warning"; text: string } {
  switch (c.kind) {
    case "cycle":
      return {
        severity: "error",
        text: `Circular dependency: ${[...c.tasks, c.tasks[0]].join(" → ")} — fix the loop to restore the schedule.`,
      };
    case "hard-deadline-miss":
      return {
        severity: "error",
        text: `${c.task} misses its hard deadline (${c.deadline}) by ${c.overrunDays} day${c.overrunDays === 1 ? "" : "s"}.`,
      };
    case "pin-conflict":
      return {
        severity: "error",
        text: `${c.task} is pinned to ${c.pinnedStart} but can't start before ${c.earliestPossible} — its dependencies push it later.`,
      };
    case "missing-dependency":
      return {
        severity: "warning",
        text: `${c.task} depends on "${c.missing}", which doesn't exist — that dependency was ignored.`,
      };
  }
}

function Banner({
  issues,
  conflicts,
}: {
  issues: DataIssue[];
  conflicts: Conflict[];
}) {
  const [open, setOpen] = useState(false);

  const conflictEntries = conflicts.map(conflictLine);
  const entries = [
    ...issues.map((i) => ({ severity: i.severity, text: i.message })),
    ...conflictEntries,
  ];
  if (entries.length === 0) return null;

  // Errors before warnings.
  entries.sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1,
  );

  const errorCount =
    issues.filter((i) => i.severity === "error").length +
    conflictEntries.filter((c) => c.severity === "error").length;
  const anyError = errorCount > 0;

  const dataN = issues.length;
  const confN = conflicts.length;
  const summary = [
    dataN > 0 ? `${dataN} data issue${dataN === 1 ? "" : "s"}` : null,
    confN > 0 ? `${confN} schedule conflict${confN === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={`fl-banner ${anyError ? "" : "fl-banner-warn"}`}>
      <div
        className="fl-banner-summary"
        onClick={() => setOpen((o) => !o)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen((o) => !o);
        }}
      >
        <span className="fl-banner-dot" />
        <span>{summary}</span>
        <span className="fl-banner-toggle">{open ? "hide" : "show"}</span>
      </div>
      {open && (
        <ul className="fl-banner-list">
          {entries.map((e, i) => (
            <li key={i} className={`fl-issue-${e.severity}`}>
              <b>{e.severity === "error" ? "Error" : "Warning"}:</b> {e.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
