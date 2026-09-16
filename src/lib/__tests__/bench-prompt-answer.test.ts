/**
 * RED FIRST. The bench-prompt answer recogniser — the deterministic
 * replacement for the mega-prompt's `verdict.benchConfirmation`.
 *
 * The module is only ever consulted when the DB already says THIS EXACT
 * SENDER has an unanswered `PendingBenchConfirmation` open, so the prior
 * that a short message is an answer is enormous. The tests below are
 * therefore split in two: the forms a person actually sends in reply to
 * "do you want the slot?", and an adversarial table of near-misses that
 * must return `null` because they carry a second clause, ask a question,
 * or merely happen to START with an answer word.
 */
import { describe, it, expect } from "vitest";
import { readBenchPromptAnswer } from "../bench-prompt-answer";

describe("readBenchPromptAnswer — affirmatives", () => {
  const YES = [
    "yes",
    "Yes",
    "YES",
    "yes!",
    "yes!!!",
    "yesss",
    "yep",
    "yeah",
    "yeh",
    "yea",
    "yup",
    "yh",
    "ya",
    "y",
    "Y",
    "sure",
    "ok",
    "Ok",
    "okay",
    "in",
    "In",
    "IN",
    "i'm in",
    "im in",
    "I'm in!",
    "am in",
    "count me in",
    "please",
    "yes please",
    "yes please mate",
    "go on then",
    "go on",
    "yeah go on then",
    "deal",
    "take it",
    "i'll take it",
    "confirmed",
    "can do",
    "👍",
    "✅",
    "✔️",
    "🙋",
    "👍👍",
    "yes 👍",
    "👍 yes",
    "ok 👍",
    "yes mate",
    "yeah mate",
    "in mate",
    "yes cheers",
    "yes thanks",
    "in tonight",
    "sure thing",
    // The tag is not required, but it must not break the read either.
    "@Match Time yes",
    "@MatchTime in",
    "@MT yes please",
  ];
  for (const body of YES) {
    it(`reads "${body}" as yes`, () => {
      expect(readBenchPromptAnswer(body)).toBe("yes");
    });
  }
});

describe("readBenchPromptAnswer — negatives", () => {
  const NO = [
    "no",
    "No",
    "NO",
    "no!",
    "nooo",
    "nope",
    "nah",
    "naah",
    "n",
    "N",
    "can't",
    "cant",
    "cannot",
    "sorry can't",
    "sorry cant",
    "sorry mate can't",
    "can't make it",
    "cant make it",
    "cant tonight",
    "nah mate can't tonight",
    "no thanks",
    "no thank you",
    "no ta",
    "pass",
    "out",
    "i'm out",
    "im out",
    "count me out",
    "next time",
    "unable",
    "won't make it",
    "wont make it",
    "not tonight",
    "not this week",
    "not available",
    "👎",
    "❌",
    "🙅",
    "no 👎",
    "nah sorry",
    "sorry",
    "@Match Time no",
  ];
  for (const body of NO) {
    it(`reads "${body}" as no`, () => {
      expect(readBenchPromptAnswer(body)).toBe("no");
    });
  }
});

