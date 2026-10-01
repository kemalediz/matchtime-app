/**
 * Badge announcements (2026-10-01): who is announced, once only, which
 * badges, when, and the guarantee that switching the feature on never
 * floods a club with badges its players already hold.
 *
 * Pure: no DB, no clock. The scheduler wiring is covered end to end in
 * e2e/api/badge-announcements.spec.ts.
 */
import { describe, it, expect, vi } from "vitest";

// The lookback constant lives in the scheduler, which imports Prisma.
vi.mock("@/lib/db", () => ({ db: {} }));
import {
  ANNOUNCEABLE_BADGE_KEYS,
  BADGES_POST_RETRY_DAYS,
  badgesPostAt,
  badgesPostDue,
  badgesPostKey,
  buildBadgeAnnouncementPost,
  BADGE_FINAL_AFTER_DAYS,
  badgeMatchFinalised,
  pickBadgeAwards,
  replayBadges,
  selectBackfillRows,
  toReplayMatches,
  type RawBadgeMatch,
  type ReplayMatch,
} from "../badge-announcements";
import { MOM_ANNOUNCE_MAX_AGE_DAYS, POST_MATCH_LOOKBACK_DAYS } from "../bot-scheduler";
import {
  MASTERCLASS_MIN_GAME_AVG,
  MOM_MACHINE_MIN_WINS,
  REGULAR_MIN_GAMES,
  milestoneBadgesEarned,
} from "../badge-rules";

// ── helpers ───────────────────────────────────────────────────────────

let n = 0;
function match(over: Partial<ReplayMatch> = {}): ReplayMatch {
  n++;
  return {
    id: over.id ?? `m${n}`,
    played: over.played ?? [],
    ratings: over.ratings ?? [],
    momWinners: over.momWinners ?? [],
  };
}

/** `count` plain matches where `who` played and nothing else happened. */
function plain(count: number, who: string[]): ReplayMatch[] {
  return Array.from({ length: count }, () => match({ played: who }));
}

const ALL = new Set(["ali", "david", "sam", "jo", "left"]);

// ── the announceable set ──────────────────────────────────────────────

describe("ANNOUNCEABLE_BADGE_KEYS", () => {
  it("is exactly the six Kemal chose: first game, Regular, MoM, MoM Machine, Masterclass, Mr Reliable", () => {
    expect([...ANNOUNCEABLE_BADGE_KEYS].sort()).toEqual(
      ["first-game", "first-mom", "masterclass", "mom-machine", "reliable", "ten-games"].sort(),
    );
  });

  it("never includes Iron Man or Above the Curve", () => {
    expect(ANNOUNCEABLE_BADGE_KEYS as readonly string[]).not.toContain("ironman");
    expect(ANNOUNCEABLE_BADGE_KEYS as readonly string[]).not.toContain("above-field");
  });
});

// ── the shared rule (also read by player-stats.ts) ────────────────────

describe("milestoneBadgesEarned", () => {
  it("uses the shared thresholds the stats page and badge help use, at their edges", () => {
    const base = { gamesPlayed: 0, momCount: 0, perGameAverages: [] as number[], avgRating: null };
    expect(milestoneBadgesEarned({ ...base, gamesPlayed: REGULAR_MIN_GAMES - 1 })["ten-games"]).toBe(false);
    expect(milestoneBadgesEarned({ ...base, gamesPlayed: REGULAR_MIN_GAMES })["ten-games"]).toBe(true);
    expect(milestoneBadgesEarned({ ...base, momCount: MOM_MACHINE_MIN_WINS - 1 })["mom-machine"]).toBe(false);
    expect(milestoneBadgesEarned({ ...base, momCount: MOM_MACHINE_MIN_WINS })["mom-machine"]).toBe(true);
    expect(milestoneBadgesEarned({ ...base, perGameAverages: [MASTERCLASS_MIN_GAME_AVG - 0.01] }).masterclass).toBe(false);
    expect(milestoneBadgesEarned({ ...base, perGameAverages: [MASTERCLASS_MIN_GAME_AVG] }).masterclass).toBe(true);
  });

  it("holds the thresholds the stats page shows", () => {
    const none = milestoneBadgesEarned({ gamesPlayed: 0, momCount: 0, perGameAverages: [], avgRating: null });
    expect(Object.values(none).some(Boolean)).toBe(false);

    const e = milestoneBadgesEarned({ gamesPlayed: 10, momCount: 3, perGameAverages: [7, 7.2, 7.1, 9], avgRating: 7.6 });
    expect(e["first-game"]).toBe(true);
    expect(e["ten-games"]).toBe(true);
    expect(e["first-mom"]).toBe(true);
    expect(e["mom-machine"]).toBe(true);
    expect(e.masterclass).toBe(true);
    expect(milestoneBadgesEarned({ gamesPlayed: 9, momCount: 2, perGameAverages: [8.9], avgRating: 8.9 })["ten-games"]).toBe(false);
  });
});

