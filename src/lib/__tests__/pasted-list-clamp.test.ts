/**
 * THE PASTED-LIST CLAMP, FROM FACTS (2026-10-30).
 *
 * Which message is a pasted list is the router's `pasted_list` flag with
 * the squad reader's answer, never the shape of the words (the
 * `parsePastedRoster` test is deleted). Given that fact, the attendance
 * engine may act on the sender's own OUT and nothing else: PR #55's
 * defect (the drop lost beside a list) in one direction, PR #35's
 * non-determinism (a different squad read off the same paste each run)
 * in the other.
 */
import { describe, it, expect } from "vitest";
import { clampPastedListFacts } from "../pasted-list-signal";
import type { AttendanceFacts, Claim } from "../pipeline/types";

const claim = (over: Partial<Claim> = {}): Claim => ({
  subject: "sender",
  personRef: "",
  personNamed: false,
  polarity: "in",
  contingent: false,
  conditionOn: "none",
  tense: "present",
  reported: false,
  confidence: 0.95,
  ...over,
});
const att = (claims: Claim[], over: Partial<AttendanceFacts> = {}): AttendanceFacts => ({
  kind: "attendance",
  claims,
  affirmation: null,
  sideRequests: [],
  ...over,
});

describe("clampPastedListFacts — a pasted list may carry the sender's drop and nothing else", () => {
  it("KEEPS the sender's own drop beside a list — the defect this exists for", () => {
    const facts = att([claim({ polarity: "out" })]);
    const out = clampPastedListFacts(facts);
    expect(out.facts).toBe(facts);
    expect(out.dropped).toBe(0);
  });

  it("drops every third-party claim read off the list", () => {
    const out = clampPastedListFacts(
      att([
        claim({ polarity: "out" }),
        claim({ subject: "other", personRef: "Mo", personNamed: true }),
        claim({ subject: "other", personRef: "Amir", personNamed: true }),
      ]),
    );
    expect((out.facts as AttendanceFacts).claims).toHaveLength(1);
    expect((out.facts as AttendanceFacts).claims[0].subject).toBe("sender");
    expect(out.dropped).toBe(2);
  });

  it("drops the sender's own IN and bench: who a list registers is the squad reader's answer", () => {
    expect(clampPastedListFacts(att([claim({ polarity: "in" })])).facts.kind).toBe("none");
    expect(clampPastedListFacts(att([claim({ polarity: "bench" })])).facts.kind).toBe("none");
  });

  it("drops the affirmation and the side requests that travelled with the list", () => {
    const facts = clampPastedListFacts(att([claim({ polarity: "out" })], { affirmation: "yes", sideRequests: ["recruit"] }))
      .facts as AttendanceFacts;
    expect(facts.affirmation).toBeNull();
    expect(facts.sideRequests).toEqual([]);
  });

  it("a list that said nothing else becomes `none`, which is how it goes unowned", () => {
    expect(clampPastedListFacts(att([])).facts.kind).toBe("none");
  });

  it("facts of another kind become nothing; `none` passes through", () => {
    expect(clampPastedListFacts({ kind: "none" }).facts.kind).toBe("none");
  });

  it("is pure", () => {
    const facts = att([claim({ polarity: "out" }), claim({ subject: "other", personRef: "Mo" })]);
    expect(clampPastedListFacts(facts)).toEqual(clampPastedListFacts(facts));
  });
});
