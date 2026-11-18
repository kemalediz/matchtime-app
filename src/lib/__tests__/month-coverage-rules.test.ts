/**
 * HOW MUCH OF A MONTH A REGULAR COVERS (2026-11-16, Kemal), and the review
 * of PR #611. Pure rules, on fixed dates with real join dates and games
 * already played:
 *
 *   - the bounds: never fewer than the games he was covered for that are
 *     already played plus the games left (coverage only changes the
 *     future); the whole month is the seed's rule; the add form counts only
 *     playable games;
 *   - the editor's checks: a "4 only" kept while it fits; credits within
 *     the CHECK;
 *   - whole-month members are credited for a cancelled week as a seeded
 *     regular is, whatever their join date (one rule);
 *   - the question in HQ: a quoted reply answers the question it quotes, a
 *     plain one the newest, and "which player?" when it is not clear.
 * No database, no model.
 */
import { describe, expect, it } from "vitest";
import {
  COVERAGE_ASK_PREFIX,
  coverageAnswerTarget,
  coverageAskRef,
  coverageOptions,
  coverageSettledPrefix,
  shownCoverage,
  creditsCountFrom,
  decideCoverage,
  memberCoverageBounds,
  monthCoverage,
  parseCoverageAskRef,
} from "@/lib/month-coverage-rules";
import { decideCancelledWeekCredits } from "@/lib/month-close-rules";
import { planMonthSeed, wholeMonthGames } from "@/lib/squad-month-rules";
import type { HqLogRow } from "@/lib/admin-group-log";

// November 2026: Mondays 2, 9, 16, 23, 30 at 20:30 London (UTC in November).
const KICKOFFS = [2, 9, 16, 23, 30].map((d) => new Date(Date.UTC(2026, 10, d, 20, 30)));
const at = (d: number, h = 12) => new Date(Date.UTC(2026, 10, d, h, 0));
const month = (now: Date, over: Partial<Parameters<typeof monthCoverage>[0]> = {}) =>
  monthCoverage({ gamesScheduled: 5, kickoffs: KICKOFFS, now, ...over });

describe("the month: games left, the whole month, the playable games", () => {
  it("the whole month is the seed's rule: every game scheduled", () => {
    expect(wholeMonthGames(5)).toBe(5);
    expect(month(at(24))).toEqual({ gamesLeft: 1, whole: 5, playable: 5 });
  });

  it("the seed covers its regulars by the same rule", () => {
    const plan = planMonthSeed(
      { activityId: "a1", source: "seed-tick", gamesScheduled: 5, gamesPlayed: 2, sharePerGamePence: 750, rows: [{ userId: "u1", kind: "regular" }] },
      { now: at(10), actorUserId: "org", memberUserIds: new Set(["u1"]) },
    );
    expect(plan.ok && plan.members[0].gamesCovered).toBe(wholeMonthGames(5));
  });

  it("a cancelled week is in the whole month (as the seed counts it) but not in what the add form calls playable", () => {
    const four = KICKOFFS.filter((_, i) => i !== 1);
    expect(monthCoverage({ gamesScheduled: 5, kickoffs: four, now: at(5) })).toEqual({ gamesLeft: 3, whole: 5, playable: 4 });
  });
});

