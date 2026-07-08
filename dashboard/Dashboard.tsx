// dashboard/Dashboard.tsx — the landing view (Phase 4), a THIN renderer of the
// pure DashboardModel. Every number/date/label shown here was decided in
// dashboard-model.ts; this file only lays them out and applies the tokens.
//
// GOLD AUDIT (DESIGN §1/§4): the T-minus hero is the ONE gold moment on this
// screen (mono --gold-text). The only other sanctioned gold is a staleness
// warning tint (>14 days) in --gold-text. Nothing else here is gold — progress
// bars are the blue/neutral family, the critical tile is deliberately quiet
// (the gold thread lives on the chart), the slippage number is blocked-fg only
// when it moved LATER.

import type {
  BlockedItem,
  CountdownModel,
  CriticalModel,
  DashboardModel,
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

function countsLine(c: Rollup["counts"]): string {
  const parts: string[] = [];
  if (c.done) parts.push(`${c.done} done`);
  if (c.inProgress) parts.push(`${c.inProgress} in progress`);
  if (c.blocked) parts.push(`${c.blocked} blocked`);
  if (c.notStarted) parts.push(`${c.notStarted} not started`);
  return parts.length ? parts.join(" · ") : "no tasks yet";
}

/** A console label — small-caps mono, one per tile (DESIGN §4). */
function TileLabel({ children }: { children: string }) {
  return <div className="fl-tile-label">{children}</div>;
}

// ── the hero (deliverable 1) ──────────────────────────────────────────────────

function Hero({ countdown }: { countdown: CountdownModel }) {
  return (
    <section className="fl-dash-hero">
      <div className="fl-dash-hero-inner">
        {countdown.kind === "countdown" && (
          <>
            <div className="fl-countdown-kicker">T–minus</div>
            <div className="fl-countdown-num">{countdown.days} DAYS</div>
            <div className="fl-countdown-target">
              to {countdown.gateName} · {fmtDate(countdown.gateDateISO)}
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
    </section>
  );
}

// ── rollups (deliverable 2) ───────────────────────────────────────────────────

function ProgressBar({
  percent,
  chipColor,
  name,
}: {
  percent: number;
  chipColor?: string;
  name: string;
}) {
  const pct = Math.round(percent);
  return (
    <div className="fl-prog-row">
      <span className="fl-prog-name">
        {chipColor && (
          <span className="fl-prog-chip" style={{ background: chipColor }} />
        )}
        {name}
      </span>
      <span className="fl-prog-track">
        <span className="fl-prog-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="fl-prog-pct">{pct}%</span>
    </div>
  );
}

function Rollups({ rollups }: { rollups: RollupsModel }) {
  return (
    <section className="fl-tile fl-tile-rollups">
      <TileLabel>Progress</TileLabel>
      <div className="fl-prog-overall">
        <ProgressBar percent={rollups.overall.percent} name="Overall" />
        <div className="fl-prog-counts">
          {countsLine(rollups.overall.counts)}
        </div>
      </div>
      <div className="fl-prog-squads">
        {rollups.squads.map((s: SquadRollup) => (
          <div key={s.squadId} className="fl-prog-squad">
            <ProgressBar
              percent={s.percent}
              chipColor={s.color}
              name={s.name}
            />
            <div className="fl-prog-counts">{countsLine(s.counts)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── slippage (deliverable 3) ──────────────────────────────────────────────────

function GateDeltaTable({ deltas }: { deltas: GateDelta[] }) {
  return (
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
                {g.deltaDays === null ? "new" : fmtDelta(g.deltaDays)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Slippage({ slippage }: { slippage: SlippageModel }) {
  return (
    <section className="fl-tile fl-tile-slippage">
      <TileLabel>Baseline slippage</TileLabel>
      {slippage.kind === "no-baseline" ? (
        <p className="fl-tile-empty">
          No baseline set — tag a commit <code>baseline/&lt;date&gt;</code> to
          start tracking slippage.
        </p>
      ) : (
        <>
          <p className="fl-slip-headline">
            {slippage.metricLabel} has moved{" "}
            {slippage.direction === "steady" ? (
              <b className="fl-slip-steady">holding steady</b>
            ) : (
              <>
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
              </>
            )}{" "}
            since baseline {slippage.baselineLabel}.
          </p>
          <GateDeltaTable deltas={slippage.gateDeltas} />
        </>
      )}
    </section>
  );
}

// ── critical health (deliverable 4) ───────────────────────────────────────────

function Critical({
  critical,
  noSchedule,
}: {
  critical: CriticalModel | null;
  noSchedule: boolean;
}) {
  return (
    <section className="fl-tile fl-tile-critical">
      <TileLabel>Critical path</TileLabel>
      {!critical ? (
        <p className="fl-tile-empty">
          {noSchedule
            ? "No critical path — the schedule is blocked by a conflict."
            : "No critical path yet — add tasks to see the thread."}
        </p>
      ) : (
        <>
          <div className="fl-crit-finish">
            <span className="fl-crit-finish-label">Projected finish</span>
            <span className="fl-crit-finish-date">
              {fmtDate(critical.finishISO)}
            </span>
          </div>
          <div className="fl-crit-chain">
            {critical.chain.map((n, i) => (
              <span key={n.id} className="fl-crit-node-wrap">
                {i > 0 && <span className="fl-crit-arrow">→</span>}
                <span
                  className={`fl-crit-node${n.isGate ? " fl-crit-node-gate" : ""}`}
                >
                  {n.label}
                </span>
              </span>
            ))}
          </div>
          <div className="fl-crit-meta">
            <span>
              {critical.taskCount} task{critical.taskCount === 1 ? "" : "s"} on
              the thread
            </span>
            {critical.nearestSlackDays !== null && (
              <span>
                nearest branch: {critical.nearestSlackDays} day
                {critical.nearestSlackDays === 1 ? "" : "s"} of slack
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

// ── blocked (deliverable 5) ───────────────────────────────────────────────────

function Blocked({ blocked }: { blocked: BlockedItem[] }) {
  return (
    <section className="fl-tile fl-tile-blocked">
      <TileLabel>Blocked</TileLabel>
      {blocked.length === 0 ? (
        <p className="fl-tile-empty">Nothing blocked.</p>
      ) : (
        <ul className="fl-blocked-list">
          {blocked.map((b: BlockedItem) => (
            <li key={b.id} className="fl-blocked-item">
              <div className="fl-blocked-head">
                <span className="fl-blocked-name">{b.name}</span>
                {b.squadName && (
                  <span className="fl-blocked-chip">
                    <span
                      className="fl-prog-chip"
                      style={{ background: b.squadColor ?? undefined }}
                    />
                    {b.squadName}
                  </span>
                )}
              </div>
              <div className="fl-blocked-meta">
                open {b.daysOpen} day{b.daysOpen === 1 ? "" : "s"}
                {b.blocksName && <> · blocks {b.blocksName}</>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── staleness (deliverable 6) ─────────────────────────────────────────────────

function Staleness({ staleness }: { staleness: StalenessModel }) {
  return (
    <section className="fl-tile fl-tile-staleness">
      <TileLabel>Staleness</TileLabel>
      {staleness.kind === "absent" ? (
        <p className="fl-tile-empty">
          Staleness data appears after a deploy build (<code>npm run meta</code>
          ).
        </p>
      ) : (
        <ul className="fl-stale-list">
          {staleness.rows.map((r: StalenessRow) => (
            <li key={r.path} className={`fl-stale-row fl-stale-${r.tier}`}>
              <span className="fl-stale-name">{r.label}</span>
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
      <Hero countdown={model.countdown} />
      <div className="fl-dash-actions">
        <button
          type="button"
          className="fl-review-link"
          onClick={onReviewSpine}
        >
          Review spine →
        </button>
      </div>
      <div className="fl-dash-grid">
        <Rollups rollups={model.rollups} />
        <Slippage slippage={model.slippage} />
        <Critical
          critical={model.critical}
          noSchedule={model.countdown.kind === "no-schedule"}
        />
        <Blocked blocked={model.blocked} />
        <Staleness staleness={model.staleness} />
      </div>
    </div>
  );
}
