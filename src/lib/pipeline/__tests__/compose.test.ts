/**
 * STAGE 4 — COMPOSITION.
 *
 * §6.4: "Every outgoing message is composed from the database AFTER the
 * writes land. Numbers and names are never model-authored, so they
 * cannot be wrong, so nothing needs to check them afterwards."
 *
 * That last clause is the deletion of `enforceCanonicalRoster` — 140
 * lines of regex in six sub-passes, every one of which exists because
 * the model authors the squad text and gets it wrong. The correct
 * deterministic composer, `composeSquadStatusPost()`, already exists
 * forty lines above it and is used only as a fallback. Here it is the
 * ONLY path.
 */
import { describe, it, expect } from "vitest";
import { compose } from "../compose";
import { decide } from "../engine";
import {
  composeSquadStatusPost,
  contradictsSquadState,
  displaysSquadState,
} from "../../group-copy";
import { NOW, SUTTON, attendanceFacts, claim, fullName, msg, world } from "./helpers";
import type { EngineResult, SquadState } from "../types";

function composeFor(state: SquadState, messages: Parameters<typeof decide>[0]["messages"]) {
  const result: EngineResult = decide({ now: NOW, state, messages });
  return { result, out: compose(result) };
}

const TEN = ["kemal", "elvin", "sait", "mustafa", "abid", "idris", "faris", "shaz", "adam", "efat"];

/** A tagged "who's playing?", which is what MAKES the batch-level roster
 *  post since 2026-09-09 (S36b). The post is demand-driven now: an
 *  attendance change on its own produces the ✅ and nothing else, so a
 *  test about the post's CONTENT has to ask for it. */
const rosterAsk = (from: string) =>
  msg({
    from,
    body: "@Match Time who's playing?",
    route: "question",
    tagged: true,
    facts: { kind: "question", topic: "squad", personRef: null, statedCount: null },
  });

