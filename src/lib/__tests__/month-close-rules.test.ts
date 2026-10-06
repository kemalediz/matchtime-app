/**
 * Monthly squad, slice 6: the pure rules of credits, cancelled weeks,
 * leaving part-way, a share changed after somebody paid, the month close
 * and away weeks. No database, no model.
 */
import { describe, expect, it } from "vitest";
import {
  cleanCreditNote,
  creditState,
  decideCancelledWeekCredits,
  decideLeaverCredits,
  isLeaver,
  leaverOwedPence,
  monthCloseDue,
  paidBalancePence,
  planAwayWeeks,
  planShareChange,
  summariseMonth,
  validManualGames,
  REFUNDED_NOTE,
  type CancelMember,
  type MatchCredit,
  type ShareMember,
} from "../month-close-rules";
import { londonDateTimeToUtc } from "../london-time";

const at = (day: string, time = "12:00") => londonDateTimeToUtc(day, time);
const GAME = at("2026-10-19", "20:00");
const MONTH = "m-oct";

const member = (userId: string, o: Partial<CancelMember> = {}): CancelMember => ({
  userId,
  regular: true,
  inClub: true,
  paid: "confirmed",
  joinedAt: at("2026-09-24"),
  ...o,
});
const credit = (id: string, userId: string, reason: string, o: Partial<MatchCredit> = {}): MatchCredit => ({
  id,
  userId,
  reason,
  voidedAt: null,
  voidedById: null,
  appliedMonthId: null,
  createdById: null,
  ...o,
});

describe("an organiser's reason for a credit", () => {
  it("is trimmed to one line", () => {
    expect(cleanCreditNote("  missed 5 Oct,\n before we started here ")).toBe("missed 5 Oct, before we started here");
  });
  it("refuses nothing, too little and too much", () => {
    expect(cleanCreditNote("")).toBeNull();
    expect(cleanCreditNote("ok")).toBeNull();
    expect(cleanCreditNote("x".repeat(201))).toBeNull();
    expect(cleanCreditNote(null)).toBeNull();
    expect(cleanCreditNote(42)).toBeNull();
  });
  it("takes one to ten games at a time", () => {
    expect(validManualGames(1)).toBe(true);
    expect(validManualGames(10)).toBe(true);
    expect(validManualGames(0)).toBe(false);
    expect(validManualGames(11)).toBe(false);
    expect(validManualGames(1.5)).toBe(false);
    expect(validManualGames("2")).toBe(false);
  });
});

describe("where a ledger row stands", () => {
  const base = { voidedAt: null, voidedById: null, voidNote: null, appliedMonthId: null };
  it("available, used, removed, refunded, taken back", () => {
    expect(creditState(base)).toBe("available");
    expect(creditState({ ...base, appliedMonthId: "m" })).toBe("used");
    expect(creditState({ ...base, voidedAt: new Date(), voidedById: "rob", voidNote: "wrong player" })).toBe("removed");
    expect(creditState({ ...base, voidedAt: new Date(), voidedById: "rob", voidNote: REFUNDED_NOTE })).toBe("refunded");
    expect(creditState({ ...base, voidedAt: new Date() })).toBe("taken-back");
  });
});

