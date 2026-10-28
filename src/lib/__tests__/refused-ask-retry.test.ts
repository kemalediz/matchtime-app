/**
 * "Try again" (2026-10-28, MT Test 15:40 UTC: "@Match Time added the venue
 * location" right after MatchTime refused to ask the pool and the partner
 * clubs). Which ask is repeated comes from stored facts, never from text.
 */
import { describe, it, expect } from "vitest";
import { adminFactsInTrace, retryFactsOf, RETRY_WINDOW_MS } from "../refused-ask-retry";
import type { AdminFacts } from "../pipeline/types";

const NOW = new Date("2026-10-28T15:40:26Z");
const ASKED = new Date("2026-10-28T15:38:04Z");
const recruit = (over: Partial<AdminFacts> = {}): AdminFacts => ({ kind: "admin", action: "recruit", toMatchTime: true, ...over });

describe("retryFactsOf", () => {
  it("the live case: the pool and the partner clubs are asked again, as the same facts", () => {
    const f = retryFactsOf({ facts: recruit({ partnerClubs: true, pool: true }), at: ASKED }, NOW);
    expect(f).toEqual({ kind: "admin", action: "recruit", partnerClubs: true, pool: true, toMatchTime: true });
  });

  it("a partner club by name keeps its name", () => {
    expect(retryFactsOf({ facts: recruit({ partnerClubs: true, clubRef: "Sutton" }), at: ASKED }, NOW)).toMatchObject({ partnerClubs: true, clubRef: "Sutton" });
  });

  it("never repeats a DM to the club's own players: only the partner clubs and the pool", () => {
    expect(retryFactsOf({ facts: recruit({ ownClub: true, pool: true }), at: ASKED }, NOW)).toEqual({ kind: "admin", action: "recruit", pool: true, toMatchTime: true });
    expect(retryFactsOf({ facts: recruit({ lookbackMatches: 5 }), at: ASKED }, NOW)).toBeNull();
    expect(retryFactsOf({ facts: recruit({ sourceUnsaid: true }), at: ASKED }, NOW)).toBeNull();
  });

  it("nothing stored, another action, or an ask too long ago: nothing to repeat", () => {
    expect(retryFactsOf(null, NOW)).toBeNull();
    expect(retryFactsOf({ facts: { kind: "admin", action: "bulk_payment", count: 4 }, at: ASKED }, NOW)).toBeNull();
    expect(retryFactsOf({ facts: recruit({ pool: true }), at: new Date(NOW.getTime() - RETRY_WINDOW_MS - 1) }, NOW)).toBeNull();
  });
});

describe("adminFactsInTrace", () => {
  it("reads the admin extractor's facts off a stored trace", () => {
    const trace = {
      v: 1,
      router: { route: "admin_ops", source: "model", model: "claude-haiku-5-5", floor: false, degradations: [] },
      extractions: [{ owner: "admin_ops", route: "admin_ops", extractor: "admin", model: "m", client: "anthropic", facts: recruit({ pool: true }), degradations: [], calls: [] }],
    };
    expect(adminFactsInTrace(trace)).toEqual(recruit({ pool: true }));
  });

  it("ignores another extractor, dropped facts and anything that is not a trace", () => {
    expect(adminFactsInTrace({ v: 1, extractions: [{ extractor: "attendance", facts: { kind: "attendance", claims: [] } }] })).toBeNull();
    expect(adminFactsInTrace({ v: 1, extractions: [{ extractor: "admin", facts: "[dropped: over the trace budget]" }] })).toBeNull();
    for (const junk of [null, undefined, "x", 3, { v: 1 }, { extractions: "no" }]) expect(adminFactsInTrace(junk)).toBeNull();
  });
});
