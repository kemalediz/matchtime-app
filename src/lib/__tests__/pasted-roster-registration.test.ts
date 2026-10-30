/**
 * The pasted-roster clamp (kept for the attendance engine until its
 * owner replaces the shape test with a fact; see the module header).
 *
 * The fixtures are the ones already in `pasted-roster.test.ts` — the S26
 * forwarded-roster shape (`4cbdd05`, 2026-04-24) and the real 2026-06-11
 * Thursday-group paste that the PR #35 self-replay sweep proved the
 * incumbent could not reproduce. Nothing here is invented.
 */
import { describe, it, expect } from "vitest";
import {
  clampPastedRosterFacts,
} from "../pasted-roster-registration";
import type { AttendanceFacts, Claim } from "../pipeline/types";

/** The real 2026-06-11 paste (Youssef). Word-joiners, shouted NABEEL,
 *  the "Yusuf.i" handle and a duplicated Adam all survive the copy. */
const REAL_20260611 = `In sha Allah 9pm Thursday 11 June Wimbledon Goals 7 a side football:

1. Ehtisham
2. Amir
3. ⁠Martin
4. Adam
5. Mo
6. ⁠ NABEEL
7. ⁠Talha
8. ⁠Yusuf.i
9. ⁠Amz
10. Youssef
11. ⁠Ersin
12. ⁠Omar
13. ⁠Adam
14. Arjun`;

/* ══════════════════════════════════════════════════════════════════════
 * THE CLAMP — what a roster-shaped message is allowed to ALSO say
 * ══════════════════════════════════════════════════════════════════════
 *
 * RED FIRST, against the defect PR #55 found and marked `test.fail()`:
 * the route peeled a pasted roster out of the batch entirely, so a
 * message that was BOTH a list and its sender's own drop lost the drop
 * and the player stayed CONFIRMED.
 *
 * `clampPastedRosterFacts` is what makes it safe to stop peeling. These
 * cases pin BOTH directions: the drop survives, and absolutely nothing
 * else does.
 */
describe("clampPastedRosterFacts — a roster may carry the sender's drop and nothing else", () => {
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

  /** "can't make it lads, someone take my spot" above the real paste —
   *  the exact production shape the e2e spec replays. */
  const DROP_PLUS_PASTE = `can't make it lads, someone take my spot\n${REAL_20260611}`;

  it("is not a roster at all → the facts pass through untouched, by identity", () => {
    const facts = att([claim({ polarity: "out" })]);
    const out = clampPastedRosterFacts("sorry lads can't make it", facts);
    // Identity, not deep equality: callers use `===` to decide whether
    // this function had an opinion at all.
    expect(out.facts).toBe(facts);
    expect(out.dropped).toBe(0);
  });

  it("KEEPS the sender's own drop beside a paste — the defect this exists for", () => {
    const out = clampPastedRosterFacts(DROP_PLUS_PASTE, att([claim({ polarity: "out" })]));
    expect(out.facts.kind).toBe("attendance");
    expect((out.facts as AttendanceFacts).claims).toHaveLength(1);
    expect((out.facts as AttendanceFacts).claims[0].polarity).toBe("out");
  });

  it("drops every third-party claim read off the list", () => {
    // PR #35's measurement: the same paste, the same world, `Nabeel` one
    // run and `Adam, Amir, Ehtisham, Martin` the next. Who a list
    // registers is arithmetic, never a reading.
    const out = clampPastedRosterFacts(
      DROP_PLUS_PASTE,
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

  it("drops the sender's own IN — the of-record branch computes that arithmetically", () => {
    // A sender whose name is a slot ("4. Adam", sent by Adam) is read as
    // a self IN on one run and not on the next. The not-of-record rule
    // is "registers NOBODY", and a model must not be able to overturn
    // it; the of-record rule already registers an appended sender from
    // `senderAddition`.
    const out = clampPastedRosterFacts(REAL_20260611, att([claim({ polarity: "in" })]));
    expect(out.facts.kind).toBe("none");
    expect(out.dropped).toBe(1);
  });

  it("drops a bench claim about the sender — a paste cannot bench anybody", () => {
    const out = clampPastedRosterFacts(REAL_20260611, att([claim({ polarity: "bench" })]));
    expect(out.facts.kind).toBe("none");
  });

  it("drops the affirmation and the side requests that travelled with the list", () => {
    const out = clampPastedRosterFacts(
      DROP_PLUS_PASTE,
      att([claim({ polarity: "out" })], { affirmation: "yes", sideRequests: ["recruit"] }),
    );
    const facts = out.facts as AttendanceFacts;
    expect(facts.affirmation).toBeNull();
    expect(facts.sideRequests).toEqual([]);
  });

  it("a paste that said nothing else becomes `none`, which is how it goes unowned", () => {
    const out = clampPastedRosterFacts(REAL_20260611, att([]));
    expect(out.facts.kind).toBe("none");
  });

  it("is pure — the same input twice gives the same answer", () => {
    const facts = att([claim({ polarity: "out" }), claim({ subject: "other", personRef: "Mo" })]);
    expect(clampPastedRosterFacts(DROP_PLUS_PASTE, facts)).toEqual(
      clampPastedRosterFacts(DROP_PLUS_PASTE, facts),
    );
  });

  it("never invents a claim: the kept claims are a SUBSET of what was extracted", () => {
    const kept = claim({ polarity: "out" });
    const out = clampPastedRosterFacts(
      DROP_PLUS_PASTE,
      att([kept, claim({ subject: "other", personRef: "Mo", personNamed: true })]),
    );
    expect((out.facts as AttendanceFacts).claims[0]).toBe(kept);
  });
});