describe("a cancelled week", () => {
  const decide = (o: Partial<Parameters<typeof decideCancelledWeekCredits>[0]>) =>
    decideCancelledWeekCredits({ cancelled: true, matchDate: GAME, monthId: MONTH, members: [], existing: [], ...o });

  it("credits every regular who is charged for it, once", () => {
    const members = [member("alex"), member("bilal", { paid: "claimed" })];
    expect(decide({ members }).create).toEqual([
      { userId: "alex", applyNow: false },
      { userId: "bilal", applyNow: false },
    ]);
    // A second run (a retry, another poll, cancelling again): nothing more.
    const existing = [credit("c1", "alex", "cancelled-week"), credit("c2", "bilal", "cancelled-week")];
    expect(decide({ members, existing })).toEqual({ create: [], voidMissedIds: [], voidIds: [], release: [], releaseElsewhere: [] });
  });

  it("a regular who has not paid yet has it taken off this month at once", () => {
    expect(decide({ members: [member("carl", { paid: "none" })] }).create).toEqual([{ userId: "carl", applyNow: true }]);
  });

  it("credits nobody who is not a regular on the month, or has gone from the group", () => {
    const members = [member("omar", { regular: false }), member("jake", { inClub: false })];
    expect(decide({ members }).create).toEqual([]);
  });

  it("credits nobody for a game played before they became a regular", () => {
    expect(decide({ members: [member("dev", { joinedAt: at("2026-10-20") })] }).create).toEqual([]);
  });

  it("credits nobody who became a regular after the game was called off", () => {
    // Their games were counted without it: a credit would take it off twice.
    const members = [member("tom", { paid: "none", joinedAt: at("2026-10-14") }), member("alex")];
    expect(decide({ members, cancelledAt: at("2026-10-13") }).create).toEqual([{ userId: "alex", applyNow: false }]);
    expect(decide({ members, cancelledAt: at("2026-10-15") }).create.map((c) => c.userId)).toEqual(["tom", "alex"]);
  });

  it("replaces a missed credit for the same game: one game is one credit", () => {
    const res = decide({ members: [member("alex")], existing: [credit("m1", "alex", "missed")] });
    expect(res.create).toEqual([{ userId: "alex", applyNow: false }]);
    expect(res.voidMissedIds).toEqual(["m1"]);
  });

  it("leaves a missed credit that was already used, and writes no second credit", () => {
    const res = decide({ members: [member("alex")], existing: [credit("m1", "alex", "missed", { appliedMonthId: "m-nov" })] });
    expect(res).toEqual({ create: [], voidMissedIds: [], voidIds: [], release: [], releaseElsewhere: [] });
  });

  it("never writes again a credit an organiser removed", () => {
    const existing = [credit("c1", "alex", "cancelled-week", { voidedAt: new Date(), voidedById: "rob" })];
    expect(decide({ members: [member("alex")], existing }).create).toEqual([]);
  });

  it("restored: the credit is taken back, and one that came off this month is released", () => {
    const existing = [credit("c1", "alex", "cancelled-week"), credit("c2", "carl", "cancelled-week", { appliedMonthId: MONTH })];
    const res = decide({ cancelled: false, members: [member("alex"), member("carl", { paid: "none" })], existing });
    expect(res.voidIds).toEqual(["c1", "c2"]);
    expect(res.release).toEqual([{ creditId: "c2", userId: "carl" }]);
    expect(res.create).toEqual([]);
  });

  it("restored: somebody who has left keeps their credit, and a credit used elsewhere stands", () => {
    const existing = [credit("c1", "jake", "cancelled-week"), credit("c2", "alex", "cancelled-week", { appliedMonthId: "m-nov" })];
    const res = decide({ cancelled: false, members: [member("jake", { inClub: false }), member("alex")], existing });
    expect(res.voidIds).toEqual([]);
  });

  it("cancelled again after a restore: written again", () => {
    const existing = [credit("c1", "alex", "cancelled-week", { voidedAt: new Date() })];
    expect(decide({ members: [member("alex")], existing }).create).toEqual([{ userId: "alex", applyNow: false }]);
  });
});