// ── replay: who holds what, and since which match ─────────────────────

describe("replayBadges", () => {
  it("records the match at which each badge became held", () => {
    const ms = [...plain(9, ["ali"]), match({ id: "tenth", played: ["ali"] })];
    const r = replayBadges(ms);
    expect(r.held.get("ali")?.get("first-game")).toBe(ms[0].id);
    expect(r.held.get("ali")?.get("ten-games")).toBe("tenth");
  });

  it("counts a MoM only from the winners it is given (the caller passes decided results only)", () => {
    const r = replayBadges([match({ played: ["ali"], momWinners: [] })]);
    expect(r.held.get("ali")?.has("first-mom")).toBe(false);
  });

  it("Mr Reliable is not monotone: losing it drops it from held but keeps it in everEarned", () => {
    const steady = (id: string) => match({ id, played: ["ali"], ratings: [{ playerId: "ali", score: 7 }] });
    const ms = [steady("a"), steady("b"), steady("c"), steady("d"), match({ id: "e", played: ["ali"], ratings: [{ playerId: "ali", score: 2 }] })];
    const r = replayBadges(ms);
    expect(r.everEarned.get("ali")?.get("reliable")).toBe("d");
    expect(r.held.get("ali")?.has("reliable")).toBe(false);
  });
});

// ── picking who to announce ───────────────────────────────────────────

describe("pickBadgeAwards", () => {
  it("announces every badge newly earned at this match", () => {
    const ms = [...plain(9, ["david"]), match({ id: "now", played: ["david", "sam"], momWinners: ["david"] })];
    const announced = new Set(["david:first-game"]); // announced weeks ago
    const { awards } = pickBadgeAwards({ replay: replayBadges(ms), matchId: "now", announced, bootstrap: false, eligibleUserIds: ALL });
    const got = awards.map((a) => `${a.userId}:${a.badgeKey}`).sort();
    expect(got).toEqual(["david:first-mom", "david:ten-games", "sam:first-game"].sort());
  });

  it("announces a badge only ONCE per player per club, ever", () => {
    const ms = [match({ id: "w1", played: ["sam"] }), match({ id: "w2", played: ["sam"] })];
    const r = replayBadges(ms);
    const first = pickBadgeAwards({ replay: r, matchId: "w1", announced: new Set(), bootstrap: false, eligibleUserIds: ALL });
    expect(first.awards.map((a) => a.badgeKey)).toEqual(["first-game"]);
    const announced = new Set(first.awards.map((a) => `${a.userId}:${a.badgeKey}`));
    const second = pickBadgeAwards({ replay: r, matchId: "w2", announced, bootstrap: false, eligibleUserIds: ALL });
    expect(second.awards).toEqual([]);
  });

  it("never announces Iron Man or Above the Curve, even when earned", () => {
    // Played every one of 3 matches (Iron Man) with a rating above the field.
    const ms = [
      match({ played: ["ali", "jo"], ratings: [{ playerId: "ali", score: 8 }, { playerId: "jo", score: 5 }] }),
      match({ played: ["ali", "jo"], ratings: [{ playerId: "ali", score: 8 }, { playerId: "jo", score: 5 }] }),
      match({ id: "now", played: ["ali", "jo"], ratings: [{ playerId: "ali", score: 8 }, { playerId: "jo", score: 5 }] }),
    ];
    const { awards } = pickBadgeAwards({ replay: replayBadges(ms), matchId: "now", announced: new Set(["ali:first-game", "jo:first-game"]), bootstrap: false, eligibleUserIds: ALL });
    for (const a of awards) expect(["ironman", "above-field"]).not.toContain(a.badgeKey);
  });

  it("a MoM decided after last week's post rolls into this week's post (earned earlier, not yet announced)", () => {
    // Ali's MoM is for last week's match; it was only decided after that
    // week's post went out, so it was never announced. It goes out now.
    const ms = [match({ id: "last", played: ["ali"], momWinners: ["ali"] }), match({ id: "now", played: ["ali"] })];
    const { awards } = pickBadgeAwards({ replay: replayBadges(ms), matchId: "now", announced: new Set(["ali:first-game"]), bootstrap: false, eligibleUserIds: ALL });
    expect(awards).toEqual([{ userId: "ali", badgeKey: "first-mom", matchId: "last" }]);
  });

  it("skips players no longer in the club", () => {
    const ms = [match({ id: "now", played: ["left"] })];
    const { awards } = pickBadgeAwards({ replay: replayBadges(ms), matchId: "now", announced: new Set(), bootstrap: false, eligibleUserIds: new Set(["ali"]) });
    expect(awards).toEqual([]);
  });

  it("nobody new: nothing to announce", () => {
    const ms = [match({ id: "w1", played: ["ali"] }), match({ id: "now", played: ["ali"] })];
    const { awards } = pickBadgeAwards({ replay: replayBadges(ms), matchId: "now", announced: new Set(["ali:first-game"]), bootstrap: false, eligibleUserIds: ALL });
    expect(awards).toEqual([]);
  });
});