describe("a member's bounds: coverage only changes the future (review of #611, item 1)", () => {
  it("THE BUG: added on 6 Nov for the 4 games left, on 24 Nov he cannot be cut below those 4", () => {
    const b = memberCoverageBounds(month(at(24)), { joinedAt: at(6), source: "admin", kickoffs: KICKOFFS, now: at(24) });
    // Played since he joined: 9, 16, 23. Left: 30. Never fewer than 4.
    expect(b).toEqual({ min: 4, max: 5 });
    const row = { kind: "regular" as const, out: false, gamesCovered: 4, gamesCommitted: null, creditsApplied: 0 };
    expect(decideCoverage({ target: 1, bounds: b, row })).toEqual({ ok: false, error: "below-games-left" });
    expect(decideCoverage({ target: "left", bounds: b, row })).toMatchObject({ ok: true, changed: false, gamesCovered: 4 });
    expect(decideCoverage({ target: "whole", bounds: b, row })).toMatchObject({ ok: true, changed: true, gamesCovered: 5 });
  });

  it("after the month's last kickoff nobody can be cut to 1: what he played stays covered", () => {
    expect(memberCoverageBounds(month(at(30, 23)), { joinedAt: at(6), source: "admin", kickoffs: KICKOFFS, now: at(30, 23) })).toEqual({ min: 4, max: 5 });
  });

  it("a seeded regular counts from the month's first game: he cannot be lowered", () => {
    expect(memberCoverageBounds(month(at(24)), { joinedAt: at(10), source: "seed-list", kickoffs: KICKOFFS, now: at(24) })).toEqual({ min: 5, max: 5 });
  });

  it("somebody added today covers at least the games left (the add's 'games left')", () => {
    expect(memberCoverageBounds(month(at(24)), { joinedAt: at(24), source: "admin", kickoffs: KICKOFFS, now: at(24) })).toEqual({ min: 1, max: 5 });
  });

  it("a late joiner given the whole month by mistake goes back to the games he joined for, no lower", () => {
    const b = memberCoverageBounds(month(at(24)), { joinedAt: at(6), source: "admin", kickoffs: KICKOFFS, now: at(24) });
    const row = { kind: "regular" as const, out: false, gamesCovered: 5, gamesCommitted: null, creditsApplied: 0 };
    expect(decideCoverage({ target: "left", bounds: b, row })).toMatchObject({ ok: true, gamesCovered: 4 });
  });
});

describe("round 3, item 3: each called-off week counted once", () => {
  // December 2026: Mondays 7, 14, 21, 28. The 21st called off BEFORE the
  // list opened: `openMonthList` already left it out of gamesScheduled (3).
  const DEC = [7, 14, 21, 28].map((d) => new Date(Date.UTC(2026, 11, d, 20, 30)));
  const dec = DEC.filter((_, i) => i !== 2);

  it("called off before the list opened: the whole month says 3 playable games, not 2", () => {
    expect(monthCoverage({ gamesScheduled: 3, kickoffs: dec, now: new Date(Date.UTC(2026, 10, 30)) })).toEqual({ gamesLeft: 3, whole: 3, playable: 3 });
  });

  it("called off after the list opened (it is in gamesScheduled): 4 scheduled, 3 playable", () => {
    expect(monthCoverage({ gamesScheduled: 4, kickoffs: dec, now: new Date(Date.UTC(2026, 10, 30)) })).toEqual({ gamesLeft: 3, whole: 4, playable: 3 });
  });
});

describe("round 3, item 5: coverage shown in playable games, one consistent number", () => {
  // November: five Mondays, the 23rd called off after the month was counted.
  const games = KICKOFFS.filter((_, i) => i !== 3);
  const nov = monthCoverage({ gamesScheduled: 5, kickoffs: games, now: at(14) });

  it("the whole month, credited for the week off: 4 of 4", () => {
    expect(shownCoverage({ gamesCovered: 5, creditedCancelled: 1 }, nov)).toEqual({ games: 4, of: 4, wholeMonth: true });
  });

  it("joined 10 Nov for 16, 23, 30, credited for the 23rd: 2 of 4", () => {
    expect(shownCoverage({ gamesCovered: 3, creditedCancelled: 1 }, nov)).toEqual({ games: 2, of: 4, wholeMonth: false });
  });

  it("joined 13 Nov for 16 and 30, no credit: 2 of 4", () => {
    expect(shownCoverage({ gamesCovered: 2, creditedCancelled: 0 }, nov)).toEqual({ games: 2, of: 4, wholeMonth: false });
  });

  it("the editor's options: in playable games, each shown once, the whole month last", () => {
    // Joined 13 Nov, no credit yet: 2..5 stored; 4 and 5 are both every
    // playable game, so only the whole month (5) is offered for it.
    expect(coverageOptions({ min: 2, max: 5 }, nov, 0)).toEqual([
      { value: 2, games: 2, of: 4, least: true, wholeMonth: false },
      { value: 3, games: 3, of: 4, least: false, wholeMonth: false },
      { value: 5, games: 4, of: 4, least: false, wholeMonth: true },
    ]);
    // Joined 10 Nov, credited for the 23rd: 3..5 stored are 2..4 played.
    expect(coverageOptions({ min: 3, max: 5 }, nov, 1).map((o) => [o.value, o.games])).toEqual([[3, 2], [4, 3], [5, 4]]);
  });
});