describe("leaving part-way through", () => {
  const games = [
    { matchId: "g1", date: at("2026-10-05", "20:00") },
    { matchId: "g2", date: at("2026-10-12", "20:00") },
    { matchId: "g3", date: at("2026-10-19", "20:00") },
    { matchId: null, date: at("2026-10-26", "20:00") },
  ];
  const leaver = { regular: false, offMonth: true, inClub: true, paid: "confirmed" as const };
  const decide = (o: Partial<Parameters<typeof decideLeaverCredits>[0]> = {}) =>
    decideLeaverCredits({ member: leaver, leftAt: at("2026-10-13"), games, existing: [], creditedMatchIds: new Set(), ...o });

  it("a leaver is a regular who paid and is one no longer", () => {
    expect(isLeaver(leaver)).toBe(true);
    expect(isLeaver({ regular: true, offMonth: false, inClub: false, paid: "claimed" })).toBe(true);
    expect(isLeaver({ regular: true, offMonth: false, inClub: true, paid: "confirmed" })).toBe(false);
    // Somebody who never paid is owed nothing.
    expect(isLeaver({ regular: false, offMonth: true, inClub: true, paid: "none" })).toBe(false);
  });

  it("is owed one game for every game still to play when they left", () => {
    expect(decide().create).toEqual([{ matchId: "g3" }, { matchId: null }]);
  });

  it("does not count a game they already hold a credit for", () => {
    expect(decide({ creditedMatchIds: new Set(["g3"]) }).create).toEqual([{ matchId: null }]);
  });

  it("is written once: a retry adds nothing", () => {
    const existing = [credit("l1", "jake", "left-mid-month"), credit("l2", "jake", "left-mid-month")];
    expect(decide({ existing })).toEqual({ create: [], voidIds: [] });
  });

  it("is never written again once the collector has refunded it, or an organiser removed one", () => {
    const existing = [credit("l1", "jake", "left-mid-month", { voidedAt: new Date(), voidedById: "sam" })];
    expect(decide({ existing })).toEqual({ create: [], voidIds: [] });
  });

  it("somebody who never paid is owed nothing", () => {
    expect(decide({ member: { ...leaver, paid: "none" } })).toEqual({ create: [], voidIds: [] });
  });

  it("somebody who is back has the unused ones taken back, and only those", () => {
    const existing = [
      credit("l1", "jake", "left-mid-month"),
      credit("l2", "jake", "left-mid-month", { appliedMonthId: "m-nov" }),
      credit("l3", "jake", "left-mid-month", { createdById: "rob" }),
    ];
    const back = { regular: true, offMonth: false, inClub: true, paid: "confirmed" as const };
    expect(decide({ member: back, existing })).toEqual({ create: [], voidIds: ["l1"] });
  });

  it("gone from the group and off the month both: still not taken back", () => {
    const existing = [credit("l1", "jake", "left-mid-month")];
    expect(decide({ member: { regular: false, offMonth: true, inClub: false, paid: "none" }, existing })).toEqual({ create: [], voidIds: [] });
  });

  it("is worth the share of the month they left, at their own tier", () => {
    expect(leaverOwedPence({ games: 2, tier: "standard", sharePence: 750, concessionPence: 500 })).toBe(1500);
    expect(leaverOwedPence({ games: 2, tier: "concession", sharePence: 750, concessionPence: 500 })).toBe(1000);
    expect(leaverOwedPence({ games: 2, tier: "concession", sharePence: 750, concessionPence: null })).toBe(1500);
    expect(leaverOwedPence({ games: 2, tier: "standard", sharePence: null, concessionPence: null })).toBeNull();
  });
});

describe("a share changed after somebody paid", () => {
  const m = (userId: string, o: Partial<ShareMember> = {}): ShareMember => ({
    userId,
    name: userId,
    tier: "standard",
    owes: true,
    gamesCovered: 4,
    creditsApplied: 0,
    amountDuePence: 3000,
    paid: "none",
    paidPence: null,
    refundedPence: 0,
    ...o,
  });

  it("the balance of a paid regular is what is asked now, minus what they paid, plus what was refunded", () => {
    expect(paidBalancePence({ paid: "confirmed", amountDuePence: 3200, paidPence: 3000, refundedPence: 0 })).toBe(200);
    expect(paidBalancePence({ paid: "confirmed", amountDuePence: 2800, paidPence: 3000, refundedPence: 0 })).toBe(-200);
    expect(paidBalancePence({ paid: "confirmed", amountDuePence: 2800, paidPence: 3000, refundedPence: 200 })).toBe(0);
    expect(paidBalancePence({ paid: "none", amountDuePence: 3200, paidPence: null, refundedPence: 0 })).toBe(0);
    expect(paidBalancePence({ paid: "claimed", amountDuePence: 3200, paidPence: null, refundedPence: 0 })).toBe(0);
  });

  it("re-prices everybody, changes nobody's payment, and shows the difference", () => {
    const rows = planShareChange({
      sharePence: 800,
      concessionPence: 500,
      members: [
        m("alex", { paid: "confirmed", paidPence: 3000 }),
        m("bilal", { paid: "claimed", paidPence: null, creditsApplied: 1, amountDuePence: 2250 }),
        m("carl", { tier: "concession", amountDuePence: 2000 }),
        m("omar", { owes: false }),
      ],
    });
    expect(rows).toEqual([
      { userId: "alex", name: "alex", amountDuePence: 3200, freezeClaimedPence: null, balancePence: 200 },
      // Says paid, no amount recorded: what he was asked for then (£22.50) is written down.
      { userId: "bilal", name: "bilal", amountDuePence: 2400, freezeClaimedPence: 2250, balancePence: 150 },
      // Not paid: simply asked for the new amount.
      { userId: "carl", name: "carl", amountDuePence: 2000, freezeClaimedPence: null, balancePence: 0 },
    ]);
  });

  it("a lower share leaves a paid regular owed the difference", () => {
    const [row] = planShareChange({ sharePence: 700, concessionPence: null, members: [m("alex", { paid: "confirmed", paidPence: 3000 })] });
    expect(row.balancePence).toBe(-200);
  });
});

