/**
 * The differ, under test.
 *
 * Two things this file exists to pin:
 *
 * 1. Disagreements are classified on WRITES and DECISIONS, never on
 *    wording. Two replies that word the same registration differently
 *    are not a disagreement.
 * 2. **The old pipeline is not ground truth.** A structural class says
 *    who wrote what; only a human adjudication says who was RIGHT. Until
 *    someone adjudicates, §10 step 3's verdict is `null` — undecided —
 *    never a quiet pass.
 */
import { describe, expect, it } from "vitest";
import type { CorpusObservation } from "../corpus/grade";
import { diffRun, rollUpCriteria, writeSetOf } from "./diff";
import type { Adjudication, CaseDiff } from "./diff";

const ROSTER = [
  { name: "Pete Power", status: "CONFIRMED" as const },
  { name: "Dan Drummer", status: "CONFIRMED" as const },
];

function obs(over: Partial<CorpusObservation> = {}): CorpusObservation {
  return {
    attendanceBefore: ROSTER,
    attendanceAfter: ROSTER,
    memberNamesBefore: ["Pete Power", "Dan Drummer"],
    memberNamesAfter: ["Pete Power", "Dan Drummer"],
    spoken: [],
    dms: [],
    reacts: [null],
    benchOffersOpen: 0,
    ...over,
  };
}

const KEY = "g-abc:2026-05-12T18:30:00.000Z";
/** The world's players — "names a player" is scoped to these. */
const NAMES = ["Pete Power", "Dan Drummer", "Gina Gale", "Najib Ahmadi", "Mojib Ahmadi"];

function run(a: CorpusObservation, b: CorpusObservation): CaseDiff {
  return diffRun(KEY, { ok: true, observation: a }, { ok: true, observation: b }, NAMES);
}

describe("writeSetOf", () => {
  it("reads the delta, not the end state", () => {
    const w = writeSetOf(
      obs({
        attendanceAfter: [...ROSTER, { name: "Gina Gale", status: "BENCH" }],
        memberNamesAfter: ["Pete Power", "Dan Drummer", "Gina Gale"],
        benchOffersOpen: 1,
      }),
    );
    expect(w.attendance).toEqual([{ name: "Gina Gale", from: "ABSENT", to: "BENCH" }]);
    expect(w.newMembers).toEqual(["Gina Gale"]);
    expect(w.benchOffersDelta).toBe(1);
  });

  it("is empty when nothing moved", () => {
    expect(writeSetOf(obs()).attendance).toEqual([]);
  });
});

describe("diffRun — agreement", () => {
  it("calls identical runs agreed", () => {
    const d = run(obs(), obs());
    expect(d.agree).toBe(true);
    expect(d.classes).toEqual([]);
    expect(d.primary).toBeNull();
  });

  it("ignores wording: two different sentences about the same write agree", () => {
    const after = [...ROSTER, { name: "Gina Gale", status: "CONFIRMED" as const }];
    const members = ["Pete Power", "Dan Drummer", "Gina Gale"];
    const a = obs({ attendanceAfter: after, memberNamesAfter: members, spoken: ["Gina, you're in 👍"] });
    const b = obs({ attendanceAfter: after, memberNamesAfter: members, spoken: ["Added Gina — 3 confirmed."] });
    const d = run(a, b);
    expect(d.agree).toBe(true);
  });

  it("does NOT ignore whether the bot spoke at all", () => {
    const d = run(obs({ spoken: ["you're in"] }), obs({ spoken: [] }));
    expect(d.agree).toBe(false);
    expect(d.primary).toBe("speech_only");
  });

  it("does not ignore which PLAYER the reply names", () => {
    const d = run(obs({ spoken: ["Najib, you're on the bench"] }), obs({ spoken: ["Mojib, you're on the bench"] }));
    expect(d.classes).toContain("speech_only");
    expect(d.speechOld.namesMentioned).toEqual(["Najib"]);
    expect(d.speechNew.namesMentioned).toEqual(["Mojib"]);
  });

  it("flags a raw phone number in one side's text and not the other", () => {
    const d = run(obs({ spoken: ["ring 07700900123"] }), obs({ spoken: ["ring him"] }));
    expect(d.speechOld.rawPhone).toBe(true);
    expect(d.speechNew.rawPhone).toBe(false);
    expect(d.classes).toContain("speech_only");
  });
});

