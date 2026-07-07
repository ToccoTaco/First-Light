// dashboard/index.ts — the landing view's barrel (Phase 4).
//
// The dashboard is two layers, mirroring the chart's discipline:
//   - dashboard-model.ts — the PURE brain: countdown, rollups, slippage,
//     critical summary, blocked list, staleness. No DOM, no React, no network.
//   - Dashboard.tsx      — a thin renderer of that model.

export { Dashboard } from "./Dashboard";
export {
  buildDashboard,
  baselineScheduleFromMeta,
  dayDiff,
  type DashboardModel,
} from "./dashboard-model";
