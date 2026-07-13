// ui/mission-clock.tsx — the header's live mission clock (Concept 3, Wave 2).
//
// Line 1: "MISSION CLOCK · T−{N}D". The T-minus readout comes from the
// dashboard model's countdown — the SAME next-gate rule as the hero band — so
// the clock never invents its own schedule math. Honest fallbacks per kind:
//   countdown   → T−{days}D
//   all-passed  → T−0D  (every gate is behind us — the honest zero)
//   no-gates    → readout omitted (nothing to count down to)
//   no-schedule → readout omitted (a conflict blanked the schedule)
// Line 2: live UTC, "YYYY-MM-DD · HH:MM:SSZ", ticking every second. The tick
// is information — a mission clock that doesn't tick reads as stopped — so it
// is deliberately NOT gated behind prefers-reduced-motion.

import { useEffect, useState } from "react";
import type { CountdownModel } from "../dashboard/dashboard-model";

/** "2026-07-13 · 04:09:02Z" — UTC, zero-padded, Z-suffixed. Pure. */
export function formatUTCClock(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    ` · ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`
  );
}

/**
 * The T-minus readout ("T−12D", U+2212 minus), or null when there is nothing
 * honest to display (no gates / schedule blanked). Pure.
 */
export function tMinusReadout(countdown: CountdownModel | null): string | null {
  if (!countdown) return null;
  switch (countdown.kind) {
    case "countdown":
      return `T−${countdown.days}D`;
    case "all-passed":
      return "T−0D";
    default:
      // no-gates / no-schedule: omitting beats inventing a number.
      return null;
  }
}

export function MissionClock({
  countdown,
}: {
  countdown: CountdownModel | null;
}) {
  const [now, setNow] = useState(() => new Date());

  // 1s tick; cleared on unmount so state only ever updates while mounted.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const tMinus = tMinusReadout(countdown);
  return (
    <div className="fl-clock">
      MISSION CLOCK
      {tMinus !== null && (
        <>
          {" · "}
          <b>{tMinus}</b>
        </>
      )}
      <br />
      <span>{formatUTCClock(now)}</span>
    </div>
  );
}
