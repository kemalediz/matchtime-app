/**
 * WHEN THE ROUTER IS TOLD A RESULT MAY BE CORRECTED (review of #476, M5).
 * Shown on every tagged message for 48 hours, the line biased "@Match Time
 * Tom out" towards score. Now, facts only: the message is a WhatsApp reply
 * to MatchTime's post about that match, or MatchTime's last post in the
 * group is that result.
 */
import { describe, expect, it } from "vitest";
import { correctionLineIds } from "../load-awaiting-answer";

const m = (id: string, over: { tagged?: boolean; quotedMatchTimeAbout?: string | null } = {}) => ({
  id,
  body: "x",
  tagged: over.tagged ?? true,
  senderUserId: "u-1",
  quotedMatchTimeAbout: over.quotedMatchTimeAbout ?? null,
});

describe("correctionLineIds", () => {
  it("a tagged message, with the result NOT MatchTime's last post: no line", () => {
    expect([...correctionLineIds([m("a")], { matchId: "done-1", lastPostIsResult: false })]).toEqual([]);
  });

  it("a tagged message while the result IS MatchTime's last post: the line", () => {
    expect([...correctionLineIds([m("a")], { matchId: "done-1", lastPostIsResult: true })]).toEqual(["a"]);
  });

  it("a reply to MatchTime's post about the result's match: the line, tagged or not", () => {
    expect([...correctionLineIds([m("a", { tagged: false, quotedMatchTimeAbout: "done-1" })], { matchId: "done-1", lastPostIsResult: false })]).toEqual(["a"]);
  });

  it("a reply to MatchTime's post about another match: no line", () => {
    expect([...correctionLineIds([m("a", { quotedMatchTimeAbout: "next-1" })], { matchId: "done-1", lastPostIsResult: false })]).toEqual([]);
  });

  it("an untagged message that replies to nothing: no line, whatever was posted last", () => {
    expect([...correctionLineIds([m("a", { tagged: false })], { matchId: "done-1", lastPostIsResult: true })]).toEqual([]);
  });
});
