/**
 * The automatic ask includes the pool (slice L9): the pure rule. Only for a
 * club whose pool is open AND that switched the automatic pool ask on; with
 * partner clubs only while the club asks them automatically; then the
 * automatic ask's own rule (`autoAskDue`): match day from the club's time to
 * the cut-off, a place open, its own bench empty, once per match. The pool
 * joins the round the partners were asked in, else a round of its own.
 */
import { describe, expect, it } from "vitest";
import { parsePoolAutoAsk, poolAutoAskApplies, poolAutoAskDue, poolAutoAskShown, poolAutoRound } from "../auto-ask-rules";
import { poolSwitchEnv } from "../flags";

const ASK_AT = new Date("2026-10-30T12:00:00Z");
const POST_BY = new Date("2026-10-30T16:00:00Z");
const NOW = new Date("2026-10-30T12:05:00Z");

const club = { poolOpen: true, poolAutoAsk: true, hasPartners: false, partnersWhen: "off" };
const due = { ...club, now: NOW, askAt: ASK_AT, postBy: POST_BY, placesOpen: 2, waitingCount: 0, poolAskedBefore: false };

describe("poolAutoAskApplies: does the club's automatic ask include the pool at all", () => {
  it("pool open, switched on, no partner clubs: yes, whatever the partner setting", () => {
    for (const partnersWhen of ["off", "on-request", "auto"]) expect(poolAutoAskApplies({ ...club, partnersWhen })).toBe(true);
  });

  it("with partner clubs, only while the club asks them automatically", () => {
    expect(poolAutoAskApplies({ ...club, hasPartners: true, partnersWhen: "auto" })).toBe(true);
    expect(poolAutoAskApplies({ ...club, hasPartners: true, partnersWhen: "on-request" })).toBe(false);
    expect(poolAutoAskApplies({ ...club, hasPartners: true, partnersWhen: "off" })).toBe(false);
  });

  it("the switch off, or the pool closed for the club: never", () => {
    expect(poolAutoAskApplies({ ...club, poolAutoAsk: false })).toBe(false);
    expect(poolAutoAskApplies({ ...club, poolOpen: false })).toBe(false);
    expect(poolAutoAskApplies({ ...club, poolOpen: false, hasPartners: true, partnersWhen: "auto" })).toBe(false);
  });
});

describe("poolAutoAskDue: the automatic ask's own rule, for the pool", () => {
  it("from the club's time to the cut-off, a place open, its bench empty: due", () => {
    expect(poolAutoAskDue(due)).toBe(true);
    expect(poolAutoAskDue({ ...due, now: ASK_AT })).toBe(true);
  });

  it("before the club's time, or from the cut-off: not due", () => {
    expect(poolAutoAskDue({ ...due, now: new Date(ASK_AT.getTime() - 60_000) })).toBe(false);
    expect(poolAutoAskDue({ ...due, now: POST_BY })).toBe(false);
  });

  it("someone on the club's own bench: not due (its own players first)", () => {
    expect(poolAutoAskDue({ ...due, waitingCount: 1 })).toBe(false);
  });

  it("no place open: not due", () => {
    expect(poolAutoAskDue({ ...due, placesOpen: 0 })).toBe(false);
  });

  it("the pool already asked for this match, open or closed, by a tap or automatically: never again", () => {
    expect(poolAutoAskDue({ ...due, poolAskedBefore: true })).toBe(false);
  });

  it("everything else true, but the club rule says no: not due", () => {
    expect(poolAutoAskDue({ ...due, poolAutoAsk: false })).toBe(false);
    expect(poolAutoAskDue({ ...due, poolOpen: false })).toBe(false);
    expect(poolAutoAskDue({ ...due, hasPartners: true, partnersWhen: "on-request" })).toBe(false);
  });
});

describe("poolAutoRound: which round the pool joins, and for how many", () => {
  it("partners asked in this same pass: their round, every open place (what they were asked for)", () => {
    expect(poolAutoRound({ askedNowRoundId: "r-now", openRound: { roundId: "r-old", places: 1 }, placesOpen: 3 })).toEqual({ roundId: "r-now", places: 3 });
  });

  it("a round of partner asks still open on the match: that round, for its number (never more than is open)", () => {
    expect(poolAutoRound({ askedNowRoundId: null, openRound: { roundId: "r-old", places: 1 }, placesOpen: 3 })).toEqual({ roundId: "r-old", places: 1 });
    expect(poolAutoRound({ askedNowRoundId: null, openRound: { roundId: "r-old", places: 4 }, placesOpen: 2 })).toEqual({ roundId: "r-old", places: 2 });
  });

  it("no partner asked or open: a round of its own, every open place", () => {
    expect(poolAutoRound({ askedNowRoundId: null, openRound: null, placesOpen: 2 })).toEqual({ roundId: null, places: 2 });
  });
});

describe("the setting (slice L9): shown and saved only while the club may ask the pool", () => {
  it("shown with the club's pool flag on, as Style of play is", () => {
    expect(poolAutoAskShown({ featurePlayerPool: true }, poolSwitchEnv(true))).toBe(true);
    // The platform switch off (or never resolved) hides it, whatever the club says.
    expect(poolAutoAskShown({ featurePlayerPool: true }, poolSwitchEnv(false))).toBe(false);
    expect(poolAutoAskShown({ featurePlayerPool: true }, {})).toBe(false);
    expect(poolAutoAskShown({ featurePlayerPool: false }, poolSwitchEnv(true))).toBe(false);
    expect(poolAutoAskShown(null, poolSwitchEnv(true))).toBe(false);
  });

  it("only a true or a false is saved", () => {
    expect(parsePoolAutoAsk(true)).toEqual({ ok: true, value: true });
    expect(parsePoolAutoAsk(false)).toEqual({ ok: true, value: false });
    for (const v of ["true", 1, null, undefined, {}]) expect(parsePoolAutoAsk(v)).toEqual({ ok: false });
  });
});