describe("readBenchPromptAnswer — the adversarial near-miss table", () => {
  /** Every one of these either carries a SECOND clause, asks a question,
   *  or merely begins with an answer word. A model would guess; this
   *  module must return null and let the message fall through. */
  const NULLS: Array<[string, string]> = [
    ["no idea what time we're playing", "starts with 'no', is not an answer"],
    ["yes but I can only do the first half", "a conditional, not a yes"],
    ["yes if nobody else wants it", "a condition"],
    ["in a bit", "'in' as a preposition"],
    ["I'm in London this week", "'in' as a preposition"],
    ["ok so who's playing", "an 'ok' that opens a question"],
    ["ok mate what time", "second clause"],
    ["yes?", "a question"],
    ["in?", "a question"],
    ["am I in?", "a question"],
    ["can't wait", "'cant' as enthusiasm"],
    ["can't believe we lost", "'cant' about something else"],
    ["out of town this weekend", "'out' as a preposition"],
    ["pass it to me next time", "'pass' as football"],
    ["please can someone send the address", "'please' opening a request"],
    ["sure, is Kieran playing?", "a question"],
    ["yes and can you put my brother down too", "a second, third-party clause"],
    ["no I meant next week", "a correction"],
    ["y'all playing tonight", "not a bare y"],
    ["nah I meant the Tuesday game", "a correction"],
    ["👍👎", "contradictory emoji"],
    ["👍 but only if we're short", "an emoji with a condition"],
    ["", "empty"],
    ["   ", "whitespace"],
    ["@Match Time", "the tag alone"],
    ["⚽", "an unrelated emoji"],
    ["thanks", "an acknowledgement, not an answer"],
    ["cheers mate", "an acknowledgement"],
    ["what time is kick off", "a question"],
    ["yeah I'll be there next week instead", "deferred to another match"],
    [
      "yes mate no worries I'll be there but might be ten minutes late",
      "a long sentence",
    ],
  ];
  for (const [body, why] of NULLS) {
    it(`returns null for "${body}" (${why})`, () => {
      expect(readBenchPromptAnswer(body)).toBeNull();
    });
  }

  /** A hedge, a bare modal, or an emoji that means something warmer than
   *  a claim. Each was a false positive found by probing the module
   *  outside its own test table. */
  const PROBED_NULLS: Array<[string, string]> = [
    ["maybe not", "a hedge, not an answer"],
    ["i can", "a bare modal — can what?"],
    ["🤝", "a handshake is not a claim"],
    ["🤙", "not in either emoji set"],
    ["🤷", "a shrug is not a decline"],
    ["pass it", "football, not a decline"],
    ["ok cool", "an acknowledgement of something else"],
    ["no worries", "reassurance, not a decline"],
    ["no this is the wrong week", "a correction"],
    ["no not that one", "a correction"],
    ["still in", "trailing filler cannot open an answer"],
    ["one", "a qualifier alone"],
  ];
  for (const [body, why] of PROBED_NULLS) {
    it(`returns null for "${body}" (${why})`, () => {
      expect(readBenchPromptAnswer(body)).toBeNull();
    });
  }

  it("reads the EMOJI when the only words are courtesy", () => {
    expect(readBenchPromptAnswer("👍 thanks")).toBe("yes");
    expect(readBenchPromptAnswer("✅ cheers")).toBe("yes");
    expect(readBenchPromptAnswer("❌ sorry mate")).toBe("no");
  });

  it("accepts a trailing match qualifier on either polarity", () => {
    expect(readBenchPromptAnswer("out this week")).toBe("no");
    expect(readBenchPromptAnswer("in for this one")).toBe("yes");
    expect(readBenchPromptAnswer("yes for tonight")).toBe("yes");
    expect(readBenchPromptAnswer("i can play")).toBe("yes");
  });

  it("is pure — the same string always reads the same way", () => {
    for (const s of ["yes", "nah mate can't tonight", "no idea what time"]) {
      expect(readBenchPromptAnswer(s)).toBe(readBenchPromptAnswer(s));
    }
  });

  it("tolerates a null-ish body without throwing", () => {
    expect(readBenchPromptAnswer(null as unknown as string)).toBeNull();
    expect(readBenchPromptAnswer(undefined as unknown as string)).toBeNull();
  });
});

// ── Turkish (2026-09-16) ───────────────────────────────────────────────
//
// No model stands behind this module: an answer it does not recognise
// WHOLE is `null` and nothing happens. A Turkish bencher answering the
// slot offer in the group with one word must not be that nothing.
describe("readBenchPromptAnswer — Turkish", () => {
  it.each(["evet", "Evet", "evet!", "tamam", "olur", "varım", "Varım", "varim", "var", "evet varım", "tamam varım 👍"])(
    "%s → yes",
    (body) => {
      expect(readBenchPromptAnswer(body)).toBe("yes");
    },
  );

  it.each(["hayır", "Hayır", "hayir", "yok", "Yok.", "yokum", "ben yokum", "gelemiyorum", "hayır gelemiyorum"])(
    "%s → no",
    (body) => {
      expect(readBenchPromptAnswer(body)).toBe("no");
    },
  );

  it.each(["var mı?", "evet ama geç kalırım", "yok artık", "belki", "bakarız", "kesin değil"])(
    "%s → null (not a whole answer)",
    (body) => {
      expect(readBenchPromptAnswer(body)).toBeNull();
    },
  );
});