// ── the no-flood guarantee ────────────────────────────────────────────

describe("first run for a club (bootstrap): no flood of old badges", () => {
  // A Sutton-shaped history: 12 weeks, Ali a Regular with 3 MoMs long ago.
  const history = [
    ...plain(12, ["ali", "david"]).map((m, i) => (i < 3 ? { ...m, momWinners: ["ali"] } : m)),
  ];
  const now = match({ id: "now", played: ["ali", "david", "sam"] });
  const r = replayBadges([...history, now]);

  it("announces only what was earned at THIS match when the club has no ledger yet", () => {
    const { awards } = pickBadgeAwards({ replay: r, matchId: "now", announced: new Set(), bootstrap: true, eligibleUserIds: ALL });
    expect(awards).toEqual([{ userId: "sam", badgeKey: "first-game", matchId: "now" }]);
  });

  it("records every badge already held as the club's baseline, so it is never announced later", () => {
    const { baseline } = pickBadgeAwards({ replay: r, matchId: "now", announced: new Set(), bootstrap: true, eligibleUserIds: ALL });
    const keys = baseline.map((b) => `${b.userId}:${b.badgeKey}`).sort();
    expect(keys).toEqual(
      ["ali:first-game", "ali:ten-games", "ali:first-mom", "ali:mom-machine", "david:first-game", "david:ten-games"].sort(),
    );
  });

  it("without bootstrap (and without the backfill) the same club WOULD flood: the guard is what stops it", () => {
    const { awards } = pickBadgeAwards({ replay: r, matchId: "now", announced: new Set(), bootstrap: false, eligibleUserIds: ALL });
    expect(awards.length).toBeGreaterThan(1);
  });

  it("after the backfill (every held badge in the ledger) a normal run announces only the new one", () => {
    const backfilled = new Set<string>();
    for (const [u, keys] of replayBadges(history).everEarned) for (const k of keys.keys()) backfilled.add(`${u}:${k}`);
    const { awards } = pickBadgeAwards({ replay: r, matchId: "now", announced: backfilled, bootstrap: false, eligibleUserIds: ALL });
    expect(awards).toEqual([{ userId: "sam", badgeKey: "first-game", matchId: "now" }]);
  });
});

// ── only FINAL results count (Kemal, 2026-10-01) ─────────────────────
//
// The stats page shows MoM and ratings as they stand. Sutton's 29 Sept
// match, two days on, had Wasim leading the vote and Najib newly "Mr
// Reliable" from a handful of ratings. Neither is final until the MoM
// result is announced, so neither may be announced to the group yet.

