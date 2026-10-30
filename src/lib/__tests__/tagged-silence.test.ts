/**
 * A message tagged to MatchTime is never met with silence (MT Test,
 * 2026-10-29: "@Match Time invite players from pool" from the owner, routed
 * `offer`, came away with a bare "chase" and MatchTime said nothing, twice).
 * Decided from the OUTCOME the batch ended with, never from the words.
 */
import { describe, it, expect } from "vitest";
import { taggedSilence, type TaggedSilenceInput } from "../tagged-silence";

const base: TaggedSilenceInput = {
  taggedExplicitly: true,
  senderKnown: true,
  late: false,
  capped: false,
  gated: false,
  refused: false,
  readFailed: false,
  answeredBySquadPost: false,
  route: "offer",
  result: { reply: null, react: null, intent: "noise", handledBy: "llm" },
};
type Over = Omit<Partial<TaggedSilenceInput>, "result"> & { result?: Partial<TaggedSilenceInput["result"]> };
const w = (o: Over): TaggedSilenceInput => ({
  ...base,
  ...o,
  result: { ...base.result, ...(o.result ?? {}) },
});

describe("taggedSilence", () => {
  it("fires on a tagged message from a known member that ended with nothing at all", () => {
    expect(taggedSilence(base)).toBe(true);
    expect(taggedSilence(w({ route: "unsure" }))).toBe(true);
    expect(taggedSilence(w({ route: "self_att" }))).toBe(true);
    expect(taggedSilence(w({ route: "question", result: { handledBy: "ignored" } }))).toBe(true);
    expect(taggedSilence(w({ result: { intent: "unclear" } }))).toBe(true);
  });

  it("does not fire without an explicit tag", () => {
    expect(taggedSilence(w({ taggedExplicitly: false }))).toBe(false);
  });

  it("does not fire for a sender who is not a known member", () => {
    expect(taggedSilence(w({ senderKnown: false }))).toBe(false);
  });

  it("does not fire when MatchTime already spoke or ticked", () => {
    expect(taggedSilence(w({ result: { reply: "Done." } }))).toBe(false);
    expect(taggedSilence(w({ result: { react: "✅" } }))).toBe(false);
    expect(taggedSilence(w({ result: { react: "👍" } }))).toBe(false);
  });

  it("does not fire when something was written or queued (the intent says so)", () => {
    for (const intent of ["in", "out", "conditional_in", "replacement_request", "pool_ask", "partner_ask", "recruit_ask_source", "question"]) {
      expect(taggedSilence(w({ result: { intent } }))).toBe(false);
    }
  });

  it("does not fire on banter or thanks (the router's `none`)", () => {
    expect(taggedSilence(w({ route: "none" }))).toBe(false);
  });

  it("does not fire with no route at all (a router failure is the operator note's)", () => {
    expect(taggedSilence(w({ route: undefined }))).toBe(false);
  });

  it("does not fire on a late, capped or gated message, or an error", () => {
    expect(taggedSilence(w({ late: true }))).toBe(false);
    expect(taggedSilence(w({ capped: true }))).toBe(false);
    expect(taggedSilence(w({ gated: true }))).toBe(false);
    expect(taggedSilence(w({ result: { handledBy: "error" } }))).toBe(false);
  });

  // e2e/api/clause-peel.spec.ts:397, e2e/sim/stats-blast.spec.ts:165 (2026-10-30):
  // a player's tagged "who hasn't rated yet" / "send everyone their stats" was
  // refused by the engine's admin gate, which is silent by design, and then
  // told "I didn't catch what you'd like me to do".
  it("does not fire on a permission refusal: that silence is designed", () => {
    expect(taggedSilence(w({ refused: true }))).toBe(false);
  });

  // e2e/sim/attendance-engine-overload.spec.ts:158: the extractor failed (529)
  // and the sender was told he was not understood. A system failure is the
  // operator note's, like a write that threw.
  it("does not fire when the model read of the message failed", () => {
    expect(taggedSilence(w({ readFailed: true, route: "other_att", result: { handledBy: "ignored" } }))).toBe(false);
  });

  // e2e/sim/squad-post.spec.ts:77: "who's on the bench?" beside somebody's IN
  // is answered by the batch's one squad post, and got a second message.
  it("does not fire on a squad question the batch's squad post answered", () => {
    expect(taggedSilence(w({ answeredBySquadPost: true, route: "question", result: { handledBy: "ignored" } }))).toBe(false);
  });
});
