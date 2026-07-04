import { describe, it, expect } from "vitest";
import type { Task, Config } from "./index";

// This smoke test exists only to prove the test toolchain runs and the §6.1
// contract types compile. No scheduling logic is exercised (that arrives in Phase 1).
describe("engine contract", () => {
  it("engine contract types compile and toolchain runs", () => {
    const task: Task = {
      id: "engines.injector-test",
      name: "Injector characterization",
      schedule: { mode: "auto", duration: 14 },
      dependsOn: ["engines.injector-fab"],
      status: "not-started",
      confidence: "guess",
    };

    const config: Config = { calendar: "calendar-days", today: "2026-01-01" };

    expect(task.id).toBe("engines.injector-test");
    expect(config.calendar).toBe("calendar-days");
  });
});
