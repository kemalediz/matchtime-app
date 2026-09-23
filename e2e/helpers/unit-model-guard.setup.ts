/**
 * Runs before every unit test file (vitest.config.ts `setupFiles`).
 * Without `MT_UNIT_LIVE_LLM=1` the process cannot reach a model, and a
 * test that tries fails by name. See `unit-model-guard.ts`.
 */
import { afterEach, beforeEach } from "vitest";
import {
  liveModelTestsEnabled,
  openForApprovedLiveRun,
  repinIfDeleted,
  shutModelAccess,
  takeRefusedModelCalls,
} from "./unit-model-guard";

if (liveModelTestsEnabled()) {
  openForApprovedLiveRun();
} else {
  shutModelAccess();
  beforeEach(() => {
    repinIfDeleted();
  });
  afterEach(() => {
    repinIfDeleted();
    const calls = takeRefusedModelCalls();
    if (calls.length > 0) {
      throw new Error(
        `this test tried to call the model ${calls.length} time(s) and was refused ` +
          `(no network was used):\n  ${calls.join("\n  ")}\n` +
          `Unit tests must be free. Stub the SDK, or, for a run Kemal has approved, ` +
          `set MT_UNIT_LIVE_LLM=1.`,
      );
    }
  });
}
