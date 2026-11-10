import { describe, expect, it } from "vitest";
import { isUnifiedAnswersEnabled, unifiedAnswersEnabledForApiRequest, UNIFIED_ANSWERS_TEST_HEADER } from "../unified-answers-flag";

const req = (v?: string) => new Request("http://x", { headers: v === undefined ? {} : { [UNIFIED_ANSWERS_TEST_HEADER]: v } });

describe("UNIFIED_ANSWERS", () => {
  it("is OFF unless explicitly switched on", () => {
    expect(isUnifiedAnswersEnabled({})).toBe(false);
    expect(isUnifiedAnswersEnabled({ UNIFIED_ANSWERS: "" })).toBe(false);
    expect(isUnifiedAnswersEnabled({ UNIFIED_ANSWERS: "0" })).toBe(false);
    expect(isUnifiedAnswersEnabled({ UNIFIED_ANSWERS: "false" })).toBe(false);
    for (const v of ["1", "true", "on", "yes", " TRUE "]) expect(isUnifiedAnswersEnabled({ UNIFIED_ANSWERS: v })).toBe(true);
  });

  it("the test header is honoured only when the server runs with MT_TEST_MODE=1", () => {
    expect(unifiedAnswersEnabledForApiRequest(req("1"), {})).toBe(false);
    expect(unifiedAnswersEnabledForApiRequest(req("1"), { MT_TEST_MODE: "1" })).toBe(true);
    expect(unifiedAnswersEnabledForApiRequest(req("0"), { MT_TEST_MODE: "1", UNIFIED_ANSWERS: "1" })).toBe(false);
    expect(unifiedAnswersEnabledForApiRequest(req(), { MT_TEST_MODE: "1" })).toBe(false);
    expect(unifiedAnswersEnabledForApiRequest(req(), { UNIFIED_ANSWERS: "1" })).toBe(true);
  });
});
