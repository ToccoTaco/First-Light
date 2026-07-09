// ui/edit-panel.tsx — the full editing panel (Phase 3.3, §8).
//
// A solid --surface-raised right-side panel that opens on a grid-row click and
// re-flows the chart beside it. It is the "full" tier of the two-tier editor:
// name, status, percent, confidence, the auto/pinned timing toggle, duration,
// milestone + hard-deadline toggles, and the dependency PICKER (chips + a
// searchable select, never drag-to-connect). Every change applies INSTANTLY —
// there is no Apply button; the toolbar's Save/Discard still govern persistence.
//
// This component is thin: it renders the working task's values and calls back
// with a TaskPatch (or an add/delete). Every real DECISION — eligibility, id
// minting, delete-blocking — lives as a pure, unit-tested function in
// edit-model.ts. The panel just wires them to inputs.

import { useMemo, useState, type ReactNode } from "react";
import type { Conflict, ScheduleResult, Status, Task } from "../engine/types";
import type { Squad } from "../storage/types";
import type { ChartRow } from "./chart-model";
import {
  depId,
  dependsOnIds,
  eligibleDependencyTargets,
  localId,
  milestonePatch,
  movePatch,
  releasePatch,
  removalPreview,
  resizePatch,
  squadOfTaskId,
  type Dependency,
  type TaskPatch,
} from "./edit-model";