describe("the month close", () => {
  const last = at("2026-10-26", "20:00");
  it("is due from 08:00 the morning after the last game, in waking hours", () => {
    expect(monthCloseDue({ now: at("2026-10-26", "23:30"), lastKickoff: last })).toBe(false);
    expect(monthCloseDue({ now: at("2026-10-27", "07:59"), lastKickoff: last })).toBe(false);
    expect(monthCloseDue({ now: at("2026-10-27", "08:00"), lastKickoff: last })).toBe(true);
    expect(monthCloseDue({ now: at("2026-10-27", "22:30"), lastKickoff: last })).toBe(false);
    expect(monthCloseDue({ now: at("2026-10-28", "09:00"), lastKickoff: last })).toBe(true);
  });

  it("the summary's numbers against a worked month", () => {
    const s = summariseMonth({
      gamesPlayed: 4,
      regulars: [
        { name: "Alex", amountDuePence: 3000, paid: "confirmed", paidPence: 3000, refundedPence: 0 },
        { name: "Bilal", amountDuePence: 2250, paid: "confirmed", paidPence: 2250, refundedPence: 0 },
        { name: "Jake", amountDuePence: 2250, paid: "claimed", paidPence: null, refundedPence: 0 },
        { name: "Carl", amountDuePence: 3000, paid: "none", paidPence: null, refundedPence: 0 },
        { name: "Dev", amountDuePence: 3200, paid: "confirmed", paidPence: 3000, refundedPence: 0 },
        { name: "Ed", amountDuePence: 2800, paid: "confirmed", paidPence: 3000, refundedPence: 0 },
        // Nothing to pay (credits covered it): not "unpaid".
        { name: "Fred", amountDuePence: 0, paid: "none", paidPence: null, refundedPence: 0 },
      ],
      payg: [
        { name: "Omar", date: at("2026-10-12", "20:00"), feePence: 800, paid: false },
        { name: "Omar", date: at("2026-10-19", "20:00"), feePence: 800, paid: true },
        { name: "Will", date: at("2026-10-26", "20:00"), feePence: 800, paid: true },
      ],
      carried: [
        { name: "Sam", games: 1 },
        { name: "Rob", games: 1 },
        { name: "Sam", games: 1 },
      ],
      creditsUsed: 3,
      leavers: [
        { name: "Jake", games: 2, pence: 1500 },
        { name: "Hal", games: 0, pence: 0 },
      ],
    });
    expect(s.regulars).toBe(7);
    expect(s.confirmed).toEqual({ count: 4, totalPence: 11250 });
    expect(s.claimed).toEqual([{ name: "Jake", pence: 2250 }]);
    expect(s.unpaid).toEqual([{ name: "Carl", pence: 3000 }]);
    expect(s.owesMore).toEqual([{ name: "Dev", pence: 200 }]);
    expect(s.owedBack).toEqual([{ name: "Ed", pence: 200 }]);
    expect(s.payg.games).toBe(3);
    expect(s.payg.totalPence).toBe(2400);
    expect(s.payg.paid).toBe(2);
    expect(s.payg.toChase).toEqual([{ name: "Omar", date: at("2026-10-12", "20:00") }]);
    expect(s.carried).toEqual({
      games: 3,
      people: [
        { name: "Sam", games: 2 },
        { name: "Rob", games: 1 },
      ],
    });
    expect(s.creditsUsed).toBe(3);
    expect(s.leavers).toEqual([{ name: "Jake", games: 2, pence: 1500 }]);
  });
});

