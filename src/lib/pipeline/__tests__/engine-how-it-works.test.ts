/**
 * "HOW DOES THIS WORK?" (2026-10-16, FNF: "Bench? We do bench now?" in
 * reply to MatchTime's "the bench is open"). The engine decides only THAT
 * the asker gets the help explainer and for which part of MatchTime; the
 * words are the help copy the "@Match Time help <topic>" command already
 * sends, written for this club's settings (`buildHelpReply`), and
 * `answer-batch.ts` attaches them.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import { NOW, msg, world } from "./helpers";

const ask = (opts: { tagged?: boolean; feature?: "availability" | null } = {}) =>
  decide({
    now: NOW,
    state: world({ confirmed: ["kemal", "elvin", "sait"] }),
    messages: [
      msg({
        id: "wa-ask",
        from: "sait",
        tagged: opts.tagged ?? true,
        body: "Bench? We do bench now?",
        route: "question",
        facts: { kind: "question", topic: "how_it_works", personRef: null, statedCount: null, feature: opts.feature === undefined ? "availability" : opts.feature },
      }),
    ],
  });

const outcome = (r: ReturnType<typeof decide>) => r.outcomes.find((o) => o.messageId === "wa-ask")!;

describe("a how-it-works question", () => {
  it("asks for the help explainer for the part it names, and writes nothing", () => {
    const r = ask();
    expect(outcome(r).helpRequested).toEqual({ topic: "availability" });
    expect(outcome(r).disposition).toBe("acted");
    expect(r.writes).toHaveLength(0);
  });

  it("no part named: the help menu", () => {
    expect(outcome(ask({ feature: null })).helpRequested).toEqual({ topic: null });
  });

  it("untagged is refused, as every question is", () => {
    expect(outcome(ask({ tagged: false })).helpRequested).toBeUndefined();
  });
});
