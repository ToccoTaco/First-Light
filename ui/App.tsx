// ui/App.tsx — the viewer + quick-editing shell (Phase 3.1 + 3.2).
//
// Fetches the five data files, runs them through the SAME storage + engine
// pipeline the tests use, builds a renderer-agnostic ChartModel, and hands it to
// the DHTMLX adapter.
//
// Phase 3.2 working state: the app holds the RAW loaded file texts plus a map of
// per-task patches (ui/edit-model.ts). Every edit gesture becomes a patch, the
// patched task list re-runs through computeSchedule, and the chart re-renders
// immediately — downstream bars visibly move. Nothing persists until Save, which
// replays each dirty file's patches onto its ORIGINAL text (comment-preserving)
// and commits it via the GitHub Contents API.
//
// FETCH-TIME SHAS — a deliberate design decision: the initial load fetches the
// static files served by the dev server / GitHub Pages, NOT the GitHub API, so
// reads stay free and unauthenticated (the Phase-0 call). That means we hold no
// blob sha at load time. Save therefore does a just-in-time `loadFile` (GitHub
// API) per dirty file to get {sha, text}; if that remote text differs from the
// text we originally loaded, it is treated as a conflict BEFORE any patch is
// applied — same UX as a mid-save conflict. One extra API GET per file per save.

import { useEffect, useMemo, useRef, useState } from "react";
import { computeSchedule } from "../engine";
import type {
  Conflict,
  ISODate,
  ScheduleResult,
  Status,
  Task,
} from "../engine/types";
import { mergeProject, type SourceFile } from "../storage/merge";
import type { DataIssue, ProjectData, Squad } from "../storage/types";
import {
  loadFile,
  saveFile,
  type GitHubError,
  type LoadedFile,
} from "../storage/github";
import {
  getSettings,
  setSettings,
  type GitHubSettings,
} from "../storage/settings";
import {
  buildChartModel,
  filterChartModel,
  type ChartModel,
  type ChartRow,
  type ChartView,
} from "./chart-model";
import {
  accumulate,
  applyEditsToTasks,
  editDirtyCount,
  fileForTaskId,
  isEditable as isEditableRow,
  makeTaskId,
  movePatch,
  newSquadTask,
  nextStatus,
  removeTaskFromState,
  resizePatch,
  saveAll,
  squadOfTaskId,
  type PatchMap,
  type TaskPatch,
} from "./edit-model";
import { NEUTRAL_COLOR } from "./chart-model";
import { EditPanel } from "./edit-panel";
import {
  createGanttView,
  type EditEvents,
  type GanttView,
  type GhostBar,
  type Zoom,
} from "./gantt-adapter";
import { applyMode, otherMode, readMode, resolveMode, type Mode } from "./mode";
import { loadMeta, type Meta } from "../storage/meta";
import {
  Dashboard,
  baselineScheduleFromMeta,
  buildDashboard,
  type DashboardModel,
} from "../dashboard";
import "./app.css";

// The manifest is a constant: project file first (its order is the tie-breaker
// for duplicate ids), then one file per squad.
const BASE = import.meta.env.BASE_URL;
const PROJECT_FILE_URL = `${BASE}data/project.yaml`;
const SQUAD_FILE_URLS = [
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

/** "data/subgroups/engines.yaml" → "engines.yaml" (for human-facing messages). */
function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
/** "2026-08-14" → "Aug 14" for toast copy. */
function shortDate(iso: ISODate): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
}

const STATUS_WORD: Record<Status, string> = {
  "not-started": "Not started",
  "in-progress": "In progress",
  blocked: "Blocked",
  done: "Done",
};

// ── view filter persistence (§9: the view remembers, "default = own squad") ──────
const VIEW_KEY = "fl-view";
/** Serialize a ChartView to a stable localStorage token. */
function viewToken(v: ChartView): string {
  return v.kind === "squad" ? `squad:${v.squadId}` : v.kind;
}
/** Parse a stored token back to a ChartView (unknown → everything, first-run). */
function parseView(token: string | null): ChartView {
  if (token === "spine") return { kind: "spine" };
  if (token && token.startsWith("squad:"))
    return { kind: "squad", squadId: token.slice("squad:".length) };
  return { kind: "everything" };
}

// ── screen persistence (Phase 4): Dashboard | Chart, dashboard is the landing ──
const SCREEN_KEY = "fl-screen";
type Screen = "dashboard" | "chart";
/** Parse a stored token to a Screen — anything unknown lands on the dashboard. */
function parseScreen(token: string | null): Screen {
  return token === "chart" ? "chart" : "dashboard";
}

