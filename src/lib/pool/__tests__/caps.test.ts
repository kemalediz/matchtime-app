/**
 * The pool's caps (slice L4): per player (2 a rolling week, 1 a London day,
 * the 14-day cooldown after a decline), per club (one open round a match,
 * 3 rounds a rolling week), platform-wide (20 a rolling hour, 100 a London
 * day) and the 3-ignored-in-a-row pause. Every number comes from rules.ts or
 * POOL_PLATFORM_CAPS; the tests read them, never restate them.
 */
import { describe, expect, it } from "vitest";
import { londonDateTimeToUtc } from "../../london-time";
import {
  clubRoundRefusal,
  ignoredStreak,
  londonDayKey,
  pausesForIgnored,
  platformRoom,
  playerCapRefusal,
  POOL_PLATFORM_CAPS,
  type OfferLedgerEntry,
} from "../caps";
import { POOL_CAPS } from "../rules";
import type { PoolOfferOutcome } from "../vocab";

const at = (date: string, time: string) => londonDateTimeToUtc(date, time);
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const entry = (when: Date, o: Partial<OfferLedgerEntry> = {}): OfferLedgerEntry => ({ orgId: "other", at: when, outcome: null, resolvedAt: null, ...o });

describe("the platform caps", () => {
  it("are 20 a rolling hour and 100 a London day (plan 4.3)", () => {
    expect(POOL_PLATFORM_CAPS).toEqual({ perHour: 20, perLondonDay: 100 });
    expect(Object.isFrozen(POOL_PLATFORM_CAPS)).toBe(true);
  });
});

describe("londonDayKey", () => {
  const table: Array<[string, Date, string]> = [
    ["midnight London in winter is the new day", new Date("2026-11-03T00:00:00Z"), "2026-11-03"],
    ["23:59 London in winter is still the old day", new Date("2026-11-02T23:59:00Z"), "2026-11-02"],
    ["midnight London in summer is 23:00Z the evening before", new Date("2026-07-13T23:00:00Z"), "2026-07-14"],
    ["22:59Z in summer is 23:59 London, the old day", new Date("2026-07-13T22:59:00Z"), "2026-07-13"],
  ];
  it.each(table)("%s", (_n, d, want) => expect(londonDayKey(d)).toBe(want));
});

describe("playerCapRefusal: 1 a London day", () => {
  const t = at("2026-10-27", "10:00");
  it("an offer earlier the same London day refuses", () => {
    expect(playerCapRefusal([entry(at("2026-10-27", "08:30"))], "club", t)).toBe("day-cap");
  });
  it("an offer at 23:59 the day before does not", () => {
    expect(playerCapRefusal([entry(at("2026-10-26", "23:59"))], "club", t)).toBeNull();
  });
  it("an offer already queued for later the same day refuses (deferred offers count at their send time)", () => {
    expect(playerCapRefusal([entry(at("2026-10-27", "18:00"))], "club", t)).toBe("day-cap");
  });
  it("summer: 23:30Z is 00:30 London the next day, so a 22:30Z offer the same UTC date does not clash with it", () => {
    const a = new Date("2026-07-14T22:30:00Z"); // 23:30 BST on the 14th
    const b = new Date("2026-07-14T23:30:00Z"); // 00:30 BST on the 15th
    expect(playerCapRefusal([entry(a)], "club", b)).toBeNull();
  });
  it("the 25-hour autumn day: 00:30 BST and 23:30 GMT are the same London day", () => {
    const morning = new Date("2026-10-24T23:30:00Z"); // 00:30 BST, Sunday 25th
    const night = new Date("2026-10-25T23:30:00Z"); // 23:30 GMT, Sunday 25th
    expect(londonDayKey(morning)).toBe("2026-10-25");
    expect(playerCapRefusal([entry(morning)], "club", night)).toBe("day-cap");
  });
  it("a cancelled offer never reached him and does not count", () => {
    expect(playerCapRefusal([entry(at("2026-10-27", "08:30"), { outcome: "cancelled" })], "club", t)).toBeNull();
  });
});