describe("away weeks", () => {
  const now = at("2026-10-13");
  const games = [
    { matchId: "g1", date: at("2026-10-05", "20:00"), seeded: true },
    { matchId: "g2", date: at("2026-10-19", "20:00"), seeded: true },
    { matchId: "g3", date: at("2026-10-26", "20:00"), seeded: false },
    { matchId: "g4", date: at("2026-11-02", "20:00"), seeded: false },
  ];
  it("stores the ticked weeks that can still be ticked", () => {
    expect(planAwayWeeks({ games, ticked: ["g3", "g4"], current: [], now })).toEqual({ absentMatchIds: ["g3", "g4"], changed: true });
  });
  it("never changes a game that was played, or one the squad is already on", () => {
    expect(planAwayWeeks({ games, ticked: ["g1", "g2", "g3"], current: [], now }).absentMatchIds).toEqual(["g3"]);
    // An away week already recorded for a played game stays, whatever is ticked.
    expect(planAwayWeeks({ games, ticked: [], current: ["g1", "g3"], now })).toEqual({ absentMatchIds: ["g1"], changed: true });
  });
  it("the same ticks again change nothing", () => {
    expect(planAwayWeeks({ games, ticked: ["g3", "g3"], current: ["g3"], now })).toEqual({ absentMatchIds: ["g3"], changed: false });
  });
  it("a match that is not one of the month's games is ignored", () => {
    expect(planAwayWeeks({ games, ticked: ["other"], current: [], now })).toEqual({ absentMatchIds: [], changed: false });
  });
});

// ── Rules that live beside their slice ─────────────────────────────────
import { creditInArrears } from "../month-payment-rules";
import { mayJoinStartedMonth } from "../month-signup-rules";

describe("credits in arrears", () => {
  const pricedAt = at("2026-10-24");
  it("a credit earned after the next month was priced lands in the month after", () => {
    expect(creditInArrears({ createdAt: at("2026-10-27") }, pricedAt)).toBe(true);
    expect(creditInArrears({ createdAt: at("2026-10-20") }, pricedAt)).toBe(false);
  });
  it("a month not priced yet holds nothing back", () => {
    expect(creditInArrears({ createdAt: at("2026-10-27") }, null)).toBe(false);
  });
});

describe("joining a month that has started", () => {
  const ok = { choice: "in" as const, source: "reply", gamesLeft: 3, running: true };
  it("a player may join for the games left, by message or on their page", () => {
    expect(mayJoinStartedMonth(ok)).toBe(true);
    expect(mayJoinStartedMonth({ ...ok, source: "page" })).toBe(true);
  });
  it("never out or pay-as-you-go, never by a pasted list, never with no game left, never while sign-up is open", () => {
    expect(mayJoinStartedMonth({ ...ok, choice: "out" })).toBe(false);
    expect(mayJoinStartedMonth({ ...ok, choice: "payg" })).toBe(false);
    expect(mayJoinStartedMonth({ ...ok, source: "paste" })).toBe(false);
    expect(mayJoinStartedMonth({ ...ok, gamesLeft: 0 })).toBe(false);
    expect(mayJoinStartedMonth({ ...ok, running: false })).toBe(false);
  });
});

// ── Review round 1 (2026-10-06) ────────────────────────────────────────
import { decideMissedCredits } from "../monthly-week-rules";
import { refundAllowed, closedDigestReply } from "../month-close-rules";