interface Ready {
  status: "ready";
  files: SourceFile[]; // the raw texts as loaded (the save-flow base)
  fetchIssues: DataIssue[];
}
type LoadState =
  { status: "loading" } | { status: "error"; message: string } | Ready;

/** One failed file save, kept on screen until dismissed / resolved. */
interface SaveIssue {
  path: string;
  error: GitHubError;
}

/** A transient toast + its kind (drives the ✓ / ⚠ / › glyph and tint). */
type ToastKind = "info" | "success" | "warn";
interface Toast {
  text: string;
  kind: ToastKind;
}
/** The per-kind glyph (unicode, no icon lib). */
const TOAST_ICON: Record<ToastKind, string> = {
  success: "✓",
  warn: "⚠",
  info: "›",
};

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
    projectText = await fetchText(PROJECT_FILE_URL);
  } catch {
    return {
      status: "error",
      message: `Could not load ${repoPath(PROJECT_FILE_URL)}. The viewer needs the project file to draw the mission spine.`,
    };
  }

  const files: SourceFile[] = [
    { path: repoPath(PROJECT_FILE_URL), text: projectText },
  ];
  const fetchIssues: DataIssue[] = [];

  // Squad files degrade gracefully: a failed fetch becomes a banner entry, and
  // the rest of the project still renders (mirrors storage's "never fatal" rule).
  const results = await Promise.allSettled(SQUAD_FILE_URLS.map(fetchText));
  results.forEach((r, i) => {
    const path = repoPath(SQUAD_FILE_URLS[i]);
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

  return { status: "ready", files, fetchIssues };
}

/** Everything derived from the loaded texts + the current patches. */
interface Working {
  project: ProjectData; // carries the PATCHED task list (the working graph)
  schedule: ScheduleResult;
  model: ChartModel;
  rowById: Map<string, ChartRow>;
  taskById: Map<string, Task>; // patched tasks
  squadIds: string[];
}

export default function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [patches, setPatches] = useState<PatchMap>({});
  const [added, setAdded] = useState<Task[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ChartView>(() =>
    parseView(window.localStorage.getItem(VIEW_KEY)),
  );
  // Phase 4: which screen is showing. Fresh visits land on the Dashboard (§9 —
  // the landing view); the choice persists under its own key.
  const [screen, setScreen] = useState<Screen>(() =>
    parseScreen(window.localStorage.getItem(SCREEN_KEY)),
  );
  // Build-time git metadata (staleness + captured baseline files). Null on a
  // dev machine that never ran `npm run meta` — every consumer degrades.
  const [meta, setMeta] = useState<Meta | null>(null);
  // Chart-side baseline ghost-bar toggle (deliverable 8). Off by default.
  const [showBaseline, setShowBaseline] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveIssues, setSaveIssues] = useState<SaveIssue[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ghSettings, setGhSettings] = useState<GitHubSettings | null>(() =>
    getSettings(window.localStorage),
  );
  const [zoom, setZoom] = useState<Zoom>("month");
  // The pre-paint script in index.html already stamped data-mode; seed state
  // from it so the toggle is in sync without a flash.
  const [mode, setMode] = useState<Mode>(() =>
    readMode(document.documentElement),
  );
  const zoomRef = useRef<Zoom>("month");
  const viewRef = useRef<GanttView | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const todayRef = useRef<ISODate>(todayLocalISO());
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    load().then((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Meta loads independently of the data files: the dashboard renders fine
  // without it (staleness/baseline tiles show their honest empty states).
  useEffect(() => {
    let alive = true;
    loadMeta().then((m) => {
      if (alive) setMeta(m);
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

  const showToast = (text: string, kind: ToastKind = "info") => {
    setToast({ text, kind });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  };

  // ── working state: loaded texts + patches → schedule → chart model ──────────
  // THE auto-reschedule loop: any patch change re-merges, re-computes, and
  // re-renders — downstream bars move the instant an edit lands.
  const working: Working | null = useMemo(() => {
    if (state.status !== "ready") return null;
    const merged = mergeProject(state.files, todayRef.current);
    const issues = [...merged.issues, ...state.fetchIssues];
    const tasks = applyEditsToTasks(merged.tasks, { patches, added, removed });
    const project: ProjectData = { ...merged, tasks, issues };
    const schedule = computeSchedule(tasks, project.config);
    const model = buildChartModel(project, schedule);
    return {
      project,
      schedule,
      model,
      rowById: new Map(model.rows.map((r) => [r.id, r])),
      taskById: new Map(tasks.map((t) => [t.id, t])),
      squadIds: project.squads.map((s) => s.id),
    };
  }, [state, patches, added, removed]);

  // The adapter's edit events are created ONCE and read the latest working
  // state through this ref — the DHTMLX view survives every re-render.
  const workingRef = useRef<Working | null>(null);
  workingRef.current = working;

  // ── Phase 4 derived state ────────────────────────────────────────────────────
  // The baseline schedule: the SAME merge+compute pipeline, run over the data
  // files as captured at the newest baseline/* tag, on the same `today` — so the
  // diff against the current schedule is purely a data delta (§6.4).
  const baseline = useMemo(
    () => baselineScheduleFromMeta(meta, todayRef.current),
    [meta],
  );

  // The whole landing view is one pure model (dashboard/dashboard-model.ts);
  // Dashboard.tsx just draws it.
  const dashModel: DashboardModel | null = useMemo(
    () =>
      working
        ? buildDashboard(
            working.project,
            working.schedule,
            meta,
            todayRef.current,
          )
        : null,
    [working, meta],
  );

  // Ghost bars (deliverable 8): each CURRENT leaf task's BASELINE dates. Tasks
  // absent from the baseline get no ghost; diamonds/summaries stay clean (a
  // zero-width ghost or a bracket echo would be noise, not signal).
  const ghostBars: GhostBar[] | null = useMemo(() => {
    if (!showBaseline || !baseline || !working) return null;
    const bars: GhostBar[] = [];
    for (const row of working.model.rows) {
      if (row.kind !== "task") continue;
      const b = baseline.schedule.tasks[row.id];
      if (!b) continue;
      bars.push({
        id: row.id,
        startISO: b.earliestStart,
        endISO: b.earliestFinish,
      });
    }
    return bars;
  }, [showBaseline, baseline, working]);
  const ghostRef = useRef<GhostBar[] | null>(null);
  ghostRef.current = ghostBars;

  const editEvents = useMemo<EditEvents>(() => {
    const applyEdit = (id: string, patch: TaskPatch) =>
      setPatches((prev) => accumulate(prev, id, patch));
    const nameOf = (id: string) =>
      workingRef.current?.taskById.get(id)?.name ?? id;

    return {
      isEditable(id) {
        const row = workingRef.current?.rowById.get(id);
        return row ? isEditableRow(row) : false;
      },
      onMove(id, newStartISO) {
        // Dragging IS pinning (§8 quick tier): the honest semantic of "I put it
        // on this date". Duration is preserved; the auto/pinned release toggle
        // arrives with the full editor. Surface the consequence lightly.
        applyEdit(id, movePatch(newStartISO));
        showToast(
          `${nameOf(id)} pinned to ${shortDate(newStartISO)} — unsaved`,
        );
      },
      onResize(id, days) {
        applyEdit(id, resizePatch(days));
        showToast(
          `${nameOf(id)} set to ${days} day${days === 1 ? "" : "s"} — unsaved`,
        );
      },
      onStatusClick(id) {
        // Working tasks already carry their patches, so the task's own status
        // IS the effective one to cycle from.
        const task = workingRef.current?.taskById.get(id);
        const next = nextStatus(task?.status ?? "not-started");
        applyEdit(id, { status: next });
        showToast(`${nameOf(id)} → ${STATUS_WORD[next]} — unsaved`);
      },
      onReadOnlyAttempt(id) {
        // A drag on a bar the quick tier won't move — nudge toward the panel,
        // which now DOES edit spine gates, summaries roll up, etc.
        const kind = workingRef.current?.rowById.get(id)?.kind;
        if (kind === "summary" || kind === "group") {
          showToast(
            "Summary rows roll up from their tasks — open a task beneath to edit.",
          );
        } else {
          showToast("Open the side panel (click the row) to edit this.");
        }
      },
      onRowSelect(id) {
        setSelectedId(id);
      },
    };
  }, []);

  // The chart draws the FILTERED model (§9 squad/spine/everything views); the
  // panel and dirty state read the FULL working model, so a filtered-out task
  // still edits and still saves.
  const model = useMemo(
    () => (working ? filterChartModel(working.model, view) : null),
    [working, view],
  );
  const hasChart =
    !!model && working!.model.hasSchedule && model.rows.length > 0;
  const modelRef = useRef<ChartModel | null>(null);

  // The panel opens on the model row when present, or — when a cycle has blanked
  // the schedule so no rows exist — on a minimal row synthesized from the task,
  // so the loop-causing chip stays reachable and removable.
  const selectedRow: ChartRow | undefined = useMemo(() => {
    if (selectedId === null || !working) return undefined;
    const real = working.rowById.get(selectedId);
    if (real) return real;
    const t = working.taskById.get(selectedId);
    if (!t) return undefined;
    const squadId = squadOfTaskId(t.id, working.squadIds);
    const kind: ChartRow["kind"] =
      t.gate === "review"
        ? "gate-review"
        : t.gate === "test"
          ? "gate-test"
          : t.milestone
            ? "milestone"
            : "task";
    return {
      id: t.id,
      name: t.name,
      parentId: null,
      startISO: "",
      endISO: "",
      kind,
      squadId,
      squadColor: NEUTRAL_COLOR,
      critical: false,
      slack: 0,
      status: t.status ?? "not-started",
      percent: t.percent ?? 0,
      confidence: t.confidence,
      isOpen: true,
    };
  }, [selectedId, working]);
  const panelOpen = !!selectedRow;

  // Esc closes the panel.
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  // The chart container width changes when the panel opens/closes; DHTMLX reflows
  // on a window resize event, so nudge it (next frame, after layout settles).
  useEffect(() => {
    const id = window.requestAnimationFrame(() =>
      window.dispatchEvent(new Event("resize")),
    );
    return () => window.cancelAnimationFrame(id);
  }, [panelOpen]);

  // Persist the view selection so it's remembered next visit (§9).
  const onView = (v: ChartView) => {
    setView(v);
    window.localStorage.setItem(VIEW_KEY, viewToken(v));
  };

  // Persist the screen choice; fresh profiles land on the Dashboard (§9).
  const onScreen = (s: Screen) => {
    setScreen(s);
    window.localStorage.setItem(SCREEN_KEY, s);
  };

  // "Review spine →" (§9): the one-slide version — jump to the Chart tab with
  // the Spine view preselected, both persisted through the normal setters.
  const onReviewSpine = () => {
    onView({ kind: "spine" });
    onScreen("chart");
  };

  // Create / tear down the DHTMLX view when a chart appears/disappears; edits
  // re-render the SAME view (scroll preserved) via the model effect below.
  // Phase 4: the chart lives behind the Chart tab, so its container only exists
  // when that screen is showing — `screen` gates (and re-runs) this effect.
  useEffect(() => {
    if (screen !== "chart" || !hasChart || !containerRef.current) return;
    const view = createGanttView(containerRef.current, editEvents);
    viewRef.current = view;
    if (modelRef.current) view.render(modelRef.current, zoomRef.current);
    view.setGhosts(ghostRef.current); // restore the baseline overlay on re-mount
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [screen, hasChart, editEvents]);

  useEffect(() => {
    modelRef.current = model;
    if (model && viewRef.current)
      viewRef.current.render(model, zoomRef.current);
  }, [model]);

  // Push baseline ghosts into the live view whenever the toggle / data changes.
  useEffect(() => {
    viewRef.current?.setGhosts(ghostBars);
  }, [ghostBars]);

  const onZoom = (z: Zoom) => {
    setZoom(z);
    zoomRef.current = z;
    viewRef.current?.setZoom(z);
  };

  // ── save / discard ───────────────────────────────────────────────────────────

  const dirty = editDirtyCount({ patches, added, removed });
  const hasToken = !!ghSettings?.token.trim();

  const onDiscard = () => {
    setPatches({});
    setAdded([]);
    setRemoved([]);
    setSelectedId(null);
    setSaveIssues([]);
    showToast("Unsaved changes discarded");
  };

  // ── panel edit callbacks (instant-apply into working state) ──────────────────
  const onPanelPatch = (id: string, patch: TaskPatch) =>
    setPatches((prev) => accumulate(prev, id, patch));

  const onAddTask = (squadId: string) => {
    const existing = new Set(workingRef.current?.taskById.keys() ?? []);
    const name = "New task";
    const id = makeTaskId(squadId, name, existing);
    setAdded((a) => [...a, newSquadTask(id, name)]);
    setSelectedId(id);
    showToast(`Added a task to ${squadId} — refine it in the panel`);
  };

  const onDeleteTask = (id: string) => {
    const next = removeTaskFromState({ patches, added, removed }, id);
    setPatches(next.patches);
    setAdded(next.added);
    setRemoved(next.removed);
    setSelectedId(null);
    showToast("Task deleted — unsaved");
  };

  const onSave = async () => {
    if (saving || dirty === 0 || state.status !== "ready" || !working) return;
    const s = getSettings(window.localStorage);
    if (!s || !s.token.trim()) {
      showToast("Add a GitHub token in Settings to save", "warn");
      return;
    }
    setSaving(true);
    setSaveIssues([]);
    const originalTexts = Object.fromEntries(
      state.files.map((f) => [f.path, f.text]),
    );
    const outcome = await saveAll(
      {
        patches,
        added,
        removed,
        originalTexts,
        squadIds: working.squadIds,
        target: { owner: s.owner, repo: s.repo, branch: s.branch },
        token: s.token,
      },
      { loadFile, saveFile },
    );
    setSaving(false);

    if (outcome.noToken) {
      showToast("Add a GitHub token in Settings to save", "warn");
      return;
    }

    // Successes: the committed text becomes the new base and its tasks' patches
    // clear — the chart doesn't move, because the patched graph IS the committed
    // graph. Failures: edits stay dirty; the error panel explains in plain
    // language. The working state survives EVERY failure path.
    const savedTaskIds = new Set<string>();
    const newTexts: Record<string, string> = {};
    const failures: SaveIssue[] = [];
    for (const r of outcome.results) {
      if (r.ok) {
        newTexts[r.path] = r.newText!;
        for (const id of r.taskIds) savedTaskIds.add(id);
      } else {
        failures.push({ path: r.path, error: r.error! });
      }
    }
    if (savedTaskIds.size > 0) {
      setState((prev) =>
        prev.status === "ready"
          ? {
              ...prev,
              files: prev.files.map((f) =>
                newTexts[f.path] !== undefined
                  ? { ...f, text: newTexts[f.path] }
                  : f,
              ),
            }
          : prev,
      );
      // Clear only what committed: patches, added tasks, and removed ids whose
      // ids were covered by a successful file save. The rest stays dirty.
      setPatches((prev) => {
        const next: PatchMap = {};
        for (const [id, p] of Object.entries(prev)) {
          if (!savedTaskIds.has(id)) next[id] = p;
        }
        return next;
      });
      setAdded((prev) => prev.filter((t) => !savedTaskIds.has(t.id)));
      setRemoved((prev) => prev.filter((id) => !savedTaskIds.has(id)));
    }
    setSaveIssues(failures);
    if (failures.length === 0) {
      showToast(
        `Saved — ${savedTaskIds.size} change${savedTaskIds.size === 1 ? "" : "s"} committed`,
        "success",
      );
    }
  };

  // A conflict's "Reload" adopts the surfaced remote copy as the new base for
  // THAT file and drops that file's patches — other files' edits stay put. No
  // static re-fetch (Pages could still be serving the stale copy).
  const onReloadConflict = (path: string, remote: LoadedFile) => {
    setState((prev) =>
      prev.status === "ready"
        ? {
            ...prev,
            files: prev.files.map((f) =>
              f.path === path ? { ...f, text: remote.text } : f,
            ),
          }
        : prev,
    );
    const squadIds = workingRef.current?.squadIds ?? [];
    setPatches((prev) => {
      const next: PatchMap = {};
      for (const [id, p] of Object.entries(prev)) {
        if (fileForTaskId(id, squadIds) !== path) next[id] = p;
      }
      return next;
    });
    setAdded((prev) =>
      prev.filter((t) => fileForTaskId(t.id, squadIds) !== path),
    );
    setRemoved((prev) =>
      prev.filter((id) => fileForTaskId(id, squadIds) !== path),
    );
    setSaveIssues((prev) => prev.filter((i) => i.path !== path));
    showToast(`${baseName(path)} reloaded from GitHub — re-apply your edits`);
  };

  const onDismissIssue = (path: string) =>
    setSaveIssues((prev) => prev.filter((i) => i.path !== path));

  // ── render ───────────────────────────────────────────────────────────────────

  if (state.status === "loading") {
    return (
      <div className="fl-app">
        <Header
          mode={mode}
          onToggleMode={toggleMode}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <div className="fl-state">
          <div>Acquiring signal…</div>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="fl-app">
        <Header
          mode={mode}
          onToggleMode={toggleMode}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <div className="fl-state">
          <div className="fl-card">
            <h2>Couldn't load the timeline</h2>
            <p>{state.message}</p>
          </div>
        </div>
      </div>
    );
  }

  const { project, schedule } = working!;
  return (
    <div
      className={`fl-app${screen === "dashboard" ? " fl-on-dashboard" : ""}`}
    >
      <Header
        project={project}
        mode={mode}
        screen={screen}
        onScreen={onScreen}
        onToggleMode={toggleMode}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {screen === "dashboard" ? (
        // ── the landing view (Phase 4) — a thin render of the pure model ──────
        dashModel && (
          <Dashboard model={dashModel} onReviewSpine={onReviewSpine} />
        )
      ) : (
        <>
          <Toolbar
            zoom={zoom}
            onZoom={onZoom}
            view={view}
            onView={onView}
            squads={project.squads}
            onAddTask={onAddTask}
            dirty={dirty}
            saving={saving}
            hasToken={hasToken}
            onSave={onSave}
            onDiscard={onDiscard}
            baselineTag={baseline?.tag ?? null}
            showBaseline={showBaseline}
            onToggleBaseline={() => setShowBaseline((b) => !b)}
          />
          <SaveErrors
            issues={saveIssues}
            settings={ghSettings}
            onReload={onReloadConflict}
            onDismiss={onDismissIssue}
          />
          <Banner issues={project.issues} conflicts={schedule.conflicts} />
          <div className={`fl-main${panelOpen ? " fl-main-panel" : ""}`}>
            {hasChart ? (
              <div className="fl-chart">
                <div className="fl-chart-inner" ref={containerRef} />
              </div>
            ) : (
              <div className="fl-state">
                <div className="fl-card">
                  <h2>The schedule can't be drawn yet</h2>
                  <p>
                    A conflict in the plan is blocking the whole schedule. See
                    the banner above for the exact fix — once it's resolved the
                    chart comes back automatically.
                  </p>
                </div>
              </div>
            )}
            {panelOpen && working && selectedId && selectedRow && (
              <EditPanel
                row={selectedRow}
                task={working.taskById.get(selectedId)}
                sched={working.schedule.tasks[selectedId]}
                allTasks={working.project.tasks}
                squads={working.project.squads}
                squadIds={working.squadIds}
                conflicts={working.schedule.conflicts}
                onPatch={onPanelPatch}
                onAdd={onAddTask}
                onDelete={onDeleteTask}
                onClose={() => setSelectedId(null)}
              />
            )}
          </div>
        </>
      )}
      {toast && (
        <div className={`fl-toast fl-toast-${toast.kind}`} role="status">
          <span className="fl-toast-icon" aria-hidden="true">
            {TOAST_ICON[toast.kind]}
          </span>
          <span>{toast.text}</span>
        </div>
      )}
      {settingsOpen && (
        <SettingsModal
          initial={ghSettings}
          onClose={() => setSettingsOpen(false)}
          onSave={(s) => {
            setSettings(window.localStorage, s);
            setGhSettings(s);
            setSettingsOpen(false);
            showToast(
              "Settings saved — the token stays in this browser",
              "success",
            );
          }}
        />
      )}
    </div>
  );
}

function Header({
  project,
  mode,
  screen,
  onScreen,
  onToggleMode,
  onOpenSettings,
}: {
  project?: ProjectData;
  mode: Mode;
  screen?: Screen; // omitted while loading / on error — no tabs then
  onScreen?: (s: Screen) => void;
  onToggleMode: () => void;
  onOpenSettings: () => void;
}) {
  const target = otherMode(mode);
  return (
    <header className="fl-header">
      <div>
        <h1>First Light</h1>
        <div className="fl-sub">
          {project ? project.team : "Notre Dame Experimental Propulsion"}
        </div>
      </div>
      <div className="fl-header-actions">
        {/* Phase 4: the two-view shell. Quiet segmented control — same inverted-
            chip vocabulary as the toolbar segs, never gold. */}
        {screen && onScreen && (
          <div
            className="fl-seg fl-screen-seg"
            role="group"
            aria-label="Screen"
          >
            <button
              aria-pressed={screen === "dashboard"}
              onClick={() => onScreen("dashboard")}
            >
              Dashboard
            </button>
            <button
              aria-pressed={screen === "chart"}
              onClick={() => onScreen("chart")}
            >
              Chart
            </button>
          </div>
        )}
        <button
          type="button"
          className="fl-mode-toggle"
          onClick={onOpenSettings}
          aria-label="Open settings"
          title="GitHub repo + token for saving"
        >
          Settings
        </button>
        <button
          type="button"
          className="fl-mode-toggle"
          onClick={onToggleMode}
          aria-label={`Switch to ${target} mode`}
          title={`Switch to ${target} mode`}
        >
          {mode === "dark" ? "☀ Light" : "☾ Dark"}
        </button>
      </div>
    </header>
  );
}

const ZOOMS: { id: Zoom; label: string }[] = [
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "quarter", label: "Quarter" },
];

function Toolbar({
  zoom,
  onZoom,
  view,
  onView,
  squads,
  onAddTask,
  dirty,
  saving,
  hasToken,
  onSave,
  onDiscard,
  baselineTag,
  showBaseline,
  onToggleBaseline,
}: {
  zoom: Zoom;
  onZoom: (z: Zoom) => void;
  view: ChartView;
  onView: (v: ChartView) => void;
  squads: Squad[];
  onAddTask: (squadId: string) => void;
  dirty: number;
  saving: boolean;
  hasToken: boolean;
  onSave: () => void;
  onDiscard: () => void;
  baselineTag: string | null; // null = no baseline in meta → no toggle at all
  showBaseline: boolean;
  onToggleBaseline: () => void;
}) {
  const canSave = dirty > 0 && hasToken && !saving;
  const activeToken =
    view.kind === "squad" ? `squad:${view.squadId}` : view.kind;
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
      {/* §9 view filter: Spine · one per squad · Everything. Quiet — no gold. */}
      <div className="fl-seg fl-view-seg" role="group" aria-label="View">
        <button
          aria-pressed={activeToken === "spine"}
          onClick={() => onView({ kind: "spine" })}
        >
          Spine
        </button>
        {squads.map((s) => (
          <button
            key={s.id}
            aria-pressed={activeToken === `squad:${s.id}`}
            onClick={() => onView({ kind: "squad", squadId: s.id })}
          >
            {s.name}
          </button>
        ))}
        <button
          aria-pressed={activeToken === "everything"}
          onClick={() => onView({ kind: "everything" })}
        >
          Everything
        </button>
      </div>
      {view.kind === "squad" && (
        <button
          type="button"
          className="fl-discard fl-add-task"
          onClick={() => onAddTask(view.squadId)}
          title="Add a task to this squad"
        >
          + Add task
        </button>
      )}
      {/* Baseline ghost bars (Phase 4, deliverable 8): a quiet toggle, present
          only when a baseline schedule exists. Ghosts are hairline outlines at
          each task's baseline dates — the dashboard carries the headline. */}
      {baselineTag !== null && (
        <button
          type="button"
          className="fl-baseline-toggle"
          aria-pressed={showBaseline}
          onClick={onToggleBaseline}
          title={`Overlay ghost bars at each task's dates as of ${baselineTag}`}
        >
          Baseline
        </button>
      )}
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
      {/* Save area — the Save button is THE one gold element on this screen
          (§1/§8: the single primary action). Everything around it stays quiet:
          mono dirty note, low-emphasis Discard, plain hint when no token. */}
      <div className="fl-save-area">
        {dirty > 0 && (
          <span className="fl-dirty-note">
            {dirty} unsaved change{dirty === 1 ? "" : "s"}
          </span>
        )}
        {dirty > 0 && !hasToken && (
          <span className="fl-save-hint">
            Add a GitHub token in Settings to save
          </span>
        )}
        {dirty > 0 && (
          <button type="button" className="fl-discard" onClick={onDiscard}>
            Discard
          </button>
        )}
        <button
          type="button"
          className="fl-save"
          disabled={!canSave}
          onClick={onSave}
          title={
            !hasToken && dirty > 0
              ? "Add a GitHub token in Settings to save"
              : undefined
          }
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/**
 * Plain-language line for one failed file save — the Phase-2 GitHubError union
 * finally meeting users. Every message keeps the same promise: your edits are
 * still here.
 */
function saveErrorLine(
  issue: SaveIssue,
  settings: GitHubSettings | null,
): string {
  const file = baseName(issue.path);
  const repo = settings ? `${settings.owner}/${settings.repo}` : "the repo";
  const e = issue.error;
  switch (e.kind) {
    case "no-token":
      return "Add a GitHub token in Settings to save.";
    case "auth":
      return "GitHub rejected the token — it may be invalid, expired, or revoked. Update it in Settings.";
    case "forbidden":
      return `The token can't push to ${repo}. It needs access to that repo with Contents: Read and write permission.`;
    case "rate-limited":
      return `GitHub is rate-limiting requests right now${
        e.resetAt
          ? ` — the limit lifts at ${new Date(e.resetAt).toLocaleTimeString()}`
          : ""
      }. Your edits are kept here; try again shortly.`;
    case "not-found":
      return `GitHub can't find ${repo} (branch "${settings?.branch ?? "?"}") — or the token can't see it. Check owner, repo and branch in Settings.`;
    case "conflict":
      return `${file} changed on GitHub since you loaded. Your edits are kept here — Reload to get the latest (your unsaved edits to this file will need re-applying), or retry after checking with your squad.`;
    case "network":
      return "Couldn't reach GitHub — check your connection and try again. Your edits are kept here.";
    case "unexpected":
      return `GitHub returned an unexpected error (HTTP ${e.status}). Your edits are kept here — try again.`;
  }
}

function SaveErrors({
  issues,
  settings,
  onReload,
  onDismiss,
}: {
  issues: SaveIssue[];
  settings: GitHubSettings | null;
  onReload: (path: string, remote: LoadedFile) => void;
  onDismiss: (path: string) => void;
}) {
  if (issues.length === 0) return null;
  return (
    <div className="fl-save-errors">
      {issues.map((issue) => (
        <div key={issue.path} className="fl-save-error">
          <span className="fl-save-error-text">
            <b>Couldn't save {baseName(issue.path)}:</b>{" "}
            {saveErrorLine(issue, settings)}
          </span>
          <span className="fl-save-error-actions">
            {issue.error.kind === "conflict" && (
              <button
                type="button"
                className="fl-discard"
                onClick={() =>
                  onReload(
                    issue.path,
                    (issue.error as { kind: "conflict"; remote: LoadedFile })
                      .remote,
                  )
                }
              >
                Reload
              </button>
            )}
            <button
              type="button"
              className="fl-discard"
              onClick={() => onDismiss(issue.path)}
            >
              Dismiss
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Minimal write-back settings (the Phase-0 PAT fallback): owner / repo / branch /
 * fine-grained PAT, stored in this browser's localStorage only. Deliberately
 * quiet — no gold (Save on the toolbar is this screen's one primary action).
 */
function SettingsModal({
  initial,
  onClose,
  onSave,
}: {
  initial: GitHubSettings | null;
  onClose: () => void;
  onSave: (s: GitHubSettings) => void;
}) {
  const [owner, setOwner] = useState(initial?.owner ?? "");
  const [repo, setRepo] = useState(initial?.repo ?? "");
  const [branch, setBranch] = useState(initial?.branch ?? "main");
  const [token, setToken] = useState(initial?.token ?? "");

  return (
    <div
      className="fl-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="fl-modal" role="dialog" aria-label="GitHub settings">
        <h2>Settings</h2>
        <p className="fl-modal-note">Where saving commits your edits.</p>
        <div className="fl-modal-section">
          <div className="fl-modal-section-label">Repository</div>
          <label className="fl-field">
            <span>Owner</span>
            <input
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="nd-propulsion"
              autoComplete="off"
            />
          </label>
          <label className="fl-field">
            <span>Repo</span>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="first-light"
              autoComplete="off"
            />
          </label>
          <label className="fl-field">
            <span>Branch</span>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              autoComplete="off"
            />
          </label>
        </div>
        <div className="fl-modal-section">
          <div className="fl-modal-section-label">Access</div>
          <label className="fl-field">
            <span>Token</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="github_pat_…"
              autoComplete="off"
            />
          </label>
          <div className="fl-modal-lock">
            <span className="fl-modal-lock-glyph" aria-hidden="true">
              🔒
            </span>
            <span>
              Create a{" "}
              <a
                href="https://github.com/settings/personal-access-tokens"
                target="_blank"
                rel="noreferrer"
              >
                fine-grained token
              </a>{" "}
              with <b>Contents: Read and write</b> on this repo. It stays in
              this browser only — never committed, never sent anywhere but
              GitHub.
            </span>
          </div>
        </div>
        <div className="fl-modal-actions">
          <button type="button" className="fl-discard" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="fl-modal-save"
            onClick={() =>
              onSave({
                owner: owner.trim(),
                repo: repo.trim(),
                branch: branch.trim() || "main",
                token: token.trim(),
              })
            }
          >
            Save settings
          </button>
        </div>
      </div>
    </div>
  );
}

/** Turn an engine Conflict into a one-line, plain-language fix. */
function conflictLine(c: Conflict): {
  severity: "error" | "warning";
  text: string;
} {
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