describe("the squad post is read out of the projected state", () => {
  it("states the count AFTER the write, never the one before (2026-04-26, Wasim, ef8d801)", () => {
    const state = world({ confirmed: [...TEN, "usama", "karahan", "zair", "wasim"] });
    const { out } = composeFor(state, [
      msg({
        from: "wasim",
        body: "out sorry lads",
        route: "self_att",
        facts: attendanceFacts([claim({ polarity: "out" })]),
      }),
      rosterAsk("adam"),
    ]);
    const text = out.utterances.map((u) => u.text).join("\n");
    expect(text).toContain("13/14");
    expect(text).not.toContain("12/14");
    expect(text).not.toMatch(/full squad/i);
    // The incident omitted a confirmed player from the reordered roster.
    expect(text).toContain("Zair Malik");
  });

  it("lists the bench when there is one, and never invents one when there is not", () => {
    const withBench = world({
      confirmed: [...TEN, "usama", "karahan", "zair", "wasim"],
      bench: ["najib"],
    });
    const a = compose(
      decide({
        now: NOW,
        state: withBench,
        messages: [
          msg({ from: "amir", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
          rosterAsk("adam"),
        ],
      }),
    );
    expect(a.utterances.map((u) => u.text).join()).toMatch(/Bench \(2\)/);

    const noBench = world({ confirmed: TEN });
    const b = compose(
      decide({
        now: NOW,
        state: noBench,
        messages: [
          msg({ from: "amir", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
          rosterAsk("adam"),
        ],
      }),
    );
    expect(b.utterances.map((u) => u.text).join()).not.toMatch(/Bench \(/);
  });

  it("says NOTHING at all for a batch that only changed the squad (2026-09-09)", () => {
    // The other half of the property above, and the reason this file
    // needed `rosterAsk`. Kemal, on the live group: "for every IN, MT is
    // responding with the squad. I think that is overmessaging. Only a
    // tick is enough."
    const { out } = composeFor(world({ confirmed: TEN }), [
      msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      msg({ from: "karahan", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    expect(out.utterances).toEqual([]);
    // …and the players are still told, by the ✅ each message gets.
    expect(out.reacts.map((r) => r.emoji)).toEqual(["✅", "✅"]);
  });

  it("says exactly one thing for a batch of three squad messages (§3.2 S36)", () => {
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      msg({ from: "karahan", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
      msg({
        from: "zair",
        body: "@Match Time how many are we now?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "count", personRef: null, statedCount: null },
      }),
    ]);
    expect(out.utterances).toHaveLength(1);
    expect(out.utterances[0].text).toContain("12/14");
  });
});

describe("questions are answered from state, not from the model", () => {
  it("corrects a wrong stated count with the real number (§3.2 S24)", () => {
    const state = world({ confirmed: [...TEN, "usama"] });
    const { out } = composeFor(state, [
      msg({
        from: "amir",
        body: "@Match Time we're 9/14 right?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "count", personRef: null, statedCount: 9 },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("11");
    expect(text).not.toMatch(/yes.{0,20}9\/14/i);
  });

  it("names the bench and speculates about nothing (§3.2 S16)", () => {
    const state = world({ confirmed: [...TEN, "usama", "najib", "zair", "wasim"], bench: ["karahan"] });
    const { out } = composeFor(state, [
      msg({
        from: "adam",
        body: "@Match Time who's on the bench?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "bench", personRef: null, statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("Karahan");
    expect(text).not.toMatch(/5-a-side|downgrade|if we shrink/i);
  });

  it("answers 'is X coming?' without claiming a registration that never happened", () => {
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({
        from: "kemal",
        body: "@Match Time is Amir also coming or not?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "person_status", personRef: "Amir", statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("Amir");
    expect(text).not.toMatch(/Amir[^.\n]{0,40}\b(is|'s) (confirmed|in the squad|playing)/);
  });

  it("answers 'who has no number?' with names and never a digit (§3.2 S32)", () => {
    const state = world({
      players: ["kemal", "elvin", "sait", "gary", "walt"],
      confirmed: ["kemal", "elvin", "sait", "gary", "walt"],
      noPhone: ["gary", "walt"],
    });
    const { out } = composeFor(state, [
      msg({
        from: "kemal",
        body: "@Match Time who has no phone number on record?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "phones", personRef: null, statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("gary");
    expect(text).toContain("walt");
    expect(text).not.toMatch(/(?:\+\d[\d\s().-]{8,}\d)|(?:\b0\d{9,10}\b)|(?:\b\d{11,}\b)/);
  });

  it("answers a stats question with NO squad block appended (§3.2 S16, cf6ed22)", () => {
    const state = world({
      confirmed: TEN.slice(0, 6),
      appearances: [
        { userId: "u-kemal", matches: 9 },
        { userId: "u-elvin", matches: 7 },
        { userId: "u-sait", matches: 2 },
      ],
    });
    const { out } = composeFor(state, [
      msg({
        from: "shaz",
        body: "@Match Time who's been the most consistent?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "stats", personRef: null, statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("Kemal");
    expect(text).not.toMatch(/\b\d{1,2}\/14\b/);
    expect(text).not.toMatch(/Reply \*?IN/);
  });

  it("answers 'what are our options?' without naming anyone as benched (§3.2 S34)", () => {
    // 2026-08-30: the model computed 8 − 5 instead of 8 − 10 and told a
    // real customer group that "Najib + Mojib + Mustafa go on the bench"
    // when a switch would have benched nobody. format-switch.ts computes
    // it; the composer copies the answer.
    const state = world({
      confirmed: ["kemal", "elvin", "sait", "mustafa", "abid", "najib", "mojib", "idris"],
      smallerFormats: [{ sportName: "Football 5-a-side", totalPlayers: 10 }],
    });
    const { out } = composeFor(state, [
      msg({
        from: "kemal",
        body: "@Match Time we're only 8, what are our options?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "options", personRef: null, statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).not.toMatch(/(Najib|Mojib|Mustafa)[^.\n]{0,60}\bbench\b/);
    expect(text).not.toMatch(/\bgo(?:es)? on the bench\b/);
  });

  // ── THE TWO ANSWERS THAT WERE BUILT AND THEN REFUSED ───────────────
  //
  // `answer_stats` and `answer_options` were composed correctly and
  // never allowed to speak, because `route.ts:2480` runs
  // `composeSquadStateReply` over every step-7 reply (they are pushed
  // into `results` with `handledBy: "llm"`, `route.ts:2126`) and both
  // shapes tripped `displaysSquadState`. A tripped reply is REPLACED by
  // the upcoming-squad roster — the 2026-05-14 incident where "top 3
  // most consistent" came back as the squad list.
  //
  // So the fix is in the FORMAT, and this is where it is pinned: these
  // two must be invisible to that composer, in the two states that
  // matter (a real answer, and the empty-data answer).
  it("the composed STATS answer is not mistaken for squad state (2026-05-14)", () => {
    const state = world({
      confirmed: TEN.slice(0, 6),
      appearances: [
        { userId: "u-kemal", matches: 9 },
        { userId: "u-elvin", matches: 7 },
        { userId: "u-sait", matches: 2 },
      ],
    });
    const { out } = composeFor(state, [
      msg({
        from: "shaz",
        body: "@Match Time who's been the most consistent?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "stats", personRef: null, statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("Kemal");
    expect(displaysSquadState(text)).toBe(false);
  });

  it("the STATS answer with no appearances yet is not mistaken for squad state", () => {
    const state = world({ confirmed: TEN.slice(0, 6), appearances: [] });
    const { out } = composeFor(state, [
      msg({
        from: "shaz",
        body: "@Match Time who's been the most consistent?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "stats", personRef: null, statedCount: null },
      }),
    ]);
    expect(displaysSquadState(out.utterances[0].text)).toBe(false);
  });

  it("the composed OPTIONS answer is not mistaken for squad state", () => {
    // TEN confirmed, not eight: `buildFormatSwitchFacts` only proposes a
    // switch the squad would actually FILL, so eight players produce the
    // "no smaller format would be filled" answer and never exercise the
    // arithmetic. Ten fills a 10-player 5-a-side and benches nobody —
    // which is the 2026-08-30 incident's own numbers, read the right way
    // round.
    const state = world({
      confirmed: TEN,
      smallerFormats: [{ sportName: "Football 5-a-side", totalPlayers: 10 }],
    });
    const { out } = composeFor(state, [
      msg({
        from: "kemal",
        body: "@Match Time we're only 8, what are our options?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "options", personRef: null, statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    // The arithmetic still has to be THERE — the point of the answer is
    // that eight players fill a ten-player format and nobody is benched.
    expect(text).toMatch(/5-a-side/);
    expect(text).toContain("nobody goes on the bench");
    expect(displaysSquadState(text)).toBe(false);
  });

  // ── THE RESULT OF THE LAST MATCH ───────────────────────────────────
  //
  // `SquadState.completedMatch` already carried `redScore`,
  // `yellowScore`, `status` and `isHistorical` for the score-REPORTING
  // route. Reading them back is a different question with three answers,
  // and the two that are not "Red 5 - 3 Yellow" are the ones worth
  // pinning: a group that has never played, and a match nobody reported
  // a score for. Both were live on Sutton FC the day this was written.
  const scoreAsk = () =>
    msg({
      from: "shaz",
      body: "@Match Time what was the score",
      route: "question",
      tagged: true,
      facts: { kind: "question", topic: "score", personRef: null, statedCount: null },
    });

  it("answers a result question with the recorded score and who won", () => {
    const state = world({
      confirmed: TEN.slice(0, 6),
      completedMatch: { id: "m-old", kickoffLabel: "Tue 21:30", redScore: 5, yellowScore: 3 },
    });
    const { out } = composeFor(state, [scoreAsk()]);
    const text = out.utterances[0].text;
    expect(text).toContain("Red 5 - 3 Yellow");
    expect(text).toMatch(/Red won/i);
    // It names the match it is talking about, so a reader can tell when
    // MatchTime has answered about a different night from the one they
    // meant. Without it, "did we win on tuesday?" gets a confident
    // number about last Thursday and nothing says so.
    expect(text).toContain("Tue 21:30");
    expect(displaysSquadState(text)).toBe(false);
  });

  it("calls a draw a draw rather than naming a winner", () => {
    const state = world({
      confirmed: TEN.slice(0, 6),
      completedMatch: { id: "m-old", kickoffLabel: "Tue 21:30", redScore: 4, yellowScore: 4 },
    });
    const { out } = composeFor(state, [scoreAsk()]);
    expect(out.utterances[0].text).toMatch(/draw/i);
    expect(out.utterances[0].text).not.toMatch(/won/i);
  });

  it("says nobody reported a score rather than inventing one", () => {
    // The live state on 2026-09-09: the last match had ENDED and sat at
    // TEAMS_PUBLISHED with both scores null, because a match only
    // becomes COMPLETED when somebody records a result. Rendering a
    // null as a number here is the whole failure mode.
    const state = world({
      confirmed: TEN.slice(0, 6),
      completedMatch: { id: "m-old", status: "TEAMS_PUBLISHED", kickoffLabel: "Tue 21:30" },
    });
    const { out } = composeFor(state, [scoreAsk()]);
    const text = out.utterances[0].text;
    expect(text).toMatch(/no score|nobody.*reported|not been reported/i);
    expect(text).not.toMatch(/\bnull\b|\bundefined\b|\bNaN\b/);
    expect(text).toContain("Tue 21:30");
  });

  it("says there is no played match at all when there is none", () => {
    const state = world({ confirmed: TEN.slice(0, 6) });
    const { out } = composeFor(state, [scoreAsk()]);
    const text = out.utterances[0].text;
    expect(text).toMatch(/haven't|no match|not played/i);
    expect(text).not.toMatch(/\bnull\b|\bundefined\b|\bNaN\b|\d+\s-\s\d+/);
  });

  // ── WHO HAS NOT PAID ───────────────────────────────────────────────
  //
  // The composer NAMES NOBODY, on every branch, because there is no name
  // in `PaymentSnapshot` to print. `buildUnpaidTail` set that precedent
  // in the same group ("no naming, no shaming", Sait, 2026-04-25).
  const paymentAsk = () =>
    msg({
      from: "elvin",
      body: "@Match Time who hasn't paid",
      route: "question",
      tagged: true,
      facts: { kind: "question", topic: "payments", personRef: null, statedCount: null },
    });

  const NAMES = /Kemal|Elvin|Sait|Mustafa|Abid|Idris/;

  it("answers with a count and no names", () => {
    const state = {
      ...world({ confirmed: TEN }),
      payments: {
        kind: "counted" as const,
        chargeable: 9,
        unpaid: 5,
        kickoffLabel: "Tue 21:15",
      },
    };
    const { out } = composeFor(state, [paymentAsk()]);
    const text = out.utterances[0].text;
    expect(text).toContain("5 of 9");
    expect(text).toContain("Tue 21:15");
    expect(text).not.toMatch(NAMES);
    expect(displaysSquadState(text)).toBe(false);
  });

  it("says everyone is settled rather than printing a zero", () => {
    const state = {
      ...world({ confirmed: TEN }),
      payments: {
        kind: "counted" as const,
        chargeable: 9,
        unpaid: 0,
        kickoffLabel: "Tue 21:15",
      },
    };
    const { out } = composeFor(state, [paymentAsk()]);
    expect(out.utterances[0].text).toMatch(/all settled|everyone/i);
    expect(out.utterances[0].text).not.toMatch(NAMES);
  });

  it("says MatchTime does not know rather than implying everyone has paid", () => {
    // The whole reason `not_tracked` exists. An empty list reads as "all
    // clear" and that is a claim, not an absence.
    const state = { ...world({ confirmed: TEN }), payments: { kind: "not_tracked" as const } };
    const { out } = composeFor(state, [paymentAsk()]);
    const text = out.utterances[0].text;
    expect(text).toMatch(/don't track|not track/i);
    expect(text).not.toMatch(/all settled|everyone.*paid|nobody owes/i);
  });

  it("refuses to put a number on a match with no payment signal", () => {
    const state = {
      ...world({ confirmed: TEN }),
      payments: { kind: "no_signal" as const, kickoffLabel: "Tue 21:30" },
    };
    const { out } = composeFor(state, [paymentAsk()]);
    const text = out.utterances[0].text;
    expect(text).toContain("Tue 21:30");
    expect(text).not.toMatch(/\b\d+ of \d+\b/);
    expect(text).not.toMatch(NAMES);
  });

  it("says there is nothing settled to check when there is no completed match", () => {
    const state = { ...world({ confirmed: TEN }), payments: { kind: "no_settled_match" as const } };
    const { out } = composeFor(state, [paymentAsk()]);
    expect(out.utterances[0].text).toMatch(/settled|played/i);
  });

  it("says NOTHING, loudly, when the payment load never happened", () => {
    // `state.payments` is null on every batch that did not ask for it —
    // which is nearly all of them. Reaching this branch means the engine
    // emitted the intent without the load, and the right answer is an
    // operator note and no utterance: `answer-batch.ts` then disowns the
    // message, so it hands back instead of passing an empty string off
    // as an answer.
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [paymentAsk()]);
    expect(out.utterances).toHaveLength(0);
    expect(out.operatorNotes.join(" ")).toMatch(/payment/i);
  });

  it("the OPTIONS answer with no smaller format configured is not mistaken for squad state", () => {
    const state = world({ confirmed: TEN.slice(0, 8), smallerFormats: [] });
    const { out } = composeFor(state, [
      msg({
        from: "kemal",
        body: "@Match Time we're short, what are our options?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "options", personRef: null, statedCount: null },
      }),
    ]);
    expect(displaysSquadState(out.utterances[0].text)).toBe(false);
  });
});

describe("the guest name ask", () => {
  it("asks for one name in the singular", () => {
    const state = world({ confirmed: TEN.slice(0, 7) });
    const { out } = composeFor(state, [
      msg({
        from: "amir",
        body: "@Kemal Ediz my brother can play if needed",
        route: "offer",
        facts: attendanceFacts([
          claim({
            subject: "other",
            personRef: "my brother",
            personNamed: false,
            polarity: "in",
            contingent: true,
            conditionOn: "squad",
          }),
        ]),
      }),
    ]);
    expect(out.utterances[0].text).toMatch(/what(?:'s| is| are) their names?\?/i);
    expect(out.reacts).toHaveLength(0);
  });

  it("asks for names in the plural", () => {
    const state = world({ confirmed: [...TEN, "usama"] });
    const { out } = composeFor(state, [
      msg({
        from: "amir",
        body: "two of my guys can play",
        route: "other_att",
        facts: attendanceFacts([
          claim({ subject: "other", personRef: "two of my guys", personNamed: false, polarity: "in" }),
        ]),
      }),
    ]);
    expect(out.utterances[0].text).toMatch(/what are their names\?/i);
  });
});

describe("the composer cannot say a thing the writes do not support", () => {
  it("says nothing at all when nothing happened", () => {
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({ from: "ayoub", body: "😂😂😂", route: "none", facts: { kind: "none" } }),
      msg({ from: "sait", body: "anyone watching the derby", route: "none", facts: { kind: "none" } }),
    ]);
    expect(out.utterances).toHaveLength(0);
    expect(out.reacts).toHaveLength(0);
  });

  it("never prints a raw phone number, whatever is in the state", () => {
    const state = world({ confirmed: TEN });
    state.roster[0].name = "+44 7700 900123";
    const { out } = composeFor(state, [
      msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    const text = out.utterances.map((u) => u.text).join("\n");
    expect(text).not.toMatch(/(?:\+\d[\d\s().-]{8,}\d)|(?:\b0\d{9,10}\b)|(?:\b\d{11,}\b)/);
  });

  it("routes degradations to the OPERATOR channel, never to the group", () => {
    const state = world({ noMatch: true });
    const { out } = composeFor(state, [
      msg({ from: "najib", body: "In", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    expect(out.utterances).toHaveLength(0);
    expect(out.operatorNotes.length).toBeGreaterThan(0);
    expect(out.operatorNotes.join(" ")).toMatch(/no active registration match/i);
  });
});

describe("reactions are derived from the write outcome, not authored", () => {
  it("✅ for a confirmed slot, 🪑 for the bench, 👋 for a drop", () => {
    const state = world({ confirmed: TEN });
    const a = composeFor(state, [
      msg({ from: "usama", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    expect(a.out.reacts[0].emoji).toBe("✅");

    const full = world({ confirmed: [...TEN, "usama", "karahan", "zair", "wasim"] });
    const b = composeFor(full, [
      msg({ from: "najib", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    expect(b.out.reacts[0].emoji).toBe("🪑");

    const c = composeFor(full, [
      msg({
        from: "wasim",
        body: "out",
        route: "self_att",
        facts: attendanceFacts([claim({ polarity: "out" })]),
      }),
    ]);
    expect(c.out.reacts[0].emoji).toBe("👋");
  });
});

// ── §3.2 S16 / S19 · the three answers the 2026-09-06 sweep asked for ──
//
// Each of these was a SILENCE or the wrong answer before this block.
// Twelve tagged questions were replayed against the live Sutton squad on
// 2026-09-06: four produced nothing at all, three answered a roster
// request with a bare count, and one posted a team sheet with nobody on
// it.

describe("a roster question is answered with the roster (2026-09-06 sweep)", () => {
  it("renders the squad post itself, not `We're 11/14`", () => {
    const state = world({ confirmed: [...TEN, "usama"], bench: ["karahan"] });
    const { out } = composeFor(state, [
      msg({
        from: "adam",
        body: "@Match Time who's playing?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "squad", personRef: null, statedCount: null },
      }),
    ]);
    const text = out.utterances[0].text;
    // The point of the change: NAMES, and every one of them.
    for (const who of ["Kemal Ediz", "Usama Tariq", "Karahan Yildiz"]) {
      expect(text).toContain(who);
    }
    // Not an approximation of the roster post — the roster post.
    expect(text).toBe(
      composeSquadStatusPost({
        confirmed: [...TEN, "usama"].map(fullName),
        bench: ["Karahan Yildiz"],
        maxPlayers: 14,
      }),
    );
  });

  it("says it ONCE when the same batch also changed the squad (§3.2 S36)", () => {
    // The roster question is answered BY the batch's own squad post.
    // Two rosters one line apart is the 2026-06-12 Sutton Lads shape.
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({
        from: "usama",
        body: "in",
        route: "self_att",
        facts: attendanceFacts([claim({ polarity: "in" })]),
      }),
      msg({
        from: "adam",
        body: "@Match Time who's playing?",
        route: "question",
        tagged: true,
        facts: { kind: "question", topic: "squad", personRef: null, statedCount: null },
      }),
    ]);
    expect(out.utterances.filter((u) => /Playing:/.test(u.text))).toHaveLength(1);
  });
});

describe("a fixture question is answered from the match (2026-09-06 sweep)", () => {
  const FIXTURE = {
    kind: "question" as const,
    topic: "fixture" as const,
    personRef: null,
    statedCount: null,
  };

  it("states the kickoff and the venue, and invents neither", () => {
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({
        from: "adam",
        body: "@Match Time what time is kickoff",
        route: "question",
        tagged: true,
        facts: FIXTURE,
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toContain("Tue 21:30");
    expect(text).toContain("Goals North Cheam");
  });

  it("must NOT carry a count, or the shipped composer replaces it with the roster", () => {
    // `displaysSquadState` rule (c): an `N/M` beside squad vocabulary is
    // squad state, and `composeSquadStateReply` then drops the whole
    // answer and posts the roster instead. Someone who asked "what time
    // is kickoff" would get a squad list and no time.
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({
        from: "adam",
        body: "@Match Time where are we playing",
        route: "question",
        tagged: true,
        facts: FIXTURE,
      }),
    ]);
    expect(displaysSquadState(out.utterances[0].text)).toBe(false);
  });

  it("drops the venue rather than printing 'at' with nothing after it", () => {
    const state = { ...world({ confirmed: TEN }), venue: "" };
    const { out } = composeFor(state, [
      msg({
        from: "adam",
        body: "@Match Time is the game still on",
        route: "question",
        tagged: true,
        facts: FIXTURE,
      }),
    ]);
    expect(out.utterances[0].text).toContain("Tue 21:30");
    expect(out.utterances[0].text).not.toMatch(/\bat\s*$/);
    expect(out.utterances[0].text).not.toMatch(/\bat\s*\./);
  });
});

describe("showing teams that do not exist (2026-09-06 sweep)", () => {
  it("says so, instead of posting two empty team lists", () => {
    // The measured defect: `formatTeamsPost` over two empty arrays
    // rendered "⚽ *Teams for tonight* … *Red*:\n\n\n*Yellow*:\n\n\n" —
    // a team sheet with nobody on it.
    const state = world({ confirmed: TEN });
    const { out } = composeFor(state, [
      msg({
        from: "elvin",
        body: "@Match Time show me the teams",
        route: "balancer",
        tagged: true,
        facts: { kind: "teams", action: "show", includeRefs: [], teamNames: null, swaps: [], pairings: [] },
      }),
    ]);
    const text = out.utterances[0].text;
    expect(text).toMatch(/no teams generated yet/i);
    expect(text).not.toContain("Teams for tonight");
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2026-09-08 · SAYING WHAT WAS NOT DONE (the David incident).
//
// An untagged admin's "David is OUT … the other can go to bench" applies
// the drop and refuses the demote. §9's signature failure is "message
// understood, action silently not taken", and a partially applied
// instruction the owner does not know was partial is exactly that, so
// MatchTime names the half it left alone.
//
// The sentence only ever rides a turn MatchTime was already taking (the
// engine emits the intent beside a write), so it is not a new class of
// unprompted chatter on an untagged message.
// ══════════════════════════════════════════════════════════════════════
describe("a partially applied instruction says which half did not happen", () => {
  const SQUAD = [...TEN, "usama", "karahan", "zair", "mojib"];

  const incident = () =>
    composeFor(world({ players: [...SUTTON, "david"], confirmed: [...SQUAD.slice(0, 13), "david"] }), [
      msg({
        from: "kemal",
        body:
          "David is OUT voluntarily to switch to 5aside.\n\n" +
          "Either @Mojib Jalali or @Najib can be in the main squad and the other can go to bench",
        route: "other_att",
        facts: attendanceFacts([
          claim({ subject: "other", personRef: "David", personNamed: true, polarity: "out" }),
          claim({ subject: "other", personRef: "Mojib", personNamed: true, polarity: "bench" }),
        ]),
      }),
    ]);

  it("names the refused player, the remedy, and nothing else", () => {
    const { out } = incident();
    const text = out.utterances.map((u) => u.text).join("\n");
    expect(text).toContain("I've not moved Mojib Sadat to the bench");
    expect(text).toContain("@Match Time");
  });

  it("does NOT repeat the half it DID do — the squad post is that", () => {
    // Two rosters one line apart is the 2026-06-12 Sutton Lads shape
    // (S36). The refusal sentence talks about the refused half only.
    const { out } = incident();
    const refusal = out.utterances.find((u) => u.text.includes("left alone"))!;
    expect(refusal.text).not.toContain("David");
    // …and the squad post, which carries what DID happen, is still sent:
    // Kemal moved DAVID's row, not his own, so there is no react on
    // David's side of it and the roster is what tells him (S36b).
    expect(out.utterances.some((u) => u.text.includes("/14"))).toBe(true);
  });

  it("is attached to the message it answers, not to the batch", () => {
    const { out } = incident();
    const refusal = out.utterances.find((u) => u.text.includes("left alone"))!;
    expect(refusal.messageId).not.toBeNull();
  });

  it("says nothing at all when the whole message was refused", () => {
    // A bench demote on its own, untagged: nothing is applied, so
    // MatchTime takes no turn and the sentence has none to ride.
    const { out } = composeFor(world({ confirmed: SQUAD }), [
      msg({
        from: "kemal",
        body: "put Mojib on the bench",
        route: "other_att",
        facts: attendanceFacts([
          claim({ subject: "other", personRef: "Mojib", personNamed: true, polarity: "bench" }),
        ]),
      }),
    ]);
    expect(out.utterances).toHaveLength(0);
  });

  it("reads correctly when BOTH a drop and a demote were refused", () => {
    // An ordinary member: his own OUT lands, and the two clauses about
    // other people do not.
    const { out } = composeFor(
      world({ players: [...SUTTON, "david"], confirmed: [...SQUAD.slice(0, 13), "david"] }),
      [
        msg({
          from: "zair",
          body: "I'm out, David is out too and Mojib can go on the bench",
          route: "other_att",
          facts: attendanceFacts([
            claim({ polarity: "out" }),
            claim({ subject: "other", personRef: "David", personNamed: true, polarity: "out" }),
            claim({ subject: "other", personRef: "Mojib", personNamed: true, polarity: "bench" }),
          ]),
        }),
      ],
    );
    const refusal = out.utterances.find((u) => u.text.includes("left alone"))!;
    expect(refusal.text).toContain("I've not taken David out or moved Mojib Sadat to the bench");
  });
});

// ── the open-slot line (2026-09-15) ────────────────────────────────────

describe("a drop that opens a spot says so, in one line", () => {
  const FULL = [
    "kemal",
    "elvin",
    "sait",
    "mustafa",
    "abid",
    "idris",
    "faris",
    "shaz",
    "adam",
    "efat",
    "usama",
    "karahan",
    "zair",
    "wasim",
  ];

  /** The DB truth the analyze route hands `composeSquadStateReply`
   *  AFTER the batch's writes land — which is what decides whether this
   *  sentence survives to the group or is replaced by the roster. */
  const truthAfter = (outKeys: string[]) => ({
    confirmed: FULL.filter((k) => !outKeys.includes(k)).map(fullName),
    bench: [],
    maxPlayers: 14,
  });

  const selfOut = (from: string, body: string) =>
    msg({ from, body, route: "self_att", facts: attendanceFacts([claim({ polarity: "out" })]) });

  it("names the player, the count and the way in — the 2026-09-15 incident", () => {
    const { out } = composeFor(world({ confirmed: FULL }), [
      selfOut("abid", "foot injury, I am out today"),
    ]);
    expect(out.utterances).toHaveLength(1);
    expect(out.utterances[0].text).toBe(
      "Abid is out, 13 of 14 for Tue 21:30. One slot open, say *IN* to take it.",
    );
  });

  it("rides the drop message, so the route does not throw the copy away", () => {
    // `attendance-engine-batch.ts` keeps a `messageId: null` utterance
    // only as a BOOLEAN — the text is dropped and `route.ts` expands
    // `[SQUAD]` into the roster instead. A batch-level utterance here
    // would never reach the group.
    const { out } = composeFor(world({ confirmed: FULL }), [
      selfOut("abid", "foot injury, I am out today"),
    ]);
    expect(out.utterances[0].messageId).not.toBeNull();
  });

  it("carries NO slash, so the route cannot mistake it for a roster", () => {
    // `displaysSquadState` rule (c) is an "N/M" beside squad vocabulary,
    // and anything it recognises is REPLACED by the fourteen-line roster
    // (`route.ts`, `composeSquadStateReply`). "13 of 14" says the same
    // thing to a human and survives. This is the trap that kept the
    // STATS and OPTIONS answers refused for months.
    const { out } = composeFor(world({ confirmed: FULL }), [
      selfOut("abid", "foot injury, I am out today"),
    ]);
    expect(displaysSquadState(out.utterances[0].text)).toBe(false);
  });

  it("is CHECKED against the database, and survives when it is right", () => {
    // Both halves are shapes `contradictsSquadState` reads: "Abid is
    // out" is a DROPPED move claim, and "One slot open" is measured
    // against the real shortfall. Saying "spot" instead of "slot" would
    // have escaped the check, which is the wrong kind of clever.
    const { out } = composeFor(world({ confirmed: FULL }), [
      selfOut("abid", "foot injury, I am out today"),
    ]);
    expect(contradictsSquadState(out.utterances[0].text, truthAfter(["abid"]))).toBe(false);
  });

  it("is REPLACED by the roster when the database has moved on", () => {
    // Somebody filled the slot between the engine's projection and the
    // post-write snapshot. The sentence now claims a slot that is not
    // open, `contradictsSquadState` says so, and the composed roster
    // wins. Truth beats copy.
    const { out } = composeFor(world({ confirmed: FULL }), [
      selfOut("abid", "foot injury, I am out today"),
    ]);
    const refilled = { confirmed: FULL.map(fullName), bench: [], maxPlayers: 14 };
    expect(contradictsSquadState(out.utterances[0].text, refilled)).toBe(true);
  });

  it("names every player who went out, in one sentence", () => {
    const { out } = composeFor(world({ confirmed: FULL }), [
      selfOut("abid", "out today lads"),
      selfOut("zair", "cant make it sorry"),
      selfOut("shaz", "im out"),
    ]);
    expect(out.utterances).toHaveLength(1);
    expect(out.utterances[0].text).toBe(
      "Abid, Zair and Shaz are out, 11 of 14 for Tue 21:30. 3 slots open, say *IN* to take one.",
    );
    expect(
      contradictsSquadState(out.utterances[0].text, truthAfter(["abid", "zair", "shaz"])),
    ).toBe(false);
  });

  it("says nobody is OUT when the slot was vacated by a move to the bench", () => {
    // A confirmed player asking for the bench off a full squad opens a
    // slot without anybody being out, and "Wasim is out" would be a
    // sentence the database does not support.
    const { out } = composeFor(world({ confirmed: FULL }), [
      msg({
        from: "wasim",
        body: "stick me on the bench tonight lads",
        route: "self_att",
        facts: attendanceFacts([claim({ polarity: "bench" })]),
      }),
    ]);
    expect(out.utterances).toHaveLength(1);
    expect(out.utterances[0].text).toBe(
      "That's 13 of 14 for Tue 21:30. One slot open, say *IN* to take it.",
    );
  });

  it("says NOTHING for an IN — PR #63's rule is untouched", () => {
    const { out } = composeFor(world({ confirmed: FULL.slice(0, 10) }), [
      msg({ from: "habib", body: "in", route: "self_att", facts: attendanceFacts([claim({})]) }),
    ]);
    expect(out.utterances).toHaveLength(0);
    expect(out.reacts.map((r) => r.emoji)).toEqual(["✅"]);
  });
});
