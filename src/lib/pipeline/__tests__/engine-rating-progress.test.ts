/**
 * RATING PROGRESS — DECIDED BY THE ENGINE, ANSWERED FROM THE DATABASE
 * (2026-09-11).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT THIS REPLACED
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `looksLikeRatingProgressRequest`, in `analyze/route.ts`'s fast-path
 * loop, was:
 *
 *   (a rating word)  /\b(rate|rated|rating|ratings|mom|motm|vote…)\b/
 *   AND
 *   (a progress word) /\b(so far|left|pending|yet|hasn't|not yet…)\b/
 *
 * anywhere in the body. Its own comment in `route.ts` called it "the
 * WIDEST trigger of the six peels": "I haven't rated yet and I'm out
 * Thursday" satisfies both halves without addressing anybody. That is
 * the conjunction shape that queued 69 mass DMs on 2026-09-10 and told
 * an owner his squad was full on 2026-09-01, sitting in front of a group
 * post instead of a DM blast.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * AND WHY IT IS A `question` TOPIC RATHER THAN AN `admin_ops` ACTION
 * ═══════════════════════════════════════════════════════════════════════
 *
 * MEASURED, not assumed. Four phrasings, 15 live router calls each
 * (2026-09-11): "@Match Time who hasn't rated yet?", "how many have
 * rated so far?", "who hasn't picked a MoM yet?" and "who is still to
 * rate from tuesday" all come back `question` 15/15 — 60 of 60. The
 * router's own rule 8 is why: "ASKING is question; INSTRUCTING is
 * admin_ops." A rating-progress ask is an ASK. Putting the fact on
 * `admin_ops` would have shipped a feature the router never routes to.
 *
 * `payments` is the precedent it follows exactly: a grounded group
 * answer, read from the database by one targeted load AFTER extraction,
 * with a pure decision module beside it. See `payment-answer.ts`.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import { NOW, msg, world } from "./helpers";
import type { RatingProgress } from "../../rating-progress-answer";

const PROGRESS: RatingProgress = {
  ok: true,
  matchName: "Tuesday 7-a-side",
  matchWhen: "Tue 2 Sep",
  confirmed: 10,
  ratedCount: 6,
  momCount: 5,
  notRated: ["Zair Malik"],
  ratedNoMom: [],
};

const ask = (
  from: string | null,
  opts: { tagged?: boolean; body?: string; loaded?: boolean } = {},
) =>
  decide({
    now: NOW,
    state: {
      ...world({
        confirmed: ["kemal", "elvin", "sait"],
        completedMatch: { id: "done-1" },
      }),
      ratingProgress: opts.loaded === false ? null : PROGRESS,
    },
    messages: [
      msg({
        from,
        tagged: opts.tagged ?? true,
        body: opts.body ?? "@Match Time who hasn't rated yet?",
        route: "question",
        facts: { kind: "question", topic: "rating_progress", personRef: null, statedCount: null },
      }),
    ],
  });

const progressSpeech = (r: ReturnType<typeof decide>) =>
  r.speech.filter((s) => s.kind === "answer_rating_progress");

describe("the rating-progress answer is decided by the engine", () => {
  it("a tagged ADMIN gets the answer", () => {
    expect(progressSpeech(ask("kemal"))).toHaveLength(1);
  });

  it("proposes no WRITE of any kind — this is a read", () => {
    expect(ask("kemal").writes).toHaveLength(0);
  });

  it("refuses a non-admin, silently", () => {
    const r = ask("zair");
    expect(progressSpeech(r)).toHaveLength(0);
    expect(r.speech).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/only an admin/i);
  });

  it("refuses an unresolved sender — nobody is an admin until they are somebody", () => {
    expect(progressSpeech(ask(null))).toHaveLength(0);
  });

  it("refuses an UNTAGGED ask, which the deleted fast path answered", () => {
    // A REAL BEHAVIOUR CHANGE, stated rather than discovered: the fast
    // path was not tag-gated at all, so "who hasn't rated yet?" with no
    // tag used to be answered. It is the question route's ordinary bar
    // now, the same one every other answer has had since 2026-09-08.
    const r = ask("kemal", { tagged: false, body: "who hasn't rated yet?" });
    expect(progressSpeech(r)).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/@Match Time tag/i);
  });

  // ── THE SENTENCES THE CONJUNCTION USED TO EAT ──────────────────────
  //
  // Both halves of the old predicate appear in each of these and neither
  // is a question to MatchTime. They are pinned at the ROUTE level here
  // — the model calls them `self_att` / `other_att`, not a
  // `rating_progress` question — and the point is that NOTHING in the
  // code reads the words any more, so no arrangement of them reaches
  // this branch at all.
  it("an attendance message that mentions rating is attendance, and is not answered", () => {
    const r = decide({
      now: NOW,
      state: world({ confirmed: ["kemal", "elvin", "sait"] }),
      messages: [
        msg({
          from: "kemal",
          tagged: false,
          body: "I haven't rated yet and I'm out Thursday",
          route: "self_att",
          facts: {
            kind: "attendance",
            claims: [
              {
                subject: "sender",
                personRef: "",
                personNamed: false,
                polarity: "out",
                contingent: false,
                conditionOn: "none",
                tense: "future",
                basis: "decision",
                reported: false,
                confidence: 0.95,
              },
            ],
            affirmation: null,
            sideRequests: [],
          },
        }),
      ],
    });
    // The OUT lands — the half the peel used to protect and the whole
    // reason the peel existed.
    expect(r.writes.filter((w) => w.kind === "attendance")).toHaveLength(1);
    expect(progressSpeech(r)).toHaveLength(0);
  });

  it("emits the answer without knowing what it says", () => {
    // The engine carries no counts and no names. The composer reads
    // `state.ratingProgress`, which `answer-batch.ts` loaded from the
    // database — the same split `answer_payments` has.
    const s = progressSpeech(ask("kemal"))[0];
    expect(Object.keys(s).sort()).toEqual(["kind", "messageId"]);
  });
});
