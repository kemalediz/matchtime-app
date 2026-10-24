/**
 * THE RULES BEHIND A REPLY IN WORDS TO A POOL OFFER (slice L6, 2026-10-24).
 * Pure: which offers a DM may be about (the state prior), and what is done
 * with the reader's answer. The model only reads the words; every decision
 * about places, proof and who may be answered is here.
 */
import { describe, expect, it } from "vitest";
import {
  POOL_REPLY_MIN_CONFIDENCE,
  offerReplyState,
  replyAction,
  replyScope,
  type ReplyOffer,
  type ReplyReading,
  type ReplyScope,
} from "../reply-rules";

const NOW = new Date("2026-10-27T12:00:00Z");
const H = 3600_000;
const later = (h: number) => new Date(NOW.getTime() + h * H);

describe("offerReplyState", () => {
  const base = { outcome: null, askStatus: "open", sentAt: later(-1), expiresAt: later(3), matchLive: true, kickoff: later(8), holdsPlace: false, now: NOW };
  it("an unanswered offer in its time is open", () => expect(offerReplyState(base)).toBe("open"));
  it("its own time ran out: ended", () => expect(offerReplyState({ ...base, expiresAt: later(-0.1) })).toBe("ended"));
  it("the round closed (filled by others): ended", () => expect(offerReplyState({ ...base, askStatus: "filled" })).toBe("ended"));
  it("never delivered: ended (a reply cannot be about it)", () => expect(offerReplyState({ ...base, sentAt: null })).toBe("ended"));
  it("the game is off, or kicked off: ended", () => {
    expect(offerReplyState({ ...base, matchLive: false })).toBe("ended");
    expect(offerReplyState({ ...base, kickoff: later(-0.5) })).toBe("ended");
  });
  it("he took the place and still holds it, before kickoff: taken", () =>
    expect(offerReplyState({ ...base, outcome: "accepted", askStatus: "filled", expiresAt: later(-2), holdsPlace: true })).toBe("taken"));
  it("he took it and gave it back, or the game kicked off: ended", () => {
    expect(offerReplyState({ ...base, outcome: "accepted", holdsPlace: false })).toBe("ended");
    expect(offerReplyState({ ...base, outcome: "accepted", holdsPlace: true, kickoff: later(-1) })).toBe("ended");
  });
  it("declined, filled, expired, ignored, cancelled: ended", () => {
    for (const outcome of ["declined", "filled", "expired", "ignored", "cancelled", "stopped"]) expect(offerReplyState({ ...base, outcome })).toBe("ended");
  });
});

const offer = (id: string, state: ReplyOffer["state"], hoursAgo = 1, quoted = false): ReplyOffer => ({ id, state, sentAt: later(-hoursAgo), quoted });

describe("replyScope: which offers a DM may be about", () => {
  const stranger = { inAClub: false, clubDmSinceOffer: false };
  const member = { inAClub: true, clubDmSinceOffer: false };

  it("no offer delivered: none", () => expect(replyScope({ offers: [], ...stranger }).kind).toBe("none"));

  it("a swipe-reply quoting an offer is about that offer, whatever its state, member or not", () => {
    const offers = [offer("new", "open", 1), offer("old", "ended", 5, true)];
    expect(replyScope({ offers, ...member })).toEqual({ kind: "one", offer: offers[1], quoted: true });
    expect(replyScope({ offers, ...stranger })).toEqual({ kind: "one", offer: offers[1], quoted: true });
  });

  it("someone in no club, one live offer: that one (a plain message, not only quotes)", () => {
    const offers = [offer("a", "open")];
    expect(replyScope({ offers, ...stranger })).toEqual({ kind: "one", offer: offers[0], quoted: false });
  });

  it("someone in no club, a place he took and an older ended offer: the place he took", () => {
    const offers = [offer("ended", "ended", 1), offer("taken", "taken", 30)];
    expect(replyScope({ offers, ...stranger })).toEqual({ kind: "one", offer: offers[1], quoted: false });
  });

  it("someone in no club, two live offers: several (he is asked which)", () => {
    const offers = [offer("a", "open", 1), offer("b", "open", 2)];
    expect(replyScope({ offers, ...stranger })).toEqual({ kind: "several", offers });
  });

  it("someone in no club, only ended offers: the newest (its one 'gone' line, or a stop)", () => {
    const offers = [offer("a", "ended", 1), offer("b", "ended", 3)];
    expect(replyScope({ offers, ...stranger })).toEqual({ kind: "one", offer: offers[0], quoted: false });
  });

  it("a club member's plain DM: only with exactly one live offer and no club DM to him since it", () => {
    const one = [offer("a", "open")];
    expect(replyScope({ offers: one, ...member })).toEqual({ kind: "one", offer: one[0], quoted: false });
    expect(replyScope({ offers: one, inAClub: true, clubDmSinceOffer: true }).kind).toBe("none");
    expect(replyScope({ offers: [offer("a", "open"), offer("b", "open")], ...member }).kind).toBe("none");
    expect(replyScope({ offers: [offer("a", "ended")], ...member }).kind).toBe("none");
  });
});

const sure = (intent: ReplyReading["intent"]): ReplyReading => ({ intent, confidence: 0.95 });
const unsure = (intent: ReplyReading["intent"]): ReplyReading => ({ intent, confidence: POOL_REPLY_MIN_CONFIDENCE - 0.01 });
const ok = { inAClub: false, proved: true, profileActive: true };
const one = (state: ReplyOffer["state"], quoted = false): ReplyScope => ({ kind: "one", offer: offer("o", state, 1, quoted), quoted });