describe("diffRun — the two dangerous classes", () => {
  const wrote = obs({
    attendanceAfter: [...ROSTER, { name: "Gina Gale", status: "CONFIRMED" }],
    memberNamesAfter: ["Pete Power", "Dan Drummer", "Gina Gale"],
  });

  it("NEW writes where OLD did not → spurious_write (§10 target: zero)", () => {
    const d = run(obs(), wrote);
    expect(d.primary).toBe("spurious_write");
    expect(d.onlyNew).toEqual([{ name: "Gina Gale", from: "ABSENT", to: "CONFIRMED" }]);
  });

  it("OLD writes where NEW did not → missed_write (§10 target: ≤2%)", () => {
    const d = run(wrote, obs());
    expect(d.primary).toBe("missed_write");
    expect(d.onlyOld).toEqual([{ name: "Gina Gale", from: "ABSENT", to: "CONFIRMED" }]);
  });

  it("both write, differently → divergent_write", () => {
    const benched = obs({
      attendanceAfter: [...ROSTER, { name: "Gina Gale", status: "BENCH" }],
      memberNamesAfter: ["Pete Power", "Dan Drummer", "Gina Gale"],
    });
    const d = run(wrote, benched);
    expect(d.primary).toBe("divergent_write");
    expect(d.conflicting).toEqual([
      { name: "Gina Gale", old: "CONFIRMED", new: "BENCH", from: "ABSENT" },
    ]);
  });

  it("ranks a spurious write above everything else it happens alongside", () => {
    const d = run(obs({ spoken: ["nothing to do"] }), wrote);
    expect(d.classes).toEqual(expect.arrayContaining(["spurious_write", "speech_only"]));
    expect(d.primary).toBe("spurious_write");
  });

  it("records a run that threw as an error, not as a measurement", () => {
    const d = diffRun(KEY, { ok: false, error: "timeout" }, { ok: true, observation: obs() }, NAMES);
    expect(d.primary).toBe("error");
    expect(d.agree).toBe(false);
  });
});

describe("rollUpCriteria — the incumbent is not ground truth", () => {
  const wrote = obs({
    attendanceAfter: [...ROSTER, { name: "Gina Gale", status: "CONFIRMED" }],
    memberNamesAfter: ["Pete Power", "Dan Drummer", "Gina Gale"],
  });

  const spurious = () => run(obs(), wrote);
  const missed = () => run(wrote, obs());

  it("refuses to declare step 3 passed while a disagreement is unadjudicated", () => {
    const c = rollUpCriteria([run(obs(), obs()), spurious()], []);
    expect(c.disagreements).toBe(1);
    expect(c.spuriousWriteUnadjudicated).toBe(1);
    expect(c.spuriousWriteRuns).toBe(0);
    // Undecided, NOT a pass. A structural class says who wrote; only a
    // human says who was right.
    expect(c.passesStep3).toBeNull();
  });

  it("counts a spurious write only once a human says the old pipeline was right", () => {
    const adj: Adjudication[] = [{ key: KEY, verdict: "old_right", note: "no such player" }];
    const c = rollUpCriteria([spurious()], adj);
    expect(c.spuriousWriteRuns).toBe(1);
    expect(c.passesStep3).toBe(false); // target is zero
  });

  it("does NOT count a missed write when the new pipeline was right to stay out", () => {
    const adj: Adjudication[] = [
      { key: KEY, verdict: "new_right", note: "the old one registered a nickname as a new player" },
    ];
    const c = rollUpCriteria([missed()], adj);
    expect(c.missedWriteRuns).toBe(0);
    expect(c.newPipelineBetter).toBe(1);
    expect(c.passesStep3).toBe(true);
  });

  it("computes the missed-write rate over runs, and applies the 2% bar", () => {
    const agrees = Array.from({ length: 99 }, () => run(obs(), obs()));
    const adj: Adjudication[] = [{ key: KEY, verdict: "old_right", note: "he really was in" }];
    const c = rollUpCriteria([...agrees, missed()], adj);
    expect(c.runs).toBe(100);
    expect(c.missedWriteRuns).toBe(1);
    expect(c.missedWriteRate).toBeCloseTo(0.01, 5);
    expect(c.passesStep3).toBe(true);

    const worse = rollUpCriteria([...agrees.slice(0, 32), missed()], adj);
    expect(worse.missedWriteRate).toBeGreaterThan(0.02);
    expect(worse.passesStep3).toBe(false);
  });

  it("separates 'both wrong' from either pipeline being right", () => {
    const adj: Adjudication[] = [{ key: KEY, verdict: "both_wrong", note: "neither read the sentence" }];
    const c = rollUpCriteria([missed()], adj);
    expect(c.bothWrong).toBe(1);
    expect(c.missedWriteRuns).toBe(0);
  });

  it("keeps errored runs out of the denominators and reports them", () => {
    const errored = diffRun(KEY, { ok: false, error: "boom" }, { ok: true, observation: obs() }, NAMES);
    const c = rollUpCriteria([run(obs(), obs()), errored], []);
    expect(c.runs).toBe(1);
    expect(c.errors).toBe(1);
  });
});