describe("round 2, item 1: lowering never removes a week he holds a cancellation credit for", () => {
  // The reviewers' fixture: £7.50, five Mondays (2, 9, 16, 23, 30), two
  // played (now 14 Nov), the 23rd called off on 12 Nov. The month's games
  // leave the called-off week out.
  const now = at(14);
  const games = KICKOFFS.filter((_, i) => i !== 3);
  const nov = monthCoverage({ gamesScheduled: 5, kickoffs: games, now });
  const bounds = (joinedAt: Date, creditedCancelled: number, source = "admin") => memberCoverageBounds(nov, { joinedAt, source, kickoffs: games, now, creditedCancelled });
  const row = (gamesCovered: number, gamesCommitted: number | null = null) => ({ kind: "regular" as const, out: false, gamesCovered, gamesCommitted, creditsApplied: 0 });

  it("the month: 2 left (16, 30), the whole month 5, 4 playable", () => {
    expect(nov).toEqual({ gamesLeft: 2, whole: 5, playable: 4 });
  });

  it("pre-start unpaid regular (carried over, credited for the 23rd): stays at 5", () => {
    const b = bounds(new Date(Date.UTC(2026, 9, 25)), 1, "carry-over");
    expect(b).toEqual({ min: 5, max: 5 });
    expect(decideCoverage({ target: "left", bounds: b, row: row(5) })).toMatchObject({ ok: true, changed: false, gamesCovered: 5 });
    expect(decideCoverage({ target: 4, bounds: b, row: row(5) })).toEqual({ ok: false, error: "below-games-left" });
  });

  it("joined 10 Nov (16, 23, 30; credited for the 23rd): never below 3", () => {
    const b = bounds(at(10), 1);
    expect(b).toEqual({ min: 3, max: 5 });
    expect(decideCoverage({ target: 2, bounds: b, row: row(3) })).toEqual({ ok: false, error: "below-games-left" });
  });

  it("joined 13 Nov (after it was called off), raised to the whole month and so credited for it: back to 3 at the least, never 2", () => {
    const b = bounds(at(13), 1);
    expect(b).toEqual({ min: 3, max: 5 });
    expect(decideCoverage({ target: "left", bounds: b, row: row(5) })).toMatchObject({ ok: true, gamesCovered: 3 });
    expect(decideCoverage({ target: 2, bounds: b, row: row(5) })).toEqual({ ok: false, error: "below-games-left" });
    // Not credited (never raised): his own 2 games are the floor.
    expect(bounds(at(13), 0)).toEqual({ min: 2, max: 5 });
  });

  it("a '4 only' regular credited for the 23rd keeps his commitment and is never lowered below the floor", () => {
    const b = bounds(new Date(Date.UTC(2026, 9, 25)), 1, "carry-over");
    expect(decideCoverage({ target: 4, bounds: b, row: row(5, 4) })).toEqual({ ok: false, error: "below-games-left" });
  });
});

describe("the editor's checks", () => {
  const b = { min: 3, max: 5 };
  const regular = (over: Record<string, unknown> = {}) => ({ kind: "regular" as const, out: false, gamesCovered: 3, gamesCommitted: null as number | null, creditsApplied: 0, ...over });

  it("refuses more than the month and a number that is not whole", () => {
    expect(decideCoverage({ target: 6, bounds: b, row: regular() })).toEqual({ ok: false, error: "more-than-the-month" });
    expect(decideCoverage({ target: 3.5, bounds: b, row: regular() })).toEqual({ ok: false, error: "bad-games" });
  });

  it("only a regular who is on the month has a coverage", () => {
    expect(decideCoverage({ target: "whole", bounds: b, row: null })).toEqual({ ok: false, error: "not-a-member" });
    expect(decideCoverage({ target: "whole", bounds: b, row: regular({ out: true }) })).toEqual({ ok: false, error: "not-a-member" });
    expect(decideCoverage({ target: "whole", bounds: b, row: regular({ kind: "payg" }) })).toEqual({ ok: false, error: "not-a-regular" });
  });

  it("refuses to cover fewer games than the credits taken off the month (the DB CHECK)", () => {
    expect(decideCoverage({ target: 3, bounds: b, row: regular({ gamesCovered: 5, creditsApplied: 4 }) })).toEqual({ ok: false, error: "below-credits" });
  });

  it("THE ROUND TRIP (review item 6): a '3 only' lowered to 3 and raised to 5 is still '3 only'", () => {
    const down = decideCoverage({ target: 3, bounds: b, row: regular({ gamesCovered: 5, gamesCommitted: 3 }) });
    expect(down).toEqual({ ok: true, changed: true, gamesCovered: 3, gamesCommitted: 3 });
    const up = decideCoverage({ target: 5, bounds: b, row: regular({ gamesCovered: 3, gamesCommitted: 3 }) });
    expect(up).toEqual({ ok: true, changed: true, gamesCovered: 5, gamesCommitted: 3 });
  });

  it("a commitment that no longer fits is cleared: it plays every game it covers", () => {
    expect(decideCoverage({ target: 3, bounds: b, row: regular({ gamesCovered: 5, gamesCommitted: 4 }) })).toEqual({ ok: true, changed: true, gamesCovered: 3, gamesCommitted: null });
  });
});