describe("badgeMatchFinalised", () => {
  const kickoff = new Date("2026-09-29T20:30:00Z");
  const twoDaysOn = new Date("2026-10-01T17:00:00Z");

  it("is final once the match's MoM result has been posted", () => {
    expect(badgeMatchFinalised({ id: "m", date: kickoff }, new Set(["m:mom-announcement"]), twoDaysOn)).toBe(true);
  });

  it("is provisional while the vote is still open", () => {
    expect(badgeMatchFinalised({ id: "m", date: kickoff }, new Set(), twoDaysOn)).toBe(false);
  });

  it("treats a match as final exactly when the scheduler stops trying to announce its MoM", () => {
    expect(BADGE_FINAL_AFTER_DAYS).toBe(MOM_ANNOUNCE_MAX_AGE_DAYS);
  });

  it("is final once no MoM result can ever be posted for it (past the announcement's hard stop)", () => {
    expect(badgeMatchFinalised({ id: "m", date: kickoff }, new Set(), new Date("2026-10-09T12:00:00Z"))).toBe(true);
  });
});

describe("provisional results are never announced", () => {
  const raw = (id: string, over: Partial<RawBadgeMatch> = {}): RawBadgeMatch => ({
    id,
    confirmed: over.confirmed ?? [],
    teamUserIds: over.teamUserIds ?? [],
    ratings: over.ratings ?? [],
    momVotes: over.momVotes ?? [],
  });
  const steady = (id: string, who: string) =>
    raw(id, { confirmed: [who], ratings: [{ playerId: who, score: 7 }, { playerId: who, score: 7 }] });

  // Wasim has played before; on the 29th he leads an OPEN vote.
  const history = [raw("w1", { confirmed: ["wasim"] })];
  const sept29 = raw("sept29", { confirmed: ["wasim"], momVotes: [{ playerId: "wasim" }, { playerId: "wasim" }] });
  const announced = new Set(["wasim:first-game"]);

  it("the MoM leader of an open vote is not announced", () => {
    const ms = toReplayMatches([...history, sept29], (m) => m.id !== "sept29");
    const { awards } = pickBadgeAwards({ replay: replayBadges(ms), matchId: "sept29", announced, bootstrap: false, eligibleUserIds: new Set(["wasim"]) });
    expect(awards).toEqual([]);
  });

  it("is announced in the next week's post once the MoM result is final", () => {
    const oct6 = raw("oct6", { confirmed: ["wasim"] });
    const ms = toReplayMatches([...history, sept29, oct6], (m) => m.id !== "oct6");
    const { awards } = pickBadgeAwards({ replay: replayBadges(ms), matchId: "oct6", announced, bootstrap: false, eligibleUserIds: new Set(["wasim"]) });
    expect(awards).toEqual([{ userId: "wasim", badgeKey: "first-mom", matchId: "sept29" }]);
  });

  it("Mr Reliable earned only through a match's partial ratings is not announced", () => {
    // Three final, steady games, then a fourth still open: the stats page
    // already shows him reliable (4 rated games), the announcement must not.
    const ms = [steady("a", "najib"), steady("b", "najib"), steady("c", "najib"), steady("open", "najib")];
    const live = replayBadges(toReplayMatches(ms, () => true));
    expect(live.held.get("najib")?.has("reliable")).toBe(true); // what the stats page sees
    const final = replayBadges(toReplayMatches(ms, (m) => m.id !== "open"));
    const { awards } = pickBadgeAwards({ replay: final, matchId: "open", announced: new Set(["najib:first-game"]), bootstrap: false, eligibleUserIds: new Set(["najib"]) });
    expect(awards).toEqual([]);
  });

  it("attendance badges from the open match still go out (playing is not provisional)", () => {
    const ms = toReplayMatches([raw("open", { confirmed: ["sam"], momVotes: [{ playerId: "sam" }] })], () => false);
    const { awards } = pickBadgeAwards({ replay: replayBadges(ms), matchId: "open", announced: new Set(), bootstrap: false, eligibleUserIds: new Set(["sam"]) });
    expect(awards).toEqual([{ userId: "sam", badgeKey: "first-game", matchId: "open" }]);
  });

  it("a team-sheet appearance counts as playing, like the stats page", () => {
    const ms = toReplayMatches([raw("m", { teamUserIds: ["jo"] })], () => false);
    expect(replayBadges(ms).held.get("jo")?.has("first-game")).toBe(true);
  });
});

// ── the launch backfill, with a cut-off ─────────────────────────────

