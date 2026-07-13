// ui/header.tsx — the app shell's header (Concept 3 "Synthesis", Wave 2).
//
// Transparent over the page canvas — the page-level nebula shows through — and
// closed by the mockup's bottom hairline gradient. Left: the sigil (a pure-CSS
// gold orb in a glass rounded-square housing) + the "FIRST LIGHT" wordmark +
// the team-name subtitle (bound to project.yaml exactly as before, with the
// same fallback while loading). Center: the Dashboard | Chart glass pill tabs
// — the SAME screen handler and aria-pressed semantics as the old segmented
// control; persistence lives untouched in App. Right: MissionClock · Settings
// · mode toggle, all quiet glass pills.
//
// Two size variants, one component: `variant="compact"` is the chart screen's
// single-row ~44px chrome band (the chart owns the page); "tall" everywhere
// else, including the loading/error screens (which pass no screen → no tabs).

import type { ProjectData } from "../storage/types";
import type { CountdownModel } from "../dashboard/dashboard-model";
import { otherMode, type Mode } from "./mode";
import { MissionClock } from "./mission-clock";
import "./header.css";

export type Screen = "dashboard" | "chart";
export type HeaderVariant = "tall" | "compact";

export function Header({
  project,
  mode,
  screen,
  onScreen,
  onToggleMode,
  onOpenSettings,
  countdown,
  variant,
}: {
  project?: ProjectData;
  mode: Mode;
  screen?: Screen; // omitted while loading / on error — no tabs then
  onScreen?: (s: Screen) => void;
  onToggleMode: () => void;
  onOpenSettings: () => void;
  countdown?: CountdownModel | null; // null/omitted → the clock shows UTC only
  variant: HeaderVariant;
}) {
  const target = otherMode(mode);
  return (
    <header
      className={`fl-head${variant === "compact" ? " fl-head-compact" : ""}`}
    >
      <div className="fl-brand">
        <div className="fl-sigil" aria-hidden="true" />
        <div>
          <h1 className="fl-wordmark">First Light</h1>
          <div className="fl-sub">
            {project ? project.team : "Notre Dame Experimental Propulsion"}
          </div>
        </div>
      </div>
      {/* Phase 4's two-view shell, in the mockup's glass pill tabs. Same
          handler, same aria-pressed semantics, same hidden-while-loading rule. */}
      {screen && onScreen && (
        <nav className="fl-tabs" role="group" aria-label="Screen">
          <button
            type="button"
            className="fl-tab"
            aria-pressed={screen === "dashboard"}
            onClick={() => onScreen("dashboard")}
          >
            Dashboard
          </button>
          <button
            type="button"
            className="fl-tab"
            aria-pressed={screen === "chart"}
            onClick={() => onScreen("chart")}
          >
            Chart
          </button>
        </nav>
      )}
      <div className="fl-topright">
        <MissionClock countdown={countdown ?? null} />
        <button
          type="button"
          className="fl-hpill"
          onClick={onOpenSettings}
          aria-label="Open settings"
          title="GitHub repo + token for saving"
        >
          Settings
        </button>
        {/* Labels the mode it switches TO — behavior unchanged from the old
            toggle, restyled as a mockup pill. Never gold (not signal). */}
        <button
          type="button"
          className="fl-hpill"
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
