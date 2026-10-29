/**
 * RED FIRST. The model-free pasted-roster registration decision.
 *
 * The fixtures are the ones already in `pasted-roster.test.ts` — the S26
 * forwarded-roster shape (`4cbdd05`, 2026-04-24) and the real 2026-06-11
 * Thursday-group paste that the PR #35 self-replay sweep proved the
 * incumbent could not reproduce. Nothing here is invented.
 */
import { describe, it, expect } from "vitest";
import {
  clampPastedRosterFacts,
  decidePastedRosterRegistration,
} from "../pasted-roster-registration";
import type { AttendanceFacts, Claim } from "../pipeline/types";

/** S26: the confirmed squad, in Match Context order — exactly what
 *  MatchTime's own roster post lists, which is what an of-record paste
 *  is a forward of. */
const S26_CONFIRMED = [
  "Kemal Ediz",
  "Elvin Aliyev",
  "Sait Demir",
  "Mustafa Kaya",
  "Abid Hussain",
  "Idris Bello",
  "Faris Nasser",
  "Shaz Iqbal",
  "Adam Osman",
  "Efat Rahman",
  "Usama Tariq",
  "Karahan Yildiz",
];

const numbered = (names: string[]) => names.map((n, i) => `${i + 1}. ${n}`).join("\n");

/** The squad restated in order with two names appended. */
const S26_PASTE_TWO_APPENDED = `${numbered(S26_CONFIRMED)}
13. Zair Malik
14. Wasim Akhtar`;

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

describe("decidePastedRosterRegistration — of record", () => {
  it("registers EXACTLY the two appended names, computed from the squad", () => {
    const d = decidePastedRosterRegistration({
      body: S26_PASTE_TWO_APPENDED,
      confirmedNames: S26_CONFIRMED,
      senderNames: ["Kemal Ediz", "Kemal"],
    });
    expect(d.kind).toBe("of_record");
    expect(d.additions).toEqual(["Zair Malik", "Wasim Akhtar"]);
    // The sender is already IN (slot 1), so they are not an addition.
    expect(d.senderAddition).toBeNull();
  });

  it("splits the sender's OWN appended name out of the third-party list", () => {
    const d = decidePastedRosterRegistration({
      body: S26_PASTE_TWO_APPENDED,
      confirmedNames: S26_CONFIRMED,
      senderNames: ["Wasim Akhtar", "Wasim"],
    });
    expect(d.kind).toBe("of_record");
    expect(d.additions).toEqual(["Zair Malik", "Wasim Akhtar"]);
    expect(d.senderAddition).toBe("Wasim Akhtar");
    // The caller registers `additions` minus `senderAddition` for others
    // and turns the sender's own name into registerAttendance: "IN".
    expect(d.additions.filter((n) => n !== d.senderAddition)).toEqual(["Zair Malik"]);
  });

  it("matches a first name in the list against the fuller member record", () => {
    const d = decidePastedRosterRegistration({
      body: "1. Kemal\n2. Elvin\n3. Sait\n4. Mustafa\n5. Zair Malik",
      confirmedNames: S26_CONFIRMED.slice(0, 4),
      senderNames: ["Zair Malik"],
    });
    expect(d.kind).toBe("of_record");
    expect(d.additions).toEqual(["Zair Malik"]);
    expect(d.senderAddition).toBe("Zair Malik");
  });

  it("a straight re-listing with nothing appended registers nobody", () => {
    const d = decidePastedRosterRegistration({
      body: numbered(S26_CONFIRMED),
      confirmedNames: S26_CONFIRMED,
      senderNames: ["Kemal Ediz"],
    });
    expect(d.kind).toBe("of_record");
    expect(d.additions).toEqual([]);
    expect(d.senderAddition).toBeNull();
  });

  it("a null / empty sender name never claims an addition", () => {
    const d = decidePastedRosterRegistration({
      body: S26_PASTE_TWO_APPENDED,
      confirmedNames: S26_CONFIRMED,
      senderNames: [null, null],
    });
    expect(d.kind).toBe("of_record");
    expect(d.senderAddition).toBeNull();
  });
});