describe("selectBackfillRows", () => {
  // Sutton-shaped: Burak and Mojib share a FIRST MoM on 22 Sept (Elnur,
  // the third co-winner, had his first on 8 Sept); on 29 Sept Hamzah
  // plays his first game and Mojib his tenth.
  const day = (d: string) => new Date(`${d}T20:30:00Z`);
  const dates = new Map<string, Date>([
    ["sept8", day("2026-09-08")],
    ["sept15", day("2026-09-15")],
    ["sept22", day("2026-09-22")],
    ["sept29", day("2026-09-29")],
  ]);
  const ms: ReplayMatch[] = [
    // Six August games for Mojib, so 29 Sept is his tenth.
    ...Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, played: ["mojib"], ratings: [], momWinners: [] })),
    { id: "sept8", played: ["elnur", "mojib", "burak"], ratings: [], momWinners: ["elnur"] },
    { id: "sept15", played: ["mojib", "burak"], ratings: [], momWinners: [] },
    { id: "sept22", played: ["elnur", "mojib", "burak"], ratings: [], momWinners: ["elnur", "mojib", "burak"] },
    { id: "sept29", played: ["mojib", "hamzah"], ratings: [], momWinners: [] },
  ];
  for (let i = 0; i < 6; i++) dates.set(`x${i}`, day(`2026-08-${String(10 + i).padStart(2, "0")}`));
  const replay = replayBadges(ms);

  it("without a cut-off, records everything already earned", () => {
    const rows = selectBackfillRows({ replay, matchDateById: dates, from: null, announced: new Set() });
    const keys = rows.map((r) => `${r.userId}:${r.badgeKey}`);
    expect(keys).toContain("hamzah:first-game");
    expect(keys).toContain("mojib:first-mom");
  });

  it("with --from 2026-09-22, leaves the 22 and 29 Sept badges for the first post", () => {
    const from = new Date("2026-09-21T23:00:00Z"); // 00:00 London, 22 Sept
    const rows = selectBackfillRows({ replay, matchDateById: dates, from, announced: new Set() });
    const keys = new Set(rows.map((r) => `${r.userId}:${r.badgeKey}`));
    expect(keys.has("elnur:first-mom")).toBe(true); // 8 Sept: before the cut-off
    expect(keys.has("burak:first-game")).toBe(true);
    expect(keys.has("mojib:first-mom")).toBe(false);
    expect(keys.has("burak:first-mom")).toBe(false);
    expect(keys.has("hamzah:first-game")).toBe(false);
    expect(keys.has("mojib:ten-games")).toBe(false);

    // The first post then carries exactly those, Elnur not among them.
    const { awards } = pickBadgeAwards({
      replay,
      matchId: "sept29",
      announced: new Set(rows.map((r) => `${r.userId}:${r.badgeKey}`)),
      bootstrap: false,
      eligibleUserIds: new Set(["elnur", "mojib", "burak", "hamzah"]),
    });
    expect(awards.map((a) => `${a.userId}:${a.badgeKey}@${a.matchId}`).sort()).toEqual(
      ["burak:first-mom@sept22", "hamzah:first-game@sept29", "mojib:first-mom@sept22", "mojib:ten-games@sept29"].sort(),
    );
  });

  it("never re-records a row already in the ledger (idempotent re-run)", () => {
    const rows = selectBackfillRows({ replay, matchDateById: dates, from: null, announced: new Set(["elnur:first-mom"]) });
    expect(rows.map((r) => `${r.userId}:${r.badgeKey}`)).not.toContain("elnur:first-mom");
  });
});

// ── when ──────────────────────────────────────────────────────────────