const STATUSES: { id: Status; label: string }[] = [
  { id: "not-started", label: "Not started" },
  { id: "in-progress", label: "In progress" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
];

const CONFIDENCES: { id: "guess" | "estimate" | "firm"; label: string }[] = [
  { id: "guess", label: "Guess" },
  { id: "estimate", label: "Estimate" },
  { id: "firm", label: "Firm" },
];

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
function shortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  if (!m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}`;
}

/** Today as a local YYYY-MM-DD — the seed date when a task is first pinned. */
function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The duration a task's schedule carries (pinned milestones may omit it → 0). */
function durationOf(task: Task): number {
  return "duration" in task.schedule &&
    typeof task.schedule.duration === "number"
    ? task.schedule.duration
    : 0;
}

/** Compose a dependency in its LEANEST form: plain string unless FS/0 needs more. */
function makeDep(id: string, type: "FS" | "SS", lag: number): Dependency {
  if (type === "FS" && lag === 0) return id; // the 90% case stays a bare string
  const dep: { task: string; type?: "FS" | "SS"; lag?: number } = { task: id };
  if (type === "SS") dep.type = "SS";
  if (lag !== 0) dep.lag = lag;
  return dep;
}

function depType(dep: Dependency): "FS" | "SS" {
  return typeof dep === "string" ? "FS" : (dep.type ?? "FS");
}
function depLag(dep: Dependency): number {
  return typeof dep === "string" ? 0 : (dep.lag ?? 0);
}

export interface EditPanelProps {
  row: ChartRow; // the clicked row (always present)
  task: Task | undefined; // the working task (undefined for synthetic group rows)
  sched: ScheduleResult["tasks"][string] | undefined; // computed telemetry
  allTasks: Task[];
  squads: Squad[];
  squadIds: string[];
  conflicts: Conflict[];
  onPatch: (id: string, patch: TaskPatch) => void;
  onAdd: (squadId: string) => void;
  onAddSpine: (gate: "review" | "test") => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function EditPanel(props: EditPanelProps) {
  const { row, task, sched, squads, squadIds, conflicts } = props;

  const isGroup = row.kind === "group";
  const isSummary = row.kind === "summary";
  const isSpine = row.kind === "gate-review" || row.kind === "gate-test";
  const squadId = task ? squadOfTaskId(task.id, squadIds) : row.squadId;
  const isSquadLeaf = !!task && !isSpine && !isSummary && squadId !== null;

  // The header identity chip: a squad colour-dot + name for squad tasks, or a
  // neutral kind label for spine gates / rolled-up rows. It answers "what am I
  // editing?" at the top of the panel.
  const squad = squadId ? squads.find((s) => s.id === squadId) : undefined;
  const chip: { color?: string; label: string } = isSpine
    ? { label: row.kind === "gate-review" ? "Review gate" : "Test gate" }
    : isSummary
      ? { label: "Summary" }
      : isGroup
        ? { label: "Group" }
        : squad
          ? { color: squad.color, label: squad.name }
          : { label: "Task" };

  return (
    <aside className="fl-panel" aria-label="Task editor">
      <div className="fl-panel-head">
        <div className="fl-panel-head-main">
          <div className="fl-panel-title">{row.name}</div>
          <span className="fl-panel-chip">
            {chip.color && (
              <span
                className="fl-panel-chip-dot"
                style={{ background: chip.color }}
              />
            )}
            {chip.label}
          </span>
        </div>
        <button
          type="button"
          className="fl-panel-close"
          onClick={props.onClose}
          aria-label="Close panel"
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>

      {isGroup ? (
        <RolledUpInfo row={row} isSummary={false} />
      ) : isSummary ? (
        // A summary rolls up from its children and can't be edited field-by-field,
        // but it IS deletable — and deleting it cascades to its whole subtree.
        <div className="fl-panel-body">
          <RolledUpInfo row={row} isSummary={true} inline />
          {task && squadId !== null && (
            <DeleteControl {...props} task={task} noun="summary" />
          )}
        </div>
      ) : task ? (
        // The editor renders even when there's no computed telemetry (a cycle
        // blanks the schedule) — so the chip that CAUSED the loop stays removable
        // right here, keeping the working state recoverable (§8 acceptance item).
        <>
          {isSquadLeaf ? (
            <SquadEditor {...props} task={task} squadId={squadId!} />
          ) : (
            <SpineEditor {...props} task={task} />
          )}
          {sched && (
            <Telemetry task={task} sched={sched} conflicts={conflicts} />
          )}
        </>
      ) : (
        <div className="fl-panel-note">This row has nothing to edit.</div>
      )}
    </aside>
  );
}

// ── read-only rollups (groups + summaries) ──────────────────────────────────────

function RolledUpInfo({
  row,
  isSummary,
  inline,
}: {
  row: ChartRow;
  isSummary: boolean;
  inline?: boolean; // rendered inside an existing fl-panel-body (no own wrapper)
}) {
  const body = (
    <>
      <p className="fl-panel-note">
        {isSummary
          ? "This is a summary — its dates, status and progress roll up from the tasks beneath it. Edit those tasks to change it."
          : "This is a group header — it rolls up everything inside it. Open a task beneath it to edit."}
      </p>
      <Box>
        <Field label="Status">
          <span
            className={`fl-ro${row.status === "done" ? " fl-ro-done" : ""}`}
          >
            {statusLabel(row.status)}
          </span>
        </Field>
        <Field label="Progress">
          <span className="fl-ro fl-tel">{Math.round(row.percent)}%</span>
        </Field>
        <Field label="Span">
          <span className="fl-ro fl-tel">
            {shortDate(row.startISO)} → {shortDate(exclusiveToLast(row.endISO))}
          </span>
        </Field>
      </Box>
    </>
  );
  return inline ? body : <div className="fl-panel-body">{body}</div>;
}

// ── the spine editor (reviews / gates) ──────────────────────────────────────────

function SpineEditor(props: EditPanelProps & { task: Task }) {
  const { task } = props;
  return (
    <div className="fl-panel-body">
      <p className="fl-panel-lead">
        A mission-spine{" "}
        {props.row.kind === "gate-review" ? "review" : "test gate"}. Pin it to a
        real date once the team commits to one.
      </p>
      <Section label="Identity">
        <Box>
          <NameField task={task} onPatch={props.onPatch} />
        </Box>
        <Box>
          <StatusField task={task} onPatch={props.onPatch} />
        </Box>
      </Section>
      <Section label="Timing">
        <Box>
          <TimingFields
            task={task}
            onPatch={props.onPatch}
            showDuration={false}
          />
        </Box>
      </Section>
      <Section label="Dependencies">
        <Box>
          <DependencyField {...props} task={task} />
        </Box>
      </Section>
      <Section label="Risk">
        <Box>
          <DeadlineField task={task} onPatch={props.onPatch} />
        </Box>
      </Section>
      <div className="fl-panel-add">
        <button
          type="button"
          className="fl-panel-add-btn"
          onClick={() => props.onAddSpine("review")}
        >
          + Add review gate
        </button>
        <button
          type="button"
          className="fl-panel-add-btn"
          onClick={() => props.onAddSpine("test")}
        >
          + Add test gate
        </button>
      </div>
      <DeleteControl
        {...props}
        task={task}
        noun={props.row.kind === "gate-review" ? "review gate" : "test gate"}
      />
    </div>
  );
}

// ── the full squad-task editor ──────────────────────────────────────────────────

function SquadEditor(props: EditPanelProps & { task: Task; squadId: string }) {
  const { task } = props;
  const isMilestone = task.milestone === true;
  const showPercent = durationOf(task) >= 7 && !isMilestone;

  return (
    <div className="fl-panel-body">
      <Section label="Identity">
        <Box>
          <NameField task={task} onPatch={props.onPatch} />
        </Box>
        <Box>
          <StatusField task={task} onPatch={props.onPatch} />
          {showPercent && <PercentField task={task} onPatch={props.onPatch} />}
        </Box>
      </Section>
      <Section label="Timing">
        <Box>
          <TimingFields
            task={task}
            onPatch={props.onPatch}
            showDuration={!isMilestone}
          />
        </Box>
        <Box>
          <MilestoneField task={task} onPatch={props.onPatch} />
        </Box>
      </Section>
      <Section label="Dependencies">
        <Box>
          <DependencyField {...props} task={task} />
        </Box>
      </Section>
      <Section label="Risk">
        <Box>
          <ConfidenceField task={task} onPatch={props.onPatch} />
        </Box>
        <Box>
          <DeadlineField task={task} onPatch={props.onPatch} />
        </Box>
      </Section>
      <div className="fl-panel-add">
        <button
          type="button"
          className="fl-panel-add-btn"
          onClick={() => props.onAdd(props.squadId)}
        >
          + Add task to {squadName(props.squads, props.squadId)}
        </button>
      </div>
      <DeleteControl
        {...props}
        task={task}
        noun={task.milestone === true ? "milestone" : "task"}
      />
    </div>
  );
}

function squadName(squads: Squad[], id: string): string {
  return squads.find((s) => s.id === id)?.name ?? id;
}

// ── individual fields ────────────────────────────────────────────────────────────

function NameField({ task, onPatch }: FieldProps) {
  return (
    <Field label="Name">
      <input
        className="fl-panel-input"
        value={task.name}
        onChange={(e) => onPatch(task.id, { name: e.target.value })}
      />
    </Field>
  );
}

function StatusField({ task, onPatch }: FieldProps) {
  const cur = task.status ?? "not-started";
  return (
    <Field label="Status">
      <Segmented
        options={STATUSES}
        value={cur}
        onPick={(id) => onPatch(task.id, { status: id })}
      />
    </Field>
  );
}

function PercentField({ task, onPatch }: FieldProps) {
  return (
    <Field label="Percent">
      <div className="fl-panel-inline">
        <input
          className="fl-panel-input fl-panel-num"
          type="number"
          min={0}
          max={100}
          value={task.percent ?? ""}
          placeholder="—"
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") onPatch(task.id, { percent: null });
            else onPatch(task.id, { percent: clamp(Number(v), 0, 100) });
          }}
        />
        {task.percent !== undefined && (
          <button
            type="button"
            className="fl-panel-clear"
            onClick={() => onPatch(task.id, { percent: null })}
          >
            clear
          </button>
        )}
      </div>
    </Field>
  );
}

function ConfidenceField({ task, onPatch }: FieldProps) {
  const cur = task.confidence ?? "guess";
  return (
    <Field label="Confidence">
      <Segmented
        options={CONFIDENCES}
        value={cur}
        onPick={(id) => onPatch(task.id, { confidence: id })}
      />
    </Field>
  );
}

/** The §8 timing toggle: Auto — after dependencies · Pinned to a date. */
function TimingFields({
  task,
  onPatch,
  showDuration,
}: FieldProps & { showDuration: boolean }) {
  const pinned = task.schedule.mode === "pinned";
  const start = pinned ? (task.schedule as { start: string }).start : "";
  return (
    <>
      <Field label="Timing">
        <Segmented
          options={[
            { id: "auto", label: "Auto — after deps" },
            { id: "pinned", label: "Pinned to a date" },
          ]}
          value={pinned ? "pinned" : "auto"}
          onPick={(id) => {
            if (id === "pinned")
              onPatch(task.id, movePatch(start || todayISO()));
            else onPatch(task.id, releasePatch(durationOf(task)));
          }}
        />
      </Field>
      {pinned && (
        <Field label="Start">
          <input
            className="fl-panel-input"
            type="date"
            value={start}
            onChange={(e) =>
              e.target.value && onPatch(task.id, movePatch(e.target.value))
            }
          />
        </Field>
      )}
      {showDuration && (
        <Field label="Duration">
          <div className="fl-panel-inline">
            <input
              className="fl-panel-input fl-panel-num"
              type="number"
              min={0}
              value={durationOf(task)}
              onChange={(e) =>
                onPatch(
                  task.id,
                  resizePatch(Math.max(0, Number(e.target.value))),
                )
              }
            />
            <span className="fl-panel-unit">days</span>
          </div>
        </Field>
      )}
    </>
  );
}

function MilestoneField({ task, onPatch }: FieldProps) {
  const on = task.milestone === true;
  return (
    <Field label="Milestone">
      <Toggle
        checked={on}
        onChange={(v) => onPatch(task.id, milestonePatch(v))}
      >
        Zero-duration marker
      </Toggle>
    </Field>
  );
}

function DeadlineField({ task, onPatch }: FieldProps) {
  const dl = task.deadline;
  return (
    <Field label="Deadline">
      <div className="fl-panel-stack">
        <Toggle
          checked={!!dl}
          onChange={(v) =>
            onPatch(
              task.id,
              v
                ? { deadline: { date: todayISO(), hard: false } }
                : { deadline: null },
            )
          }
        >
          Has a deadline
        </Toggle>
        {dl && (
          <div className="fl-panel-inline">
            <input
              className="fl-panel-input"
              type="date"
              value={dl.date}
              onChange={(e) =>
                e.target.value &&
                onPatch(task.id, {
                  deadline: { date: e.target.value, hard: dl.hard },
                })
              }
            />
            <Toggle
              checked={dl.hard}
              onChange={(v) =>
                onPatch(task.id, {
                  deadline: { date: dl.date, hard: v },
                })
              }
            >
              Hard
            </Toggle>
          </div>
        )}
      </div>
    </Field>
  );
}

// ── the dependency picker (§8) ───────────────────────────────────────────────────

function DependencyField(props: EditPanelProps & { task: Task }) {
  const { task, allTasks, squads, squadIds, conflicts } = props;
  const nameById = useMemo(
    () => new Map(allTasks.map((t) => [t.id, t.name])),
    [allTasks],
  );
  // Which targets are gates — drives the ◆ kind glyph on their chips.
  const isGateById = useMemo(
    () => new Map(allTasks.map((t) => [t.id, !!t.gate])),
    [allTasks],
  );
  const eligible = useMemo(
    () => eligibleDependencyTargets(task, allTasks, squads, squadIds),
    [task, allTasks, squads, squadIds],
  );
  // Group eligible targets for the <optgroup>s (Spine first, then squads).
  const groups = useMemo(() => {
    const m = new Map<string, { id: string; name: string }[]>();
    for (const t of eligible) {
      const arr = m.get(t.group) ?? [];
      arr.push({ id: t.id, name: t.name });
      m.set(t.group, arr);
    }
    return [...m.entries()];
  }, [eligible]);

  const deps = task.dependsOn ?? [];
  const inCycle = conflicts.some(
    (c) => c.kind === "cycle" && c.tasks.includes(task.id),
  );

  const replaceDeps = (next: Dependency[]) =>
    props.onPatch(task.id, { dependsOn: next });

  const addDep = (id: string) => {
    if (dependsOnIds(deps).includes(id)) return;
    replaceDeps([...deps, id]); // string form — leanest by default
  };
  const removeDep = (id: string) =>
    replaceDeps(deps.filter((d) => depId(d) !== id));
  const setDepAdv = (id: string, type: "FS" | "SS", lag: number) =>
    replaceDeps(
      deps.map((d) => (depId(d) === id ? makeDep(id, type, lag) : d)),
    );

  return (
    <>
      {inCycle && (
        <div className="fl-panel-warn" role="alert">
          This dependency creates a loop — the schedule is paused until it's
          fixed. Remove a link below (or Discard) to restore it.
        </div>
      )}
      <div className="fl-chips">
        {deps.length === 0 && (
          <span className="fl-panel-note fl-panel-note-tight">
            No dependencies — this task can start right away.
          </span>
        )}
        {deps.map((d) => (
          <DepChip
            key={depId(d)}
            dep={d}
            label={nameById.get(depId(d)) ?? depId(d)}
            isGate={isGateById.get(depId(d)) ?? false}
            onRemove={() => removeDep(depId(d))}
            onAdv={(type, lag) => setDepAdv(depId(d), type, lag)}
          />
        ))}
      </div>
      <DepPicker groups={groups} onAdd={addDep} />
    </>
  );
}

/**
 * A small searchable listbox for adding a dependency (§8: a picker, never
 * drag-to-connect). Type to filter; the eligible targets are grouped Spine-first
 * then by squad. Rendered as real DOM (not a native <select>) so the honest
 * "which targets are offered" is visible — you can SEE that another squad's
 * internal tasks are absent.
 */
function DepPicker({
  groups,
  onAdd,
}: {
  groups: [string, { id: string; name: string }[]][];
  onAdd: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = groups
    .map(
      ([group, items]) =>
        [
          group,
          items.filter((it) => it.name.toLowerCase().includes(q)),
        ] as const,
    )
    .filter(([, items]) => items.length > 0);

  return (
    <div className="fl-dep-picker">
      <input
        className="fl-panel-input"
        placeholder="+ Add a dependency…"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        // Let a click on an option register before the blur closes the list.
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      />
      {open && (
        <div className="fl-dep-list" role="listbox">
          {filtered.length === 0 && (
            <div className="fl-dep-empty">No matching targets</div>
          )}
          {filtered.map(([group, items]) => (
            <div key={group} className="fl-dep-group">
              <div className="fl-dep-group-label">{group}</div>
              {items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className="fl-dep-opt"
                  role="option"
                  onClick={() => {
                    onAdd(it.id);
                    setQuery("");
                    setOpen(false);
                  }}
                >
                  <span className="fl-dep-opt-name">{it.name}</span>
                  <span className="fl-dep-opt-kbd" aria-hidden="true">
                    add
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DepChip({
  dep,
  label,
  isGate,
  onRemove,
  onAdv,
}: {
  dep: Dependency;
  label: string;
  isGate: boolean;
  onRemove: () => void;
  onAdv: (type: "FS" | "SS", lag: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const type = depType(dep);
  const lag = depLag(dep);
  const suffix =
    type === "SS" || lag !== 0
      ? ` (${type}${lag !== 0 ? ` +${lag}d` : ""})`
      : "";
  return (
    <span className="fl-chip-dep">
      {isGate && (
        <span className="fl-chip-glyph" aria-hidden="true">
          ◆
        </span>
      )}
      <span className="fl-chip-label">
        after: {label}
        {suffix}
      </span>
      <button
        type="button"
        className="fl-chip-adv"
        onClick={() => setOpen((o) => !o)}
        title="Dependency type & lag"
        aria-label="Edit dependency type and lag"
      >
        ⋯
      </button>
      <button
        type="button"
        className="fl-chip-x"
        onClick={onRemove}
        aria-label={`Remove dependency on ${label}`}
      >
        ×
      </button>
      {open && (
        <span className="fl-chip-pop">
          <Segmented
            options={[
              { id: "FS", label: "Finish→Start" },
              { id: "SS", label: "Start→Start" },
            ]}
            value={type}
            onPick={(t) => onAdv(t as "FS" | "SS", lag)}
          />
          <label className="fl-panel-inline">
            <span className="fl-panel-unit">lag</span>
            <input
              className="fl-panel-input fl-panel-num"
              type="number"
              value={lag}
              onChange={(e) => onAdv(type, Math.round(Number(e.target.value)))}
            />
            <span className="fl-panel-unit">days</span>
          </label>
        </span>
      )}
    </span>
  );
}

// ── delete (any element — with subtree cascade + dependency cleanup) ──────────────
//
// Everything on the chart is deletable. When deleting takes more than the one
// clicked row — a summary's subtree goes too, or other tasks depended on it — we
// confirm first and say exactly what travels with it. A clean leaf with nothing
// pointing at it deletes immediately (staged, and recoverable via reload / git).

function DeleteControl(props: EditPanelProps & { task: Task; noun: string }) {
  const { task, allTasks, noun } = props;
  const [confirming, setConfirming] = useState(false);
  const { descendants, dependents } = useMemo(
    () => removalPreview(task.id, allTasks),
    [task.id, allTasks],
  );
  const nameById = useMemo(
    () => new Map(allTasks.map((t) => [t.id, t.name])),
    [allTasks],
  );
  const nameOf = (id: string) => nameById.get(id) ?? id;
  const needsConfirm = descendants.length > 0 || dependents.length > 0;

  const doDelete = () => props.onDelete(task.id);

  return (
    <div className="fl-panel-delete">
      {confirming ? (
        <div className="fl-panel-stack">
          <div className="fl-panel-note fl-panel-note-tight">
            Delete this {noun}?
          </div>
          {descendants.length > 0 && (
            <div className="fl-panel-note fl-panel-note-tight">
              Its {descendants.length} sub-item
              {descendants.length === 1 ? "" : "s"} beneath it will be deleted
              too.
            </div>
          )}
          {dependents.length > 0 && (
            <div className="fl-panel-note fl-panel-note-tight">
              {dependents.length} task{dependents.length === 1 ? "" : "s"}{" "}
              depend on it; that dependency will be removed:{" "}
              {dependents.map(nameOf).join(", ")}.
            </div>
          )}
          <div className="fl-panel-inline">
            <button
              type="button"
              className="fl-panel-danger"
              onClick={doDelete}
            >
              Delete
            </button>
            <button
              type="button"
              className="fl-panel-clear"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
          <div className="fl-panel-note fl-panel-note-tight">
            History stays in git — a delete is recoverable.
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="fl-panel-danger-ghost"
          onClick={() => (needsConfirm ? setConfirming(true) : doDelete())}
        >
          Delete {noun}
        </button>
      )}
    </div>
  );
}

// ── telemetry readout (mono, read-only) ──────────────────────────────────────────

function Telemetry({
  task,
  sched,
  conflicts,
}: {
  task: Task;
  sched: ScheduleResult["tasks"][string];
  conflicts: Conflict[];
}) {
  void conflicts;
  return (
    <div className="fl-panel-tel">
      <div className="fl-panel-tel-label">Computed</div>
      <dl className="fl-tel-grid">
        <dt>id</dt>
        <dd className="fl-tel">{task.id}</dd>
        <dt>ES → EF</dt>
        <dd className="fl-tel">
          {sched.earliestStart === sched.earliestFinish
            ? shortDate(sched.earliestStart) /* zero-duration: one date */
            : `${shortDate(sched.earliestStart)} → ${shortDate(exclusiveToLast(sched.earliestFinish))}`}
        </dd>
        <dt>slack</dt>
        <dd className="fl-tel">
          {sched.slack} day{sched.slack === 1 ? "" : "s"}
        </dd>
        <dt>critical</dt>
        <dd className="fl-tel">{sched.critical ? "yes" : "no"}</dd>
      </dl>
    </div>
  );
}

// ── small shared pieces ──────────────────────────────────────────────────────────

interface FieldProps {
  task: Task;
  onPatch: (id: string, patch: TaskPatch) => void;
}

function Field({
  label,
  children,
  stacked,
}: {
  label: string;
  children: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div
      className={`fl-panel-field${stacked ? " fl-panel-field-stacked" : ""}`}
    >
      <div className="fl-panel-label">{label}</div>
      <div className="fl-panel-control">{children}</div>
    </div>
  );
}

/** A labelled group of fields — the console-label sectioning (IDENTITY / TIMING /
 * DEPENDENCIES / RISK) that gives the panel its designed rhythm. */
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="fl-panel-section">
      <div className="fl-panel-section-label">{label}</div>
      {children}
    </section>
  );
}

/** One field group's rounded container (aesthetic pass 2026-07-07): a bordered,
 * slightly inset box that strengthens its border on hover (app.css) — the panel
 * reads as distinct, well-separated controls instead of a flat list. */
function Box({ children }: { children: ReactNode }) {
  return <div className="fl-panel-box">{children}</div>;
}

/** A token-styled toggle switch — the app-like replacement for a raw checkbox. */
function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="fl-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="fl-toggle-track">
        <span className="fl-toggle-knob" />
      </span>
      <span>{children}</span>
    </label>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onPick,
}: {
  options: { id: T; label: string }[];
  value: T;
  onPick: (id: T) => void;
}) {
  return (
    <div className="fl-panel-seg" role="group">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          // data-opt lets the theme give one option its own pressed colour —
          // the Done chip reads done-green (2026-07-07 override), via CSS only.
          data-opt={o.id}
          onClick={() => onPick(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function statusLabel(s: Status): string {
  return STATUSES.find((x) => x.id === s)?.label ?? s;
}

/** Row/telemetry ends are EXCLUSIVE; the human "last day" is one day earlier. */
function exclusiveToLast(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// localId is re-exported for callers that build "+ Add task" labels.
export { localId };
