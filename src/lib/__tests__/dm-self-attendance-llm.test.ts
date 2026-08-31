/**
 * resolveDmSelfAttendance — the layered decision (pending prompt → regex
 * fast-path → LLM), with the classifier mocked.
 *
 * NOTE: a stubbed classifier only proves the WIRING. The model's actual
 * behaviour on real wording is validated separately against the LIVE model
 * in e2e/sim/dm-self-attendance-live.spec.ts — this repo has been bitten
 * before by a stubbed sim passing while the real model got it wrong.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const classify = vi.fn();
vi.mock("@/lib/match-availability-classifier", () => ({
  classifyMatchAvailability: (...a: unknown[]) => classify(...a),
}));

import { resolveDmSelfAttendance } from "@/lib/dm-self-attendance";

beforeEach(() => {
  vi.clearAllMocks();
  classify.mockResolvedValue({ decision: "unclear", confidence: 0, reasoning: "stub" });
});

describe("resolveDmSelfAttendance", () => {
  it("a pending prompt wins and the LLM is never called", async () => {
    const res = await resolveDmSelfAttendance({ text: "yeah go on then", hasPendingPrompt: true });
    expect(res).toEqual({ decision: null, via: "pending-prompt" });
    expect(classify).not.toHaveBeenCalled();
  });

  it("the free fast-path decides an unambiguous IN without an LLM call", async () => {
    const res = await resolveDmSelfAttendance({ text: "IN", hasPendingPrompt: false });
    expect(res.decision).toBe("in");
    expect(res.via).toBe("fast-path");
    expect(classify).not.toHaveBeenCalled();
  });

  it("the free fast-path decides an unambiguous OUT without an LLM call", async () => {
    const res = await resolveDmSelfAttendance({ text: "count me out", hasPendingPrompt: false });
    expect(res.decision).toBe("out");
    expect(res.via).toBe("fast-path");
    expect(classify).not.toHaveBeenCalled();
  });

  it("natural wording the fast-path misses goes to the LLM and registers", async () => {
    classify.mockResolvedValue({ decision: "in", confidence: 0.95, reasoning: "casual yes" });
    const res = await resolveDmSelfAttendance({
      text: "yeah sure why not, coming",
      hasPendingPrompt: false,
      context: { clubName: "Sutton FC", wasAskedToPlay: true },
    });
    expect(res.decision).toBe("in");
    expect(res.via).toBe("llm");
    expect(classify).toHaveBeenCalledWith("yeah sure why not, coming", {
      clubName: "Sutton FC",
      wasAskedToPlay: true,
    });
  });

  it("a natural decline the fast-path misses goes to the LLM and drops", async () => {
    classify.mockResolvedValue({ decision: "out", confidence: 0.92, reasoning: "declines" });
    const res = await resolveDmSelfAttendance({
      text: "sorry mate, away that weekend",
      hasPendingPrompt: false,
    });
    expect(res.decision).toBe("out");
    expect(res.via).toBe("llm");
  });

  it("an 'unclear' verdict writes nothing and falls through", async () => {
    classify.mockResolvedValue({ decision: "unclear", confidence: 0.4, reasoning: "hedge" });
    const res = await resolveDmSelfAttendance({
      text: "maybe, I'll let you know",
      hasPendingPrompt: false,
    });
    expect(res.decision).toBeNull();
    expect(res.via).toBe("llm");
  });

  it("a hypothetical is blocked before the model is even asked", async () => {
    const res = await resolveDmSelfAttendance({
      text: "if I was in I would have scored",
      hasPendingPrompt: false,
    });
    expect(res.decision).toBeNull();
    expect(classify).not.toHaveBeenCalled();
  });

  it("an empty body is dropped without an LLM call", async () => {
    const res = await resolveDmSelfAttendance({ text: "   ", hasPendingPrompt: false });
    expect(res.decision).toBeNull();
    expect(res.via).toBe("none");
    expect(classify).not.toHaveBeenCalled();
  });
});
