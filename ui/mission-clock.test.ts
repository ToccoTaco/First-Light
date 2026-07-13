import { describe, it, expect } from "vitest";
import { formatUTCClock, tMinusReadout } from "./mission-clock";
import type { CountdownModel } from "../dashboard/dashboard-model";

// Fixed instants built with Date.UTC so the machine's timezone never leaks in.
const utc = (
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
): Date => new Date(Date.UTC(y, mo - 1, d, h, mi, s));

describe("formatUTCClock", () => {
  it("renders YYYY-MM-DD · HH:MM:SSZ", () => {
    expect(formatUTCClock(utc(2026, 7, 13, 14, 30, 59))).toBe(
      "2026-07-13 · 14:30:59Z",
    );
  });

  it("zero-pads every field", () => {
    expect(formatUTCClock(utc(2026, 1, 2, 3, 4, 5))).toBe(
      "2026-01-02 · 03:04:05Z",
    );
  });

  it("handles midnight and end-of-day", () => {
    expect(formatUTCClock(utc(2026, 12, 31, 0, 0, 0))).toBe(
      "2026-12-31 · 00:00:00Z",
    );
    expect(formatUTCClock(utc(2026, 12, 31, 23, 59, 59))).toBe(
      "2026-12-31 · 23:59:59Z",
    );
  });

  it("reads UTC, not local time (the Z suffix is honest)", () => {
    // 2026-07-13T23:30:00Z — in any timezone west of UTC this is still Jul 13
    // 23:30 on the clock face; the formatter must ignore the local offset.
    const d = new Date(Date.UTC(2026, 6, 13, 23, 30, 0));
    const out = formatUTCClock(d);
    expect(out).toBe("2026-07-13 · 23:30:00Z");
    expect(out.endsWith("Z")).toBe(true);
  });
});

describe("tMinusReadout", () => {
  const counting: CountdownModel = {
    kind: "countdown",
    days: 12,
    gateId: "spine.cdr",
    gateName: "Critical Design Review",
    gateDateISO: "2026-07-25",
  };

  it("renders T−{N}D (U+2212 minus) for a live countdown", () => {
    expect(tMinusReadout(counting)).toBe("T−12D");
    expect(tMinusReadout({ ...counting, days: 0 })).toBe("T−0D");
  });

  it("reads T−0D when every gate has passed", () => {
    expect(tMinusReadout({ kind: "all-passed" })).toBe("T−0D");
  });

  it("omits the readout when there is nothing honest to count", () => {
    expect(tMinusReadout({ kind: "no-gates" })).toBeNull();
    expect(tMinusReadout({ kind: "no-schedule" })).toBeNull();
    expect(tMinusReadout(null)).toBeNull();
  });
});