describe("one live credit per player per game, whatever the reason", () => {
  const wk = (userId: string, o: Record<string, unknown> = {}) => ({ userId, name: userId, kind: "regular" as const, slot: 1, paid: "confirmed" as const, absent: false, paygDated: false, left: false, ...o });

  it("a missed credit is not written beside another live credit for the same game", () => {
    // Jake paid, left the group (he holds a left-mid-month credit for this
    // game), and the organiser then drops him from the seeded game.
    const args = {
      rule: "any-miss" as const,
      members: [wk("jake", { left: true })],
      rows: [{ userId: "jake", name: "jake", status: "DROPPED" as const, position: 1 }],
      maxPlayers: 6,
      existing: [],
    };
    expect(decideMissedCredits(args).create).toEqual(["jake"]);
    expect(decideMissedCredits({ ...args, creditedElsewhere: new Set(["jake"]) }).create).toEqual([]);
  });

  it("a cancelled-week credit is not written beside a live left-mid-month credit for the same game", () => {
    const res = decideCancelledWeekCredits({
      cancelled: true,
      matchDate: GAME,
      monthId: MONTH,
      members: [member("jake")],
      existing: [credit("l1", "jake", "left-mid-month")],
    });
    expect(res.create).toEqual([]);
  });
});

describe("a restored game whose credit was already used against another month", () => {
  it("is handed back for that month to take off again, not silently kept", () => {
    const res = decideCancelledWeekCredits({
      cancelled: false,
      matchDate: GAME,
      monthId: MONTH,
      members: [member("alex")],
      existing: [credit("c1", "alex", "cancelled-week", { appliedMonthId: "m-nov" })],
    });
    expect(res.voidIds).toEqual([]);
    expect(res.releaseElsewhere).toEqual([{ creditId: "c1", userId: "alex", monthId: "m-nov" }]);
  });
});

describe("a refund", () => {
  it("is never more than what was paid", () => {
    expect(refundAllowed({ amountPence: 3000, paidPence: 3000 })).toBe(true);
    expect(refundAllowed({ amountPence: 0, paidPence: 3000 })).toBe(true);
    expect(refundAllowed({ amountPence: 3001, paidPence: 3000 })).toBe(false);
    expect(refundAllowed({ amountPence: -1, paidPence: 3000 })).toBe(false);
    expect(refundAllowed({ amountPence: 1.5, paidPence: 3000 })).toBe(false);
  });
  it("with no payment recorded, nothing can be refunded", () => {
    expect(refundAllowed({ amountPence: 100, paidPence: null })).toBe(false);
    expect(refundAllowed({ amountPence: 0, paidPence: null })).toBe(true);
  });
});

describe("a reply to a closed month's digest", () => {
  const digestAt = at("2026-10-27", "10:00");
  const base = { reply: { kind: "all" as const }, closed: { monthNumber: 10, digestAt, listedSlots: [1, 3] }, liveDigestAt: null, now: at("2026-10-27", "18:00") };
  it("is answered when that digest is the newest, or the reply names the month", () => {
    expect(closedDigestReply(base)).toBe(true);
    expect(closedDigestReply({ ...base, liveDigestAt: at("2026-10-27", "09:00") })).toBe(true);
    expect(closedDigestReply({ ...base, liveDigestAt: at("2026-10-27", "11:00"), reply: { kind: "all", month: 10 } })).toBe(true);
  });
  it("is not when a live month's digest is newer, the reply names another month, or it is out of date", () => {
    expect(closedDigestReply({ ...base, liveDigestAt: at("2026-10-27", "11:00") })).toBe(false);
    expect(closedDigestReply({ ...base, reply: { kind: "all", month: 11 } })).toBe(false);
    expect(closedDigestReply({ ...base, now: at("2026-10-30", "18:00") })).toBe(false);
  });
  it("a number that was not on that list is somebody's own message", () => {
    expect(closedDigestReply({ ...base, reply: { kind: "numbers", numbers: [3] } })).toBe(true);
    expect(closedDigestReply({ ...base, reply: { kind: "numbers", numbers: [8] } })).toBe(false);
  });
});
