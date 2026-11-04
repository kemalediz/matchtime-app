/**
 * THE CLUB'S NEXT MATCH, ONE RULE (club summary, slice B4, decision K5).
 *
 * `next-match.ts` is the rule for a door with no club summary in hand: the
 * candidates (every live match of the club, any date, never historical),
 * the registration selector over them at the caller's clock, and "today" as
 * the London day. The summary's `nextMatchId` is the same rule over the
 * same matches (`club-summary/__tests__/derive.test.ts`).
 */
import { describe, it, expect, vi } from "vitest";
import { findNextMatch, findNextMatchOrUnfinished, findNextMatchPerClub, inFlightWhere, nextMatchWhere, upcomingMatchesWhere } from "@/lib/next-match";

const bst = (day: string, time: string) => new Date(`${day}T${time}:00.000+01:00`);
const row = (id: string, date: Date, status = "UPCOMING", orgId = "club") => ({ id, date, status, activity: { orgId } });

describe("nextMatchWhere: the candidates", () => {
  it("every live match of the club, any date, never a historical one", () => {
    expect(nextMatchWhere("club")).toEqual({
      activity: { orgId: "club" },
      isHistorical: false,
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
    });
  });
});

describe("findNextMatch", () => {
  it("hands the loader the candidates' where and picks with the registration selector at the caller's clock", async () => {
    const load = vi.fn(async () => [row("next-week", bst("2026-07-21", "21:30")), row("tonight", bst("2026-07-14", "21:30"))]);
    const picked = await findNextMatch("club", bst("2026-07-14", "12:00"), load);
    expect(load).toHaveBeenCalledWith(nextMatchWhere("club"));
    expect(picked?.id).toBe("tonight");
  });

  it("a stuck match from before today blocks: null, never next week's match (the selector's block)", async () => {
    const load = async () => [row("stuck", bst("2026-07-07", "21:30")), row("next-week", bst("2026-07-21", "21:30"))];
    expect(await findNextMatch("club", bst("2026-07-14", "12:00"), load)).toBeNull();
  });

  it("'today' is the London day: at 00:30 BST last night's live match blocks", async () => {
    const load = async () => [row("last-night", bst("2026-07-14", "21:30")), row("next-week", bst("2026-07-21", "21:30"))];
    expect(await findNextMatch("club", bst("2026-07-15", "00:30"), load)).toBeNull();
  });

  it("keeps the loader's own row shape", async () => {
    const load = async () => [{ ...row("tonight", bst("2026-07-14", "21:30")), maxPlayers: 14 }];
    expect((await findNextMatch("club", bst("2026-07-14", "12:00"), load))?.maxPlayers).toBe(14);
  });
});

describe("findNextMatchOrUnfinished: why there is none", () => {
  it("with a next match: it, and no unfinished game", async () => {
    const load = async () => [row("tonight", bst("2026-07-14", "21:30"))];
    const r = await findNextMatchOrUnfinished("club", bst("2026-07-14", "12:00"), load);
    expect([r.next?.id, r.unfinished]).toEqual(["tonight", null]);
  });

  it("blocked: no next match, and the latest live game dated before today, from the same read", async () => {
    const load = vi.fn(async () => [
      row("older-stuck", bst("2026-06-30", "21:30")),
      row("stuck", bst("2026-07-07", "21:30")),
      row("next-week", bst("2026-07-21", "21:30")),
    ]);
    const r = await findNextMatchOrUnfinished("club", bst("2026-07-14", "12:00"), load);
    expect(load).toHaveBeenCalledTimes(1);
    expect([r.next, r.unfinished?.id]).toEqual([null, "stuck"]);
  });

  it("no live match at all: neither", async () => {
    expect(await findNextMatchOrUnfinished("club", new Date(), async () => [])).toEqual({ next: null, unfinished: null });
  });
});

describe("findNextMatchPerClub", () => {
  it("one read for several clubs, the rule applied per club", async () => {
    const load = vi.fn(async () => [
      row("a-stuck", bst("2026-07-07", "21:30"), "UPCOMING", "a"),
      row("a-next", bst("2026-07-21", "21:30"), "UPCOMING", "a"),
      row("b-tonight", bst("2026-07-14", "20:00"), "UPCOMING", "b"),
      row("b-next", bst("2026-07-21", "20:00"), "UPCOMING", "b"),
    ]);
    const picks = await findNextMatchPerClub(["a", "b"], bst("2026-07-14", "12:00"), load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith({ ...nextMatchWhere("club"), activity: { orgId: { in: ["a", "b"] } } });
    expect(picks.has("a")).toBe(false);
    expect(picks.get("b")?.id).toBe("b-tonight");
  });

  it("no clubs, no read", async () => {
    const load = vi.fn(async () => []);
    expect((await findNextMatchPerClub([], new Date(), load)).size).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("upcomingMatchesWhere: the match list's Upcoming tab", () => {
  it("the selector's candidates dated on the London day of `now` or later: today's game stays listed after kickoff, a cancelled one is not listed", () => {
    // 00:30 BST on 15 Jul: the London day began at 23:00 UTC on 14 Jul.
    expect(upcomingMatchesWhere("club", bst("2026-07-15", "00:30"))).toEqual({
      ...nextMatchWhere("club"),
      date: { gte: new Date("2026-07-14T23:00:00.000Z") },
    });
  });
});

describe("inFlightWhere: the selector's block as a query", () => {
  it("a live match of the club dated before the London day of `now`, other than this one", () => {
    // 00:30 BST on 15 Jul: the London day began at 23:00 UTC on 14 Jul.
    expect(inFlightWhere("club", bst("2026-07-15", "00:30"), "m1")).toEqual({
      ...nextMatchWhere("club"),
      date: { lt: new Date("2026-07-14T23:00:00.000Z") },
      id: { not: "m1" },
    });
  });
});
