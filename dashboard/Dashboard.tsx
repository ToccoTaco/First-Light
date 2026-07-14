// dashboard/Dashboard.tsx — the landing view (Concept 3 "Synthesis" redesign,
// Wave 3), a THIN renderer of the pure DashboardModel. Every number/date/label
// shown here was decided in dashboard-model.ts; this file only lays them out
// per the approved concept3 mockup: a glass hero card (T-minus + stat cluster)
// over a 300 / 1fr / 320 asymmetric grid — Progress + Staleness left, the
// Flight Path pipeline + slippage center, Anomaly Detection right.
//
// GOLD AUDIT (DESIGN §1/§4): the T-minus number and the NEXT flight-path node
// are the only gold on this screen (both mockup-approved). The one legacy
// exception kept for regression: the staleness >14d warn tint (--gold-text),
// sanctioned by the original design pass. Projected nodes are neutral OUTLINE
// nodes (not the mockup's dim gold) to honor the gold discipline.

import type { CSSProperties, ReactNode } from "react";
import type {
  BlockedItem,
  CountdownModel,
  CriticalModel,
  DashboardModel,
  FlightPathModel,
  GateDelta,
  Rollup,
  RollupsModel,
  SlippageModel,
  SquadRollup,
  StalenessModel,
  StalenessRow,
} from "./dashboard-model";
import "./dashboard.css";

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/** "2026-10-11" → "Oct 11". */
function fmtDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
}

/** A signed day delta with a real minus glyph, e.g. "+5d" / "−20d" / "0". */
function fmtDelta(days: number): string {
  if (days === 0) return "0";
  return days > 0 ? `+${days}d` : `−${Math.abs(days)}d`;
}

/* The counts line — telemetry-dim text, except the done counter, which reads
 * in done-green (user-directed override 2026-07-07: done is an explicit green). */
function CountsLine({ c }: { c: Rollup["counts"] }) {
  const parts: ReactNode[] = [];
  const push = (node: ReactNode) => {
    if (parts.length) parts.push(" · ");
    parts.push(node);
  };
  if (c.done)
    push(
      <span key="done" className="fl-count-done">
        {c.done} done
      </span>,
    );
  if (c.inProgress) push(`${c.inProgress} in progress`);
  if (c.blocked) push(`${c.blocked} blocked`);
  if (c.notStarted) push(`${c.notStarted} not started`);
  return <>{parts.length ? parts : "no tasks yet"}</>;
}

/** A console label — small-caps mono with a tick and an optional right-aligned
 * meta readout (mockup: "5 SYSTEMS", "4 GATES", "1 ACTIVE"). `crit` lights the
 * tick in blocked ink (the Anomaly Detection card). */
function CardLabel({
  children,
  meta,
  crit,
}: {
  children: string;
  meta?: string;
  crit?: boolean;
}) {
  return (
    <div className={`fl-card-label${crit ? " fl-card-label-crit" : ""}`}>
      <span className="fl-card-tick" aria-hidden="true" />
      {children}
      <span className="fl-card-grow" />
      {meta !== undefined && <span className="fl-card-meta">{meta}</span>}
    </div>
  );
}

// ── the hero (glass card: countdown + right-aligned stat cluster) ─────────────