describe("playerCapRefusal: 2 in any rolling 7 days", () => {
  const t = at("2026-10-27", "12:00");
  it("one earlier this week is fine, two refuse", () => {
    expect(playerCapRefusal([entry(new Date(t.getTime() - 3 * DAY))], "club", t)).toBeNull();
    expect(playerCapRefusal([entry(new Date(t.getTime() - 3 * DAY)), entry(new Date(t.getTime() - 5 * DAY))], "club", t)).toBe("week-cap");
  });
  it("exactly 7 days ago has left the window; a minute less has not", () => {
    const two = (ms: number) => [entry(new Date(t.getTime() - 2 * DAY)), entry(new Date(t.getTime() - ms))];
    expect(playerCapRefusal(two(7 * DAY), "club", t)).toBeNull();
    expect(playerCapRefusal(two(7 * DAY - 60_000), "club", t)).toBe("week-cap");
  });
  it("rolling, not calendar: a Sunday and a Monday offer still block the Tuesday", () => {
    const sun = at("2026-10-25", "12:00");
    const mon = at("2026-10-26", "12:00");
    expect(playerCapRefusal([entry(sun), entry(mon)], "club", t)).toBe("week-cap");
  });
  it("a future queued offer counts too: every 7-day window holding the new one stays within 2", () => {
    // One 3 days ago, one queued 2 days ahead: a 7-day window holds all three.
    const ago = (d: number) => entry(new Date(t.getTime() - d * DAY));
    const ahead = (d: number) => entry(new Date(t.getTime() + d * DAY));
    expect(playerCapRefusal([ago(3), ahead(2)], "club", t)).toBe("week-cap");
    // 8 days apart: no 7-day window holds all three, each window holds at most 2.
    expect(playerCapRefusal([ago(6), ahead(2)], "club", t)).toBeNull();
    // Exactly 7 days apart is two windows, not one.
    expect(playerCapRefusal([ago(4), ahead(3)], "club", t)).toBeNull();
    expect(playerCapRefusal([ago(4), entry(new Date(t.getTime() + 3 * DAY - 60_000))], "club", t)).toBe("week-cap");
  });
  it("the number is POOL_CAPS.perPlayerPerWeek", () => {
    const n = POOL_CAPS.perPlayerPerWeek;
    const ledger = Array.from({ length: n - 1 }, (_, i) => entry(new Date(t.getTime() - (i + 1) * DAY)));
    expect(playerCapRefusal(ledger, "club", t)).toBeNull();
    ledger.push(entry(new Date(t.getTime() - n * DAY)));
    expect(playerCapRefusal(ledger, "club", t)).toBe("week-cap");
  });
});

describe("playerCapRefusal: 14 days after a decline, that club may not offer him again", () => {
  const t = at("2026-11-20", "12:00");
  const declined = (daysAgo: number, orgId = "club") =>
    entry(new Date(t.getTime() - (daysAgo + 1) * DAY), { orgId, outcome: "declined", resolvedAt: new Date(t.getTime() - daysAgo * DAY) });
  it("13 days after: refused for that club, allowed for another", () => {
    expect(playerCapRefusal([declined(13)], "club", t)).toBe("decline-cooldown");
    expect(playerCapRefusal([declined(13)], "elsewhere", t)).toBeNull();
  });
  it("exactly 14 days after: allowed", () => {
    expect(playerCapRefusal([declined(POOL_CAPS.declineCooldownDays)], "club", t)).toBeNull();
  });
  it("only a decline counts: an ignored or filled offer from that club does not start a cooldown", () => {
    for (const outcome of ["ignored", "filled", "expired", "accepted"] as PoolOfferOutcome[]) {
      const e = entry(new Date(t.getTime() - 9 * DAY), { orgId: "club", outcome, resolvedAt: new Date(t.getTime() - 8 * DAY) });
      expect(playerCapRefusal([e], "club", t)).toBeNull();
    }
  });
});

describe("ignoredStreak and the 3-in-a-row pause (decision log #8: only an offer's own expiry counts)", () => {
  const base = at("2026-10-01", "12:00").getTime();
  const seq = (outcomes: Array<PoolOfferOutcome | null>) => outcomes.map((o, i) => entry(new Date(base + i * DAY), { outcome: o }));
  const table: Array<[string, Array<PoolOfferOutcome | null>, number]> = [
    ["three ignored", ["ignored", "ignored", "ignored"], 3],
    ["an answer resets it", ["ignored", "ignored", "declined", "ignored"], 1],
    ["an accept resets it", ["ignored", "accepted", "ignored", "ignored"], 2],
    ["expired (others were quicker) is neutral: neither counts nor resets", ["ignored", "expired", "ignored", "ignored"], 3],
    ["cancelled is neutral too", ["ignored", "ignored", "cancelled", "ignored"], 3],
    ["filled means he answered", ["ignored", "ignored", "filled"], 0],
    ["an open offer (no outcome yet) is skipped", ["ignored", "ignored", "ignored", null], 3],
    ["nothing", [], 0],
  ];
  it.each(table)("%s", (_n, outcomes, want) => {
    expect(ignoredStreak(seq(outcomes))).toBe(want);
    // Order of the input never matters.
    expect(ignoredStreak([...seq(outcomes)].reverse())).toBe(want);
  });
  it("pauses at POOL_CAPS.ignoredInARowPause, not before", () => {
    const n = POOL_CAPS.ignoredInARowPause;
    expect(pausesForIgnored(seq(Array(n - 1).fill("ignored")))).toBe(false);
    expect(pausesForIgnored(seq(Array(n).fill("ignored")))).toBe(true);
  });
  it("only offers sent after he resumed count ('until they say they want more')", () => {
    const s = seq(["ignored", "ignored", "ignored", "ignored"]);
    expect(ignoredStreak(s, new Date(base + 2 * DAY))).toBe(2);
    expect(pausesForIgnored(s, new Date(base + 2 * DAY))).toBe(false);
  });
});

