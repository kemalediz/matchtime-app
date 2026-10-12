/** The website's read of SETUP_LEARNING_ENABLED, and its test-only cookie. */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { setupLearningUiEnabledFrom } from "../setup-learning-ui-flag";

describe("setupLearningUiEnabledFrom", () => {
  it("outside test mode the cookie is ignored: the environment decides", () => {
    expect(setupLearningUiEnabledFrom("1", {})).toBe(false);
    expect(setupLearningUiEnabledFrom("0", { SETUP_LEARNING_ENABLED: "1" })).toBe(true);
    expect(setupLearningUiEnabledFrom("1", { MT_TEST_MODE: "true" })).toBe(false);
  });

  it("in test mode the cookie may say 1 or 0; anything else falls back to the environment", () => {
    expect(setupLearningUiEnabledFrom("1", { MT_TEST_MODE: "1" })).toBe(true);
    expect(setupLearningUiEnabledFrom("0", { MT_TEST_MODE: "1", SETUP_LEARNING_ENABLED: "1" })).toBe(false);
    expect(setupLearningUiEnabledFrom(undefined, { MT_TEST_MODE: "1", SETUP_LEARNING_ENABLED: "1" })).toBe(true);
    expect(setupLearningUiEnabledFrom("yes", { MT_TEST_MODE: "1" })).toBe(false);
  });
});