function Hero({
  countdown,
  overall,
}: {
  countdown: CountdownModel;
  overall: Rollup;
}) {
  return (
    <section className="fl-dash-hero">
      {/* Mockup atmosphere: a soft gold radial glow + a one-shot glass sheen
          (sweeps once on load, then rests — reduced-motion viewers see the
          resting state; both live in dashboard.css). */}
      <div className="fl-hero-glow" aria-hidden="true" />
      <div className="fl-hero-sheen" aria-hidden="true" />
      <div className="fl-hero-row">
        <div className="fl-hero-main">
          {countdown.kind === "countdown" && (
            <>
              <div className="fl-countdown-kicker">T–minus</div>
              <div className="fl-countdown-num">
                {countdown.days} <small>DAYS</small>
              </div>
              <div className="fl-countdown-target">
                to <b>{countdown.gateName}</b> ·{" "}
                {fmtDate(countdown.gateDateISO)}
              </div>
            </>
          )}
          {countdown.kind === "no-gates" && (
            <>
              <div className="fl-countdown-calm">No gate on the board</div>
              <div className="fl-countdown-target">
                Add a review or test gate to set a target.
              </div>
            </>
          )}
          {countdown.kind === "all-passed" && (
            <>
              <div className="fl-countdown-calm">All gates passed</div>
              <div className="fl-countdown-target">
                Every review and test gate is behind us.
              </div>
            </>
          )}
          {countdown.kind === "no-schedule" && (
            <>
              <div className="fl-countdown-calm">Schedule paused</div>
              <div className="fl-countdown-target">
                A conflict is blocking the plan — open the chart to see the fix.
              </div>
            </>
          )}
        </div>
        {/* The stat cluster reads straight off rollups.overall — green overall
            %, blue in-progress, crimson blocked (mockup). */}
        <div className="fl-hero-stats">
          <div className="fl-hstat">
            <div className="fl-hstat-n fl-hstat-grn">
              {Math.round(overall.percent)}
              <small>%</small>
            </div>
            <div className="fl-hstat-k">Overall</div>
          </div>
          <div className="fl-hstat">
            <div className="fl-hstat-n fl-hstat-blu">
              {overall.counts.inProgress}
            </div>
            <div className="fl-hstat-k">In Progress</div>
          </div>
          <div className="fl-hstat">
            <div className="fl-hstat-n fl-hstat-crm">
              {overall.counts.blocked}
            </div>
            <div className="fl-hstat-k">Blocked</div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── LEFT · progress (thin green bars, squad chips, counts lines) ──────────────

function ProgressBlock({
  big,
  name,
  chipColor,
  rollup,
}: {
  big?: boolean;
  name: string;
  chipColor?: string;
  rollup: Rollup;
}) {
  const pct = Math.round(rollup.percent);
  return (
    <div className={big ? "fl-prog-overall" : "fl-prog-squad"}>
      <div className="fl-prog-top">
        <span className={`fl-prog-name${big ? " fl-prog-name-big" : ""}`}>
          {chipColor && (
            <span
              className="fl-chip"
              style={{ background: chipColor, color: chipColor }}
            />
          )}
          {name}
        </span>
        <span className={`fl-pct${big ? " fl-pct-big" : ""}`}>{pct}%</span>
      </div>
      <div className={`fl-track${big ? " fl-track-big" : ""}`}>
        <div
          className="fl-fill"
          style={{ "--w": `${pct}%` } as CSSProperties}
        />
      </div>
      <div className="fl-prog-counts">
        <CountsLine c={rollup.counts} />
      </div>
    </div>
  );
}

function ProgressCard({ rollups }: { rollups: RollupsModel }) {
  const n = rollups.squads.length;
  return (
    <section className="fl-card">
      <CardLabel meta={`${n} SYSTEM${n === 1 ? "" : "S"}`}>Progress</CardLabel>
      <ProgressBlock big name="Overall" rollup={rollups.overall} />
      {rollups.squads.map((s: SquadRollup) => (
        <ProgressBlock
          key={s.squadId}
          name={s.name}
          chipColor={s.color}
          rollup={s}
        />
      ))}
    </section>
  );
}

// ── LEFT · staleness (tier tints kept: fresh dot / warn gold / stale ink) ─────

function StalenessCard({ staleness }: { staleness: StalenessModel }) {
  return (
    <section className="fl-card">
      <CardLabel>Staleness</CardLabel>
      {staleness.kind === "absent" ? (
        <p className="fl-card-empty">
          Staleness data appears after a deploy build (<code>npm run meta</code>
          ).
        </p>
      ) : (
        <ul className="fl-stale-list">
          {staleness.rows.map((r: StalenessRow) => (
            <li key={r.path} className={`fl-stale-row fl-stale-${r.tier}`}>
              <span className="fl-stale-name">
                {r.tier === "fresh" && (
                  <span className="fl-stale-ok" aria-hidden="true" />
                )}
                {r.label}
              </span>
              <span className="fl-stale-age">
                {r.daysAgo === null
                  ? "never committed"
                  : `last updated ${r.daysAgo} day${r.daysAgo === 1 ? "" : "s"} ago`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── CENTER · flight path pipeline + critical meta + slippage ──────────────────

function FlightPath({ flightPath }: { flightPath: FlightPathModel }) {
  const { nodes, gateCount } = flightPath;
  if (nodes.length === 0) {
    // Degrade honestly: gateCount tells "schedule paused" (gates exist but a
    // conflict blanked their dates) apart from "no gates on the board".
    return (
      <p className="fl-card-empty">
        {gateCount > 0
          ? "Schedule paused — the gates have no dates until the conflict is fixed."
          : "No gate on the board — add a review or test gate to chart the flight path."}
      </p>
    );
  }
  // Rail fill: from the first node to the midpoint past the LAST CLEARED node
  // (green running to gold toward the next gate). No cleared gates → no fill.
  let lastCleared = -1;
  nodes.forEach((n, i) => {
    if (n.state === "cleared") lastCleared = i;
  });
  return (
    <ol className="fl-pipe">
      <span className="fl-rail" aria-hidden="true" />
      {lastCleared >= 0 && (
        <span
          className="fl-rail-fill"
          aria-hidden="true"
          style={{
            width: `calc((100% - 72px) * ${(lastCleared + 1) / nodes.length})`,
          }}
        />
      )}
      {nodes.map((n) => (
        <li key={n.id} className={`fl-node fl-node-${n.state}`}>
          <span className="fl-node-dot" aria-hidden="true" />
          <span className="fl-node-name">{n.name}</span>
          {n.dateISO && (
            <span className="fl-node-when">{fmtDate(n.dateISO)}</span>
          )}
          <span className="fl-node-state">
            {n.state === "cleared"
              ? "Cleared"
              : n.state === "next"
                ? `T−${n.tMinusDays ?? 0}d · Next`
                : "Projected"}
          </span>
        </li>
      ))}
    </ol>
  );
}

function GateDeltaTable({ deltas }: { deltas: GateDelta[] }) {
  return (
    <div className="fl-table-wrap">
      <table className="fl-delta-table">
        <thead>
          <tr>
            <th>Gate</th>
            <th>Baseline</th>
            <th>Now</th>
            <th>Δ</th>
          </tr>
        </thead>
        <tbody>
          {deltas.map((g) => {
            const cls =
              g.deltaDays === null
                ? "fl-delta-none"
                : g.deltaDays > 0
                  ? "fl-delta-later"
                  : g.deltaDays < 0
                    ? "fl-delta-earlier"
                    : "fl-delta-steady";
            return (
              <tr key={g.gateId}>
                <td className="fl-delta-name">{g.name}</td>
                <td>{g.baselineISO ? fmtDate(g.baselineISO) : "—"}</td>
                <td>{g.currentISO ? fmtDate(g.currentISO) : "—"}</td>
                <td className={cls}>
                  <span className="fl-delta-pill">
                    {g.deltaDays === null ? "new" : fmtDelta(g.deltaDays)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The slippage strip: big signed delta + the existing headline sentence, with
 * the projected-finish block on the right (from critical). The `no-baseline`
 * state renders the honest empty copy in a quiet strip so the projected finish
 * still has a home. */
function SlippageStrip({
  slippage,
  finishISO,
}: {
  slippage: SlippageModel;
  finishISO: string | null;
}) {
  const fin = finishISO && (
    <div className="fl-slip-fin">
      <div className="fl-slip-fin-k">Projected finish</div>
      <div className="fl-slip-fin-v">{fmtDate(finishISO)}</div>
    </div>
  );
  if (slippage.kind === "no-baseline") {
    if (!fin) {
      // Nothing to anchor a strip — just the empty-state copy.
      return (
        <p className="fl-card-empty">
          No baseline set — tag a commit <code>baseline/&lt;date&gt;</code> to
          start tracking slippage.
        </p>
      );
    }
    return (
      <div className="fl-slip-strip fl-slip-dir-steady">
        <p className="fl-slip-txt">
          No baseline set — tag a commit <code>baseline/&lt;date&gt;</code> to
          start tracking slippage.
        </p>
        {fin}
      </div>
    );
  }
  const big =
    slippage.direction === "later"
      ? `+${slippage.days}d`
      : slippage.direction === "earlier"
        ? `−${slippage.days}d`
        : "0d";
  return (
    <div className={`fl-slip-strip fl-slip-dir-${slippage.direction}`}>
      <div className="fl-slip-big">{big}</div>
      <p className="fl-slip-txt">
        {slippage.metricLabel} has moved{" "}
        {slippage.direction === "steady" ? (
          <b className="fl-slip-steady">holding steady</b>
        ) : (
          <b
            className={
              slippage.direction === "later"
                ? "fl-slip-later"
                : "fl-slip-earlier"
            }
          >
            {slippage.days} day{slippage.days === 1 ? "" : "s"}{" "}
            {slippage.direction}
          </b>
        )}{" "}
        since baseline <b>{slippage.baselineLabel}</b>.
      </p>
      {fin}
    </div>
  );
}

function FlightPathCard({
  flightPath,
  critical,
  slippage,
  noSchedule,
}: {
  flightPath: FlightPathModel;
  critical: CriticalModel | null;
  slippage: SlippageModel;
  noSchedule: boolean;
}) {
  const n = flightPath.gateCount;
  return (
    <section className="fl-card">
      <CardLabel meta={`${n} GATE${n === 1 ? "" : "S"}`}>
        Flight Path · Critical Chain
      </CardLabel>
      <FlightPath flightPath={flightPath} />
      {critical ? (
        <div className="fl-crit-meta">
          <span>
            <b>
              {critical.taskCount} task{critical.taskCount === 1 ? "" : "s"}
            </b>{" "}
            on the thread
          </span>
          {critical.nearestSlackDays !== null && (
            <span>
              nearest branch:{" "}
              <b>
                {critical.nearestSlackDays} day
                {critical.nearestSlackDays === 1 ? "" : "s"}
              </b>{" "}
              of slack
            </span>
          )}
        </div>
      ) : (
        <p className="fl-card-empty">
          {noSchedule
            ? "No critical path — the schedule is blocked by a conflict."
            : "No critical path yet — add tasks to see the thread."}
        </p>
      )}
      <SlippageStrip
        slippage={slippage}
        finishISO={critical ? critical.finishISO : null}
      />
      {slippage.kind === "tracked" && (
        <GateDeltaTable deltas={slippage.gateDeltas} />
      )}
    </section>
  );
}

// ── RIGHT · anomaly detection (blocked rows + healthy squads + review spine) ──

function AnomalyCard({
  blocked,
  squads,
  onReviewSpine,
}: {
  blocked: BlockedItem[];
  squads: SquadRollup[];
  onReviewSpine: () => void;
}) {
  const blockedSquads = new Set(
    blocked.map((b) => b.squadName).filter((s): s is string => s !== null),
  );
  const healthy = squads.filter((s) => !blockedSquads.has(s.name));
  return (
    <section className="fl-card">
      <CardLabel crit meta={`${blocked.length} ACTIVE`}>
        Anomaly Detection
      </CardLabel>
      {blocked.length > 0 && (
        <ul className="fl-anom-list">
          {blocked.map((b: BlockedItem) => (
            <li
              key={b.id}
              className="fl-anom-item"
              // The full story lives on the tooltip so the compact row loses
              // nothing: days open + what this task is holding up.
              title={`open ${b.daysOpen} day${b.daysOpen === 1 ? "" : "s"}${
                b.blocksName ? ` · blocks ${b.blocksName}` : ""
              }`}
            >
              <span className="fl-anom-name">{b.name}</span>
              {b.squadName && (
                <span className="fl-anom-squad">
                  <span
                    className="fl-chip"
                    style={
                      b.squadColor
                        ? { background: b.squadColor, color: b.squadColor }
                        : undefined
                    }
                  />
                  {b.squadName}
                </span>
              )}
              <span className="fl-anom-age">{b.daysOpen}d</span>
            </li>
          ))}
        </ul>
      )}
      {healthy.length > 0 && (
        <div className="fl-anom-clear">
          {healthy.map((s) => (
            <div key={s.squadId} className="fl-anom-clear-row">
              <span className="fl-anom-ok" aria-hidden="true">
                ●
              </span>{" "}
              {s.name}
              <span className="fl-anom-clear-r">no blockers</span>
            </div>
          ))}
        </div>
      )}
      {blocked.length === 0 && healthy.length === 0 && (
        <p className="fl-card-empty">Nothing blocked.</p>
      )}
      <div className="fl-actions">
        <button
          type="button"
          className="fl-review-link"
          onClick={onReviewSpine}
        >
          Review spine →
        </button>
      </div>
    </section>
  );
}

// ── the dashboard ─────────────────────────────────────────────────────────────

export function Dashboard({
  model,
  onReviewSpine,
}: {
  model: DashboardModel;
  onReviewSpine: () => void;
}) {
  return (
    <div className="fl-dash">
      <div className="fl-dash-inner">
        <Hero countdown={model.countdown} overall={model.rollups.overall} />
        <div className="fl-dash-grid">
          <div className="fl-dash-col fl-dash-col-left">
            <ProgressCard rollups={model.rollups} />
            <StalenessCard staleness={model.staleness} />
          </div>
          <div className="fl-dash-col fl-dash-col-center">
            <FlightPathCard
              flightPath={model.flightPath}
              critical={model.critical}
              slippage={model.slippage}
              noSchedule={model.countdown.kind === "no-schedule"}
            />
          </div>
          <div className="fl-dash-col fl-dash-col-right">
            <AnomalyCard
              blocked={model.blocked}
              squads={model.rollups.squads}
              onReviewSpine={onReviewSpine}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
