// engine/index.ts — public surface of the pure scheduling core.
// Re-exports the §6.1 type contract. No implementation lives here yet.

export * from "./types";

// Phase 1 will add: export function computeSchedule(tasks: Task[], config: Config): ScheduleResult;