describe("badgesPostDue: 18:00 London two days after the match, with a retry window", () => {
  // Tuesday 29 Sept 2026, 21:30 London (BST, UTC+1).
  const tue = new Date("2026-09-29T20:30:00Z");

  it("is 18:00 London on the Thursday", () => {
    expect(badgesPostAt(tue).toISOString()).toBe("2026-10-01T17:00:00.000Z");
  });

  it("not before Thursday 18:00", () => {
    expect(badgesPostDue(new Date("2026-10-01T16:59:00Z"), tue)).toBe(false);
  });

  it("due Thursday 18:00 to 20:59", () => {
    expect(badgesPostDue(new Date("2026-10-01T17:00:00Z"), tue)).toBe(true);
    expect(badgesPostDue(new Date("2026-10-01T19:59:00Z"), tue)).toBe(true);
  });

  it("quiet from 21:00, and retried the next evening after an outage", () => {
    expect(badgesPostDue(new Date("2026-10-01T20:00:00Z"), tue)).toBe(false);
    expect(badgesPostDue(new Date("2026-10-02T17:30:00Z"), tue)).toBe(true);
  });

  it("gives up after the retry days", () => {
    const end = new Date(badgesPostAt(tue).getTime() + BADGES_POST_RETRY_DAYS * 86_400_000);
    // The last evening of the window, 19:00 London.
    expect(badgesPostDue(new Date(end.getTime() - 86_400_000 + 3_600_000), tue)).toBe(true);
    expect(badgesPostDue(end, tue)).toBe(false);
    expect(badgesPostDue(new Date(end.getTime() + 3_600_000), tue)).toBe(false);
  });

  it("the whole window ends while the scheduler still loads the match (lookback invariant)", () => {
    // Worst case: a kickoff just after midnight London, so two calendar
    // days later is as far from kickoff as it gets.
    const earlyKickoff = new Date("2026-09-28T23:05:00Z"); // 00:05 London, Tue
    const lastDueMs = badgesPostAt(earlyKickoff).getTime() + BADGES_POST_RETRY_DAYS * 86_400_000;
    expect((lastDueMs - earlyKickoff.getTime()) / 86_400_000).toBeLessThan(POST_MATCH_LOOKBACK_DAYS);
  });

  it("keys the post per match", () => {
    expect(badgesPostKey("abc")).toBe("abc:badges");
  });
});

// ── the words ─────────────────────────────────────────────────────────