describe("replyAction: what is done with the reading", () => {
  it("nothing in scope: carry on", () => expect(replyAction({ scope: { kind: "none" }, reading: sure("accept"), ...ok })).toEqual({ kind: "carry-on" }));

  it("an open offer: accept, decline, question each do their thing", () => {
    expect(replyAction({ scope: one("open"), reading: sure("accept"), ...ok })).toEqual({ kind: "accept", offerId: "o" });
    expect(replyAction({ scope: one("open"), reading: sure("decline"), ...ok })).toEqual({ kind: "decline", offerId: "o" });
    expect(replyAction({ scope: one("open"), reading: sure("question"), ...ok })).toEqual({ kind: "facts", offerId: "o" });
  });

  it("stop is stop, from any offer state, and even for a paused profile", () => {
    for (const s of ["open", "taken", "ended"] as const) expect(replyAction({ scope: one(s), reading: sure("stop"), ...ok })).toEqual({ kind: "stop" });
    expect(replyAction({ scope: one("open"), reading: sure("stop"), ...ok, profileActive: false })).toEqual({ kind: "stop" });
    expect(replyAction({ scope: { kind: "several", offers: [offer("a", "open"), offer("b", "open")] }, reading: sure("stop"), ...ok })).toEqual({ kind: "stop" });
  });

  it("a place he took: a decline gives it back, a question or a yes gets its details", () => {
    expect(replyAction({ scope: one("taken"), reading: sure("decline"), ...ok })).toEqual({ kind: "pull-out", offerId: "o" });
    expect(replyAction({ scope: one("taken"), reading: sure("question"), ...ok })).toEqual({ kind: "facts", offerId: "o" });
    expect(replyAction({ scope: one("taken"), reading: sure("accept"), ...ok })).toEqual({ kind: "facts", offerId: "o" });
  });

  it("an ended offer: today's one line (that place has gone), whatever he says but stop", () => {
    for (const i of ["accept", "decline", "question", "neither"] as const) {
      expect(replyAction({ scope: one("ended"), reading: sure(i), ...ok })).toEqual({ kind: "fallback", offerId: "o" });
    }
  });

  it("neither: today's behaviour (the one tap-the-link line for someone in no club or a quote)", () => {
    expect(replyAction({ scope: one("open"), reading: sure("neither"), ...ok })).toEqual({ kind: "fallback", offerId: "o" });
    expect(replyAction({ scope: one("open", true), reading: sure("neither"), ...ok, inAClub: true })).toEqual({ kind: "fallback", offerId: "o" });
  });

  it("below the floor: one re-ask with the link for a live offer, today's line for an ended one", () => {
    expect(replyAction({ scope: one("open"), reading: unsure("accept"), ...ok })).toEqual({ kind: "reask", offerId: "o" });
    expect(replyAction({ scope: one("taken"), reading: unsure("decline"), ...ok })).toEqual({ kind: "reask", offerId: "o" });
    expect(replyAction({ scope: one("ended"), reading: unsure("accept"), ...ok })).toEqual({ kind: "fallback", offerId: "o" });
  });

  it("the floor holds for stop too: an unsure stop never stops anything", () => {
    expect(replyAction({ scope: one("open"), reading: unsure("stop"), ...ok })).toEqual({ kind: "reask", offerId: "o" });
  });

  it("a club member's plain DM is never swallowed: anything unsure or neither carries on", () => {
    const m = { ...ok, inAClub: true };
    expect(replyAction({ scope: one("open"), reading: sure("neither"), ...m })).toEqual({ kind: "carry-on" });
    expect(replyAction({ scope: one("open"), reading: unsure("accept"), ...m })).toEqual({ kind: "carry-on" });
    expect(replyAction({ scope: one("open"), reading: sure("accept"), ...m })).toEqual({ kind: "accept", offerId: "o" });
  });

  it("two live offers: a sure accept, decline or question asks which; unsure asks which too", () => {
    const several: ReplyScope = { kind: "several", offers: [offer("a", "open", 1), offer("b", "taken", 2)] };
    for (const i of ["accept", "decline", "question"] as const) {
      expect(replyAction({ scope: several, reading: sure(i), ...ok })).toEqual({ kind: "which", offerIds: ["a", "b"] });
    }
    expect(replyAction({ scope: several, reading: unsure("accept"), ...ok })).toEqual({ kind: "which", offerIds: ["a", "b"] });
    expect(replyAction({ scope: several, reading: sure("neither"), ...ok })).toEqual({ kind: "fallback", offerId: "a" });
  });

  it("not proved to be him (the number on the envelope is not his): nothing is changed, the tap link proves him", () => {
    for (const i of ["accept", "decline", "stop"] as const) {
      expect(replyAction({ scope: one("open"), reading: sure(i), ...ok, proved: false })).toEqual({ kind: "fallback", offerId: "o" });
    }
    expect(replyAction({ scope: one("taken"), reading: sure("decline"), ...ok, proved: false })).toEqual({ kind: "fallback", offerId: "o" });
    // A question changes nothing, so it may still be answered.
    expect(replyAction({ scope: one("open"), reading: sure("question"), ...ok, proved: false })).toEqual({ kind: "facts", offerId: "o" });
  });

  it("game offers paused or stopped: a yes books nothing, he is told once how to switch them on", () => {
    const off = { ...ok, profileActive: false };
    expect(replyAction({ scope: one("open"), reading: sure("accept"), ...off })).toEqual({ kind: "profile-off", offerId: "o" });
    expect(replyAction({ scope: one("open"), reading: sure("question"), ...off })).toEqual({ kind: "profile-off", offerId: "o" });
    // A place he already holds is still his to give back.
    expect(replyAction({ scope: one("taken"), reading: sure("decline"), ...off })).toEqual({ kind: "pull-out", offerId: "o" });
  });
});