describe("cancelled weeks: a whole-month member is credited as a seeded regular is (review item 7)", () => {
  const countedAt = at(1, 9);
  const cancelledAt = at(3);
  const plan = (joinedAt: Date, gamesCovered: number) =>
    decideCancelledWeekCredits({
      cancelled: true,
      matchDate: KICKOFFS[0],
      cancelledAt,
      monthId: "m",
      members: [{ userId: "u", regular: true, inClub: true, paid: "claimed", joinedAt: creditsCountFrom({ joinedAt, gamesCovered }, { gamesScheduled: 5, countedAt }) }],
      existing: [],
    });

  it("a late joiner on the whole month is credited for the week called off before he joined", () => {
    expect(plan(at(6), 5).create).toEqual([{ userId: "u", applyNow: false }]);
  });

  it("a late joiner for the games left is not: he never paid for it", () => {
    expect(plan(at(6), 4).create).toEqual([]);
  });

  it("the rule never moves a join date later", () => {
    expect(creditsCountFrom({ joinedAt: at(1, 8), gamesCovered: 5 }, { gamesScheduled: 5, countedAt })).toEqual(at(1, 8));
    expect(creditsCountFrom({ joinedAt: at(6), gamesCovered: 4 }, { gamesScheduled: 5, countedAt })).toEqual(at(6));
  });
});