describe("clubRoundRefusal: one open round a match, 3 rounds a rolling week", () => {
  const t = at("2026-10-27", "12:00");
  const ask = (matchId: string, daysAgo: number, status = "closed") => ({ matchId, status, createdAt: new Date(t.getTime() - daysAgo * DAY) });
  it("an open round on the same match refuses", () => {
    expect(clubRoundRefusal([ask("m1", 0, "open")], "m1", t)).toBe("round-open");
  });
  it("a closed round on the same match does not (a second round later the same week is allowed)", () => {
    expect(clubRoundRefusal([ask("m1", 1, "filled")], "m1", t)).toBeNull();
  });
  it("three rounds this rolling week refuse the fourth; one aged out exactly 7 days does not count", () => {
    const n = POOL_CAPS.roundsPerClubPerWeek;
    const asks = Array.from({ length: n }, (_, i) => ask(`m${i + 2}`, i + 1));
    expect(clubRoundRefusal(asks, "m1", t)).toBe("club-week-cap");
    asks[asks.length - 1] = ask("mx", 7);
    expect(clubRoundRefusal(asks, "m1", t)).toBeNull();
  });
  it("cancelled rounds never reached anyone and do not count", () => {
    const asks = Array.from({ length: 3 }, (_, i) => ask(`m${i + 2}`, 1, "cancelled"));
    expect(clubRoundRefusal(asks, "m1", t)).toBeNull();
  });
});

describe("platformRoom: how many more pool DMs may go now", () => {
  const t = at("2026-10-27", "12:00");
  const sent = (n: number, spacingMs: number, from = t.getTime()) => Array.from({ length: n }, (_, i) => new Date(from - i * spacingMs));
  it("empty: the hourly cap", () => {
    expect(platformRoom([], t)).toBe(POOL_PLATFORM_CAPS.perHour);
  });
  it("19 in the last hour leaves 1; 20 leaves 0; never negative", () => {
    expect(platformRoom(sent(19, 60_000), t)).toBe(1);
    expect(platformRoom(sent(20, 60_000), t)).toBe(0);
    expect(platformRoom(sent(25, 60_000), t)).toBe(0);
  });
  it("rolling hour edge: one sent exactly an hour ago no longer counts", () => {
    const ledger = [...sent(19, 60_000), new Date(t.getTime() - HOUR)];
    expect(platformRoom(ledger, t)).toBe(1);
    const inside = [...sent(19, 60_000), new Date(t.getTime() - HOUR + 1)];
    expect(platformRoom(inside, t)).toBe(0);
  });
  it("the London day cap: 100 earlier today leaves nothing, even with the hour empty", () => {
    const morning = sent(100, 60_000, at("2026-10-27", "09:00").getTime() + 99 * 60_000);
    expect(platformRoom(morning, t)).toBe(0);
    expect(platformRoom(morning.slice(1), t)).toBe(1);
  });
  it("yesterday's sends do not touch today's day cap", () => {
    const yesterday = sent(100, 60_000, at("2026-10-26", "20:00").getTime());
    expect(platformRoom(yesterday, t)).toBe(POOL_PLATFORM_CAPS.perHour);
  });
  it("property: room + sends in the window never exceeds either cap", () => {
    for (let n = 0; n <= 130; n += 7) {
      const ledger = sent(n, 2 * 60_000);
      const room = platformRoom(ledger, t);
      const lastHour = ledger.filter((d) => d.getTime() > t.getTime() - HOUR).length;
      const today = ledger.filter((d) => londonDayKey(d) === londonDayKey(t)).length;
      expect(room).toBeGreaterThanOrEqual(0);
      expect(room + lastHour).toBeLessThanOrEqual(Math.max(lastHour, POOL_PLATFORM_CAPS.perHour));
      expect(room + today).toBeLessThanOrEqual(Math.max(today, POOL_PLATFORM_CAPS.perLondonDay));
    }
  });
});
