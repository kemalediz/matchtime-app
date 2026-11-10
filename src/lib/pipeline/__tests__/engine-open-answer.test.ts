/**
 * ANYTHING ELSE (Kemal, 2026-11-10): the engine routes a tagged question of
 * topic `other` to the grounded open answer (`answer_open`), which the
 * composer reads from `state.openAnswers`. It used to `degrade()` with "no
 * deterministic answer". It never writes, and the composer says nothing
 * when the answer was not usable (the batch then keeps today's line).
 */
import { describe, it, expect } from "vitest";
import { decide } from "./support/stub-picks";
import { compose } from "../compose";
import { NOW, msg, world } from "./helpers";
import type { SquadState } from "../types";

const ask = (opts: { tagged?: boolean; openAnswers?: SquadState["openAnswers"] } = {}) =>
  decide({
    now: NOW,
    state: { ...world({ confirmed: ["kemal", "elvin", "sait"] }), openAnswers: opts.openAnswers ?? null },
    messages: [
      msg({
        id: "wa-ask",
        from: "sait",
        tagged: opts.tagged ?? true,
        body: "@Match Time is it going to be cold tonight?",
        route: "question",
        facts: { kind: "question", topic: "other", personRef: null, statedCount: null },
      }),
    ],
  });

const outcome = (r: ReturnType<typeof decide>) => r.outcomes.find((o) => o.messageId === "wa-ask")!;

describe("a question of topic other", () => {
  it("is the open answer: a speech intent, no write, no degradation", () => {
    const r = ask({ openAnswers: { "wa-ask": { text: "I can't see the weather. Kickoff is Tue 21:30." } } });
    expect(r.speech).toEqual([{ kind: "answer_open", messageId: "wa-ask" }]);
    expect(r.writes).toHaveLength(0);
    expect(r.degradations).toEqual([]);
    expect(outcome(r).disposition).toBe("acted");
    expect(compose(r).utterances).toEqual([{ messageId: "wa-ask", text: "I can't see the weather. Kickoff is Tue 21:30." }]);
  });

  it("a rejected answer composes nothing and leaves an operator note", () => {
    const r = ask({ openAnswers: { "wa-ask": { rejected: "the open-answer call failed (529)" } } });
    const c = compose(r);
    expect(c.utterances).toEqual([]);
    expect(c.operatorNotes.join(" ")).toMatch(/answer_open for wa-ask rejected/);
  });

  it("no answer loaded composes nothing", () => {
    expect(compose(ask()).utterances).toEqual([]);
  });

  it("untagged is refused, as every question is", () => {
    const r = ask({ tagged: false, openAnswers: { "wa-ask": { text: "hi" } } });
    expect(r.speech).toEqual([]);
  });
});
