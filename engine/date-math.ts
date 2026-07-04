// engine/date-math.ts — calendar-day arithmetic with ZERO timezone risk.
//
// Every date in the engine is an ISO "YYYY-MM-DD" string treated as a
// morning-of point on a pure calendar. We convert each string to an integer
// "epoch day" (days since 1970-01-01) using UTC only, do all math on those
// integers, and convert back at the very end. No local-timezone Date methods
// are ever used, so DST shifts and machine locale can never move a date.

import type { ISODate } from "./types";

const MS_PER_DAY = 86_400_000;

/** ISO date string → integer epoch-day number (UTC, no local time involved). */
export function toDay(iso: ISODate): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

/** Integer epoch-day number → ISO date string (UTC getters only). */
export function fromDay(day: number): ISODate {
  const dt = new Date(day * MS_PER_DAY);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