describe("buildBadgeAnnouncementPost", () => {
  it("no entries: no post", () => {
    expect(buildBadgeAnnouncementPost([], "en")).toBeNull();
  });

  it("English: one line per badge, players who earned the same badge share it, fixed order", () => {
    const text = buildBadgeAnnouncementPost(
      [
        { name: "Najib", keys: ["reliable"] },
        { name: "Mojib", keys: ["ten-games"] },
        { name: "Hamzah", keys: ["first-game"] },
        { name: "Wasim", keys: ["ten-games"] },
        { name: "Ibrahim Sahin", keys: ["ten-games"] },
      ],
      "en",
    );
    expect(text).toBe(
      "🏅 *New badges this week*\n\n" +
        "👟 *On the board*: welcome *Hamzah*, first game for the club! 🎉\n" +
        "🔟 *Regular*: *Ibrahim Sahin*, *Mojib* and *Wasim* have now played 10 games 💪\n" +
        "🧱 *Mr Reliable*: *Najib*, strong ratings week after week, you can count on them 🔒\n\n" +
        "Well played all! 👏\n📊 See your own stats and badges any time: tap the stats link in my rating DM after each match.",
    );
  });

  it("English: every badge line, singular", () => {
    const text = buildBadgeAnnouncementPost(
      [
        { name: "Ali", keys: ["reliable", "ten-games", "masterclass", "mom-machine", "first-mom", "first-game"] },
      ],
      "en",
    )!;
    expect(text.split("\n").slice(2, 8)).toEqual([
      "👟 *On the board*: welcome *Ali*, first game for the club! 🎉",
      "🏆 *Man of the Match*: *Ali* won it for the first time ⭐",
      "👑 *MoM Machine*: *Ali* has now been Man of the Match 3 times 🔥",
      "🌟 *Masterclass*: *Ali* averaged 9+ in a game, top class 🎯",
      "🔟 *Regular*: *Ali* has now played 10 games 💪",
      "🧱 *Mr Reliable*: *Ali*, strong ratings week after week, you can count on them 🔒",
    ]);
  });

  it("English: plural welcome", () => {
    expect(buildBadgeAnnouncementPost([{ name: "Sam", keys: ["first-game"] }, { name: "Jo", keys: ["first-game"] }], "en")).toBe(
      "🏅 *New badges this week*\n\n" +
        "👟 *On the board*: welcome *Jo* and *Sam*, first games for the club! 🎉\n\n" +
        "Well played all! 👏\n📊 See your own stats and badges any time: tap the stats link in my rating DM after each match.",
    );
  });

  it("Turkish: same structure, badge names stay English as on the stats page", () => {
    const text = buildBadgeAnnouncementPost(
      [
        { name: "Najib", keys: ["reliable"] },
        { name: "Mojib", keys: ["ten-games"] },
        { name: "Hamzah", keys: ["first-game"] },
        { name: "Wasim", keys: ["ten-games"] },
      ],
      "tr",
    );
    expect(text).toBe(
      "🏅 *Bu haftanın yeni rozetleri*\n\n" +
        "👟 *On the board*: aramıza hoş geldin *Hamzah*, kulüpteki ilk maçın! 🎉\n" +
        "🔟 *Regular*: *Mojib* ve *Wasim* artık 10 maç oynadı 💪\n" +
        "🧱 *Mr Reliable*: *Najib*, her hafta yüksek puan, ona güvenebilirsiniz 🔒\n\n" +
        "Hepinizin eline sağlık! 👏\n📊 Kendi istatistiklerini ve rozetlerini istediğin zaman görebilirsin: her maçtan sonra gönderdiğim puanlama mesajındaki istatistik linkine dokun.",
    );
  });

  it("a first MoM shared by two first-timers says so (Burak and Mojib, 22 Sept); a non-first co-winner is not named", () => {
    // Elnur also shared it, but it was his second: he is not in the entries.
    const text = buildBadgeAnnouncementPost(
      [
        { name: "Mojib", keys: ["first-mom"], firstMomMatchId: "sept22" },
        { name: "Burak Yildiz", keys: ["first-mom"], firstMomMatchId: "sept22" },
      ],
      "en",
    )!;
    expect(text.split("\n")[2]).toBe("🏆 *Man of the Match*: *Burak Yildiz* and *Mojib* shared it, a first for both ⭐");
    const tr = buildBadgeAnnouncementPost(
      [
        { name: "Mojib", keys: ["first-mom"], firstMomMatchId: "sept22" },
        { name: "Burak Yildiz", keys: ["first-mom"], firstMomMatchId: "sept22" },
      ],
      "tr",
    )!;
    expect(tr.split("\n")[2]).toBe("🏆 *Man of the Match*: *Burak Yildiz* ve *Mojib* ödülü paylaştı, ikisi için de bir ilk ⭐");
  });

  it("first MoMs from different matches in one post: they won it for the first time", () => {
    const text = buildBadgeAnnouncementPost(
      [
        { name: "Ali", keys: ["first-mom"], firstMomMatchId: "a" },
        { name: "Jo", keys: ["first-mom"], firstMomMatchId: "b" },
      ],
      "en",
    )!;
    expect(text.split("\n")[2]).toBe("🏆 *Man of the Match*: *Ali* and *Jo* won it for the first time ⭐");
  });

  it("a shared pair and a solo first-timer on the same line", () => {
    const entries = [
      { name: "Mojib", keys: ["first-mom"] as const, firstMomMatchId: "sept22" },
      { name: "Burak Yildiz", keys: ["first-mom"] as const, firstMomMatchId: "sept22" },
      { name: "Sam", keys: ["first-mom"] as const, firstMomMatchId: "sept15" },
    ];
    expect(buildBadgeAnnouncementPost(entries, "en")!.split("\n")[2]).toBe(
      "🏆 *Man of the Match*: *Burak Yildiz* and *Mojib* shared it, a first for both; *Sam* won it for the first time ⭐",
    );
    expect(buildBadgeAnnouncementPost(entries, "tr")!.split("\n")[2]).toBe(
      "🏆 *Man of the Match*: *Burak Yildiz* ve *Mojib* ödülü paylaştı, ikisi için de bir ilk; *Sam* ilk kez maçın adamı seçildi ⭐",
    );
  });

  it("points players to their own stats without putting a link in the group", () => {
    for (const lang of ["en", "tr"] as const) {
      const text = buildBadgeAnnouncementPost([{ name: "Sam", keys: ["first-game"] }], lang)!;
      expect(text).toContain("📊");
      expect(text).not.toMatch(/https?:\/\//);
    }
  });

  it("no em or en dashes in either language, singular or plural", () => {
    for (const lang of ["en", "tr"] as const) {
      for (const names of [["A"], ["A", "B"], ["A", "B", "C"]]) {
        const text = buildBadgeAnnouncementPost(
          names.map((name) => ({ name, keys: [...ANNOUNCEABLE_BADGE_KEYS], firstMomMatchId: "same" })),
          lang,
        )!;
        expect(text).not.toMatch(/[–—]/);
      }
    }
  });
});