describe("the question in HQ (review item 3)", () => {
  it("its ask ref carries the month and the player, and nothing else parses as one", () => {
    const ref = coverageAskRef("month-1", "user-9");
    expect(ref.startsWith(COVERAGE_ASK_PREFIX)).toBe(true);
    expect(parseCoverageAskRef(ref)).toEqual({ monthId: "month-1", userId: "user-9" });
    expect(parseCoverageAskRef("ask-source:club+pool")).toBeNull();
    expect(parseCoverageAskRef(`${COVERAGE_ASK_PREFIX}only-one`)).toBeNull();
    expect(parseCoverageAskRef(null)).toBeNull();
  });

  const t = (min: number) => new Date(Date.UTC(2026, 10, 16, 12, min));
  const q = (id: string, userId: string, min: number): HqLogRow => ({
    waMessageId: id,
    fromMatchTime: true,
    senderUserId: null,
    text: `📋 ${userId} on the November list: whole month, or just the games left?`,
    askRef: coverageAskRef("m1", userId),
    createdAt: t(min),
  });
  const chat = (min: number): HqLogRow => ({ waMessageId: `w${min}`, fromMatchTime: false, senderUserId: "o2", text: "lol", askRef: null, createdAt: t(min) });
  const ben = q("mt:q-ben", "ben", 0);
  const zara = q("mt:q-zara", "zara", 1);

  it("a plain answer right after it is in the place of an answer to the newest", () => {
    expect(coverageAnswerTarget({ quoted: null, log: [ben, zara], now: t(2) })).toEqual({ kind: "asked", monthId: "m1", userId: "zara" });
  });

  it("a reply quoting an EARLIER question answers that one, not the newest", () => {
    expect(coverageAnswerTarget({ quoted: { messageId: null, text: ben.text, fromMatchTime: true }, log: [ben, zara], now: t(3) })).toEqual({ kind: "asked", monthId: "m1", userId: "ben" });
  });

  it("a reply quoting something else answers no question", () => {
    expect(coverageAnswerTarget({ quoted: { messageId: "w1", text: "lol", fromMatchTime: false }, log: [ben, chat(1)], now: t(3) })).toBeNull();
  });

  it("not clear which (somebody spoke since, two players asked about): which player", () => {
    expect(coverageAnswerTarget({ quoted: null, log: [ben, zara, chat(2)], now: t(3) })).toEqual({ kind: "which", userIds: ["ben", "zara"] });
  });

  it("a question already settled is not open: it is not one of the players to choose from", () => {
    const settled: HqLogRow = { waMessageId: `${coverageSettledPrefix("m1", "ben")}1`, fromMatchTime: true, senderUserId: null, text: "✅ Ben covers", askRef: null, createdAt: t(1) };
    const amy = q("mt:q-amy", "amy", 1);
    expect(coverageAnswerTarget({ quoted: null, log: [ben, settled, amy, zara, chat(2)], now: t(3) })).toEqual({ kind: "which", userIds: ["amy", "zara"] });
    expect(coverageAnswerTarget({ quoted: null, log: [ben, settled, zara, chat(2)], now: t(3) })).toBeNull();
  });

  it("one question and somebody spoke since, or past the window: no answer", () => {
    expect(coverageAnswerTarget({ quoted: null, log: [ben], now: t(60) })).toBeNull();
    expect(coverageAnswerTarget({ quoted: null, log: [ben, chat(1)], now: t(2) })).toBeNull();
  });

  // ── Round 4, item 4: two questions in one reply ────────────────────
  const REPLY = "✅ Tom is on the November list as a regular for the 3 games left.\n\n📋 Dan on the November list: whole month, or just the games left?\n📋 Ben on the November list: whole month, or just the games left?";
  const inReply = (id: string, userId: string, opts: { stanza?: string } = {}): HqLogRow => ({
    waMessageId: id,
    fromMatchTime: true,
    senderUserId: null,
    text: REPLY,
    askRef: coverageAskRef("m1", userId),
    createdAt: new Date(t(5).getTime() + (userId === "ben" ? 200 : 0)),
    ...(opts.stanza ? { waStanzaId: opts.stanza } : {}),
  });

  it("its ask ref carries no payment: anything after the player does not parse (round 4, option a)", () => {
    expect(parseCoverageAskRef(`${COVERAGE_ASK_PREFIX}m1:u1:paid`)).toBeNull();
  });

  it("a plain 'whole month' right after a reply asking about two players: which player, never the newest", () => {
    const log = [inReply("mt:q-dan", "dan"), inReply("mt:q-ben", "ben")];
    expect(coverageAnswerTarget({ quoted: null, log, now: t(6) })).toEqual({ kind: "which", userIds: ["dan", "ben"] });
  });

  it("quoting that multi-line reply (its id stamped on both questions, other lines first): which player", () => {
    const log = [inReply("mt:q-dan", "dan", { stanza: "3EB0REPLY" }), inReply("mt:q-ben", "ben", { stanza: "3EB0REPLY" }), chat(6)];
    expect(coverageAnswerTarget({ quoted: { messageId: "3EB0REPLY", text: REPLY, fromMatchTime: true }, log, now: t(7) })).toEqual({ kind: "which", userIds: ["dan", "ben"] });
    // Quoted by its words alone (no id known): the same.
    expect(coverageAnswerTarget({ quoted: { messageId: null, text: REPLY, fromMatchTime: true }, log, now: t(7) })).toEqual({ kind: "which", userIds: ["dan", "ben"] });
  });

  it("one of the two settled since by name: quoting the reply answers the other", () => {
    const settled: HqLogRow = { waMessageId: `${coverageSettledPrefix("m1", "dan")}1`, fromMatchTime: true, senderUserId: null, text: "✅ Dan covers", askRef: null, createdAt: t(6) };
    const log = [inReply("mt:q-dan", "dan", { stanza: "3EB0REPLY" }), inReply("mt:q-ben", "ben", { stanza: "3EB0REPLY" }), settled];
    expect(coverageAnswerTarget({ quoted: { messageId: "3EB0REPLY", text: REPLY, fromMatchTime: true }, log, now: t(7) })).toEqual({ kind: "asked", monthId: "m1", userId: "ben" });
  });

  it("a reply about ONE player, quoted with other lines first: that player", () => {
    const one: HqLogRow = { ...inReply("mt:q-ian", "ian", { stanza: "3EB0ONE" }), text: "✅ Ian is on the November list.\n\n📋 Ian on the November list: whole month, or just the games left?" };
    expect(coverageAnswerTarget({ quoted: { messageId: "3EB0ONE", text: one.text, fromMatchTime: true }, log: [one, chat(6)], now: t(7) })).toEqual({ kind: "asked", monthId: "m1", userId: "ian" });
  });
});