describe("decidePastedRosterRegistration — not of record", () => {
  it("the group's OWN ritual order registers nobody", () => {
    // The squad runs Ehtisham, Amir, Nabeel…; the paste runs Ehtisham,
    // Amir, Martin…. Slot 3 settles it — this is a list somebody typed,
    // not a forward of MatchTime's post.
    const d = decidePastedRosterRegistration({
      body: REAL_20260611,
      confirmedNames: ["Ehtisham", "Amir", "Nabeel", "Adam", "Mo"],
      senderNames: ["Youssef"],
    });
    expect(d.kind).toBe("not_of_record");
    expect(d.additions).toEqual([]);
    expect(d.senderAddition).toBeNull();
    expect(d.reason).toBe("prefix-mismatch");
  });

  it("a paste SHORTER than the confirmed squad registers nobody", () => {
    const d = decidePastedRosterRegistration({
      body: numbered(S26_CONFIRMED.slice(0, 5)),
      confirmedNames: S26_CONFIRMED,
      senderNames: ["Kemal Ediz"],
    });
    expect(d.kind).toBe("not_of_record");
    expect(d.additions).toEqual([]);
    expect(d.reason).toBe("prefix-mismatch");
  });

  it("a list against an EMPTY squad registers nobody", () => {
    const d = decidePastedRosterRegistration({
      body: REAL_20260611,
      confirmedNames: [],
      senderNames: ["Youssef"],
    });
    expect(d.kind).toBe("not_of_record");
    expect(d.additions).toEqual([]);
    expect(d.reason).toBe("no-confirmed-squad");
  });

  it("a blank slot inside the restated prefix breaks the match", () => {
    const body = `1. ${S26_CONFIRMED[0]}\n2.\n3. ${S26_CONFIRMED[2]}\n4. ${S26_CONFIRMED[3]}\n5. Zair Malik`;
    const d = decidePastedRosterRegistration({
      body,
      confirmedNames: S26_CONFIRMED.slice(0, 4),
      senderNames: ["Zair Malik"],
    });
    expect(d.kind).toBe("not_of_record");
    expect(d.additions).toEqual([]);
  });
});

describe("decidePastedRosterRegistration — not a roster", () => {
  const NOT_ROSTERS: Array<[string, string]> = [
    ["I'm in for Thursday", "plain prose"],
    ["", "empty"],
    ["1. Ehtisham\n2. Amir\n3. Martin", "three lines is a paragraph, not a list"],
    ["also adding Kieran and Rashad please", "prose naming two people"],
  ];
  for (const [body, why] of NOT_ROSTERS) {
    it(`returns not_a_roster for "${body.slice(0, 30)}" (${why})`, () => {
      const d = decidePastedRosterRegistration({
        body,
        confirmedNames: S26_CONFIRMED,
        senderNames: ["Kemal Ediz"],
      });
      expect(d.kind).toBe("not_a_roster");
      expect(d.additions).toEqual([]);
      expect(d.senderAddition).toBeNull();
      expect(d.reason).toBe("not-a-roster");
    });
  }
});

describe("decidePastedRosterRegistration — properties that must hold", () => {
  it("is pure: the same inputs give the same decision", () => {
    const args = {
      body: S26_PASTE_TWO_APPENDED,
      confirmedNames: S26_CONFIRMED,
      senderNames: ["Wasim Akhtar"],
    };
    expect(decidePastedRosterRegistration(args)).toEqual(
      decidePastedRosterRegistration(args),
    );
  });

  it("never registers anybody the paste does not name", () => {
    const d = decidePastedRosterRegistration({
      body: S26_PASTE_TWO_APPENDED,
      confirmedNames: S26_CONFIRMED,
      senderNames: ["Kemal Ediz"],
    });
    for (const n of d.additions) {
      expect(S26_PASTE_TWO_APPENDED).toContain(n);
    }
  });

  it("never re-registers a name that is already confirmed", () => {
    const body = `${numbered(S26_CONFIRMED)}\n13. Kemal Ediz\n14. Zair Malik`;
    const d = decidePastedRosterRegistration({
      body,
      confirmedNames: S26_CONFIRMED,
      senderNames: ["Kemal Ediz"],
    });
    expect(d.kind).toBe("of_record");
    expect(d.additions).toEqual(["Zair Malik"]);
  });
});

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
