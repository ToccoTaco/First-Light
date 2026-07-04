// gantt-adapter.ts — the ONLY file in the codebase allowed to import DHTMLX Gantt.
//
// It maps engine ScheduleResult output onto the renderer and keeps the renderer
// swappable: if we ever replace DHTMLX, this is the only file that changes. The
// library's own auto-scheduler / critical-path stay OFF — those are the engine's job;
// we only borrow pixels. Implemented in Phase 3. Placeholder for now.

export {};
