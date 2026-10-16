/**
 * A REPLY TO A PARTNER CLUB'S ASK (cross-club ask, slice S3, plan 3.6).
 *
 * Sutton FC's group reads FNF's ask ("⚽ FNF need 1 player ... Reply to
 * this message with IN"). A player who REPLIES to that post with IN is
 * volunteering for FNF's game, not saying IN to Sutton's own. Which one
 * is decided by the message he quotes, a fact WhatsApp gives us; the
 * router and the attendance extractor are unchanged and still read "IN".
 *
 *   quoted reply to an ask        partner_volunteer, no write on Sutton's match
 *   quoted OUT                    partner_volunteer out
 *   no quote, or another post     exactly today's behaviour, byte for byte
 *   about somebody else           nothing (no one is signed up for another club by someone else)
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import { NOW, attendanceFacts, claim, msg, world } from "./helpers";
import type { EngineMessage, SquadState } from "../types";

const ASK_POST = "true_120363000000009200@g.us_3EB0ASK1";
const withAsk = (state: SquadState, open = true): SquadState => ({
  ...state,
  partnerAsks: [{ askId: "ask-1", postWaMessageId: ASK_POST, askerName: "FNF", open }],
});
const inMsg = (over: Partial<EngineMessage> = {}, polarity: "in" | "out" = "in"): EngineMessage => ({
  ...msg({ id: "wa-1", from: "sait", body: polarity === "in" ? "IN" : "OUT", route: "self_att", facts: attendanceFacts([claim({ polarity })]) }),
  ...over,
});

describe("a quoted reply to a partner club's ask", () => {
  it("IN: a volunteer for the ask, and nothing on the club's own match", () => {
    const r = decide({ now: NOW, state: withAsk(world({ confirmed: ["kemal"] })), messages: [inMsg({ quoted: { id: "3EB0ASK1", fromMatchTime: true } })] });
    expect(r.writes).toEqual([
      expect.objectContaining({ kind: "partner_volunteer", askId: "ask-1", userId: "u-sait", polarity: "in", sourceMessageId: "wa-1" }),
    ]);
    expect(r.writes.some((w) => w.kind === "attendance")).toBe(false);
    expect(r.outcomes[0].disposition).toBe("acted");
  });

  it("OUT: the volunteer changes his mind", () => {
    const r = decide({ now: NOW, state: withAsk(world()), messages: [inMsg({ quoted: { id: "3EB0ASK1", fromMatchTime: true } }, "out")] });
    expect(r.writes).toEqual([expect.objectContaining({ kind: "partner_volunteer", polarity: "out" })]);
  });

  it("a claimless 'yes' on a self_att route is his own IN, as everywhere, so a volunteer", () => {
    const m = inMsg({
      body: "yes",
      quoted: { id: "3EB0ASK1", fromMatchTime: true },
      facts: attendanceFacts([], { affirmation: "yes" }),
    });
    const r = decide({ now: NOW, state: withAsk(world()), messages: [m] });
    expect(r.writes).toEqual([expect.objectContaining({ kind: "partner_volunteer", polarity: "in" })]);
  });

  it("a closed ask still captures the reply: the executor says the place has gone, nothing on the own match", () => {
    const r = decide({ now: NOW, state: withAsk(world(), false), messages: [inMsg({ quoted: { id: "3EB0ASK1", fromMatchTime: true } })] });
    expect(r.writes).toEqual([expect.objectContaining({ kind: "partner_volunteer", askId: "ask-1" })]);
  });

  it("a claim about somebody else is never a volunteer, and never an own-match write", () => {
    const m = inMsg({
      body: "Ali can play",
      route: "other_att",
      quoted: { id: "3EB0ASK1", fromMatchTime: true },
      facts: attendanceFacts([claim({ subject: "other", personRef: "Elvin", personNamed: true })]),
    });
    const r = decide({ now: NOW, state: withAsk(world()), messages: [m] });
    expect(r.writes).toEqual([]);
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/partner club's ask/);
  });
});

describe("everything else is exactly today's behaviour", () => {
  const baseline = (m: EngineMessage, state: SquadState) => decide({ now: NOW, state, messages: [m] });

  it("an unquoted IN in a group with an open ask is an IN for the club's own match, byte for byte", () => {
    const withAskResult = baseline(inMsg(), withAsk(world({ confirmed: ["kemal"] })));
    const without = baseline(inMsg(), world({ confirmed: ["kemal"] }));
    expect(withAskResult.writes).toEqual(without.writes);
    expect(withAskResult.speech).toEqual(without.speech);
    expect(withAskResult.writes[0]).toMatchObject({ kind: "attendance", userId: "u-sait", status: "CONFIRMED" });
  });

  it("a reply quoting some other post is an IN for the club's own match", () => {
    const r = baseline(inMsg({ quoted: { id: "3EB0OTHER", fromMatchTime: true } }), withAsk(world()));
    expect(r.writes[0]).toMatchObject({ kind: "attendance", userId: "u-sait" });
  });

  it("no ask loaded at all (every club today): a quoted IN is today's IN", () => {
    const r = baseline(inMsg({ quoted: { id: "3EB0ASK1", fromMatchTime: true } }), world());
    expect(r.writes[0]).toMatchObject({ kind: "attendance", userId: "u-sait" });
  });
});
