/**
 * WHAT THE GROUP WAS TOLD ABOUT MAN OF THE MATCH (Kemal, 2026-11-16).
 *
 * The announcement's result is STORED when the post is claimed, so "who was
 * the last Man of the Match?" can tell it exactly as the group saw it. These
 * pin the record's shape and reader, and the one "next fixture" rule the
 * scheduler's stop and the answer share.
 */
import { describe, expect, it, vi } from "vitest";

// The backstop constant lives in the scheduler, which imports Prisma.
vi.mock("@/lib/db", () => ({ db: {} }));
import {
  MOM_ANNOUNCE_STOP_DAYS,
  MOM_BACKSTOP_AFTER_DAYS,
  isMomAnnouncementClaimKey,
  momAnnouncementStopped,
  momPickWillBePosted,
  nextMomCivilTick,
  isLaterFixtureOf,
  momAnnouncedResultOf,
  nextFixtureKickoff,
  readMomAnnouncedResult,
} from "../mom-announce-rules";
import { MOM_ANNOUNCE_MAX_AGE_DAYS, MOM_BACKSTOP_DAYS } from "../bot-scheduler";

const DAY = 24 * 60 * 60 * 1000;
const FIX = { orgId: "org-1", venue: "Goals", dayOfWeek: 2 };
const KICKOFF = new Date("2026-11-03T20:00:00Z");

function sib(o: Partial<{ id: string; date: Date; status: string; activityId: string; activity: typeof FIX }>) {
  return { id: "m-next", date: new Date(KICKOFF.getTime() + 7 * DAY), status: "UPCOMING", activityId: "act-1", activity: FIX, ...o };
}
const M = { id: "m-1", date: KICKOFF, status: "COMPLETED", activityId: "act-1", activity: FIX };

describe("readMomAnnouncedResult: the stored record, read back defensively", () => {
  it("a vote: every player with their votes, and the announced winners, as stored", () => {
    const tally = [{ userId: "u-1", name: "Mojib", votes: 5 }, { userId: "u-2", name: "Habib", votes: 3 }];
    expect(readMomAnnouncedResult({ v: 1, kind: "vote", tally, winners: ["u-1"] })).toEqual({ v: 1, kind: "vote", tally, winners: ["u-1"] });
  });

  it("the stored winners are kept as stored, never re-derived from the tally (a merge sums counts)", () => {
    const tally = [{ userId: "u-keep", name: "Pete", votes: 4 }, { userId: "u-x", name: "Alex", votes: 3 }];
    expect(readMomAnnouncedResult({ v: 1, kind: "vote", tally, winners: ["u-x"], merged: true })).toEqual({ v: 1, kind: "vote", tally, winners: ["u-x"], merged: true });
  });

  it("a record from before winners were stored reads them off its tally, as the post was built", () => {
    const tally = [{ userId: "u-1", name: "Mojib", votes: 2 }, { userId: "u-2", name: "Habib", votes: 2 }, { userId: "u-3", name: "Sait", votes: 1 }];
    expect(readMomAnnouncedResult({ v: 1, kind: "vote", tally })).toEqual({ v: 1, kind: "vote", tally, winners: ["u-1", "u-2"] });
  });

  it("a pick: one name, no votes", () => {
    expect(readMomAnnouncedResult({ v: 1, kind: "pick", winner: { userId: "u-1", name: "Akram" } })).toEqual({
      v: 1,
      kind: "pick",
      winner: { userId: "u-1", name: "Akram" },
    });
  });

  it("anything malformed is no record at all, never a guess", () => {
    for (const bad of [
      null,
      undefined,
      "x",
      {},
      { v: 1, kind: "vote", tally: [] },
      { v: 1, kind: "vote", tally: [{ userId: "u-1", name: "Mojib", votes: 0 }] },
      { v: 1, kind: "vote", tally: [{ userId: "u-1", name: "Mojib", votes: "5" }] },
      { v: 1, kind: "vote", tally: [{ name: "Mojib", votes: 5 }] },
      { v: 1, kind: "vote", tally: [{ userId: "u-1", name: "Mojib", votes: 5 }], winners: ["u-9"] },
      { v: 1, kind: "vote", tally: [{ userId: "u-1", name: "Mojib", votes: 5 }], winners: [] },
      { v: 1, kind: "pick", winner: { userId: "u-1" } },
      { v: 2, kind: "pick", winner: { userId: "u-1", name: "Akram" } },
      { v: 1, kind: "other" },
    ]) {
      expect(readMomAnnouncedResult(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("an instruction's record is read the same way; one without it has none", () => {
    expect(momAnnouncedResultOf({ key: "k", kind: "group-message", momResult: { v: 1, kind: "pick", winner: { userId: "u", name: "A" } } })).toEqual({
      v: 1,
      kind: "pick",
      winner: { userId: "u", name: "A" },
    });
    expect(momAnnouncedResultOf({ key: "k", kind: "group-message" })).toBeNull();
  });
});

describe("isLaterFixtureOf: the scheduler's 'next fixture' for the Man of the Match stop", () => {
  it("the same activity, a day or more later, not cancelled", () => {
    expect(isLaterFixtureOf(sib({}), M)).toBe(true);
    expect(isLaterFixtureOf(sib({ date: new Date(KICKOFF.getTime() + 3 * DAY) }), M)).toBe(true);
  });

  it("a cancelled next game is no next fixture", () => {
    expect(isLaterFixtureOf(sib({ status: "CANCELLED" }), M)).toBe(false);
  });

  it("a co-timed ghost (under a day later) and the match itself never count", () => {
    expect(isLaterFixtureOf(sib({ date: new Date(KICKOFF.getTime() + 2 * 60 * 60 * 1000) }), M)).toBe(false);
    expect(isLaterFixtureOf(M, M)).toBe(false);
  });

  it("another weekly fixture of the club (two games a week) is not this one's next fixture", () => {
    expect(isLaterFixtureOf(sib({ activityId: "act-thu", activity: { ...FIX, dayOfWeek: 4 } }), M)).toBe(false);
  });

  it("a format-switched successor (another activity, same venue and weekday) is", () => {
    expect(isLaterFixtureOf(sib({ activityId: "act-7aside" }), M)).toBe(true);
  });
});

describe("nextFixtureKickoff: the earliest later fixture, played or to come", () => {
  it("the earliest one; cancelled ones skipped; none is null", () => {
    const three = sib({ id: "m-3", date: new Date(KICKOFF.getTime() + 3 * DAY), status: "CANCELLED" });
    const seven = sib({ id: "m-7" });
    const ten = sib({ id: "m-10", date: new Date(KICKOFF.getTime() + 10 * DAY) });
    expect(nextFixtureKickoff(M, [ten, three, seven])?.getTime()).toBe(seven.date.getTime());
    expect(nextFixtureKickoff(M, [three])).toBeNull();
    expect(nextFixtureKickoff(M, [])).toBeNull();
  });
});

describe("the backstop's day, pinned to the scheduler's", () => {
  it("is the same number as MOM_BACKSTOP_DAYS", () => {
    expect(MOM_BACKSTOP_AFTER_DAYS).toBe(MOM_BACKSTOP_DAYS);
  });
});

describe("isMomAnnouncementClaimKey: the post's own claim row, never the outbound text log", () => {
  it("<matchId>:mom-announcement is the claim", () => {
    expect(isMomAnnouncementClaimKey("cmh0abc123:mom-announcement")).toBe(true);
  });

  it("the outbound text log's rows (txtlog:<org>:<hash>:<key>) end the same way and are not", () => {
    expect(isMomAnnouncementClaimKey("txtlog:org-1:9f2c:cmh0abc123:mom-announcement")).toBe(false);
  });

  it("nor anything else", () => {
    expect(isMomAnnouncementClaimKey("cmh0abc123:mom-poll")).toBe(false);
    expect(isMomAnnouncementClaimKey(":mom-announcement")).toBe(false);
  });
});

/**
 * THE SCHEDULER'S OWN RULE FOR WHETHER A RESULT CAN STILL BE POSTED (round 5
 * of the review), shared by bot-scheduler.ts 6e and the answer: the stops
 * (too old, or the next fixture has kicked off), the 09:00 to 21:00 London
 * window, and from those, "will this organisers' pick be posted?".
 */
describe("the scheduler's rule, shared", () => {
  const H = 60 * 60 * 1000;
  it("the stops: past 9 days, or the next fixture has kicked off", () => {
    expect(MOM_ANNOUNCE_STOP_DAYS).toBe(MOM_ANNOUNCE_MAX_AGE_DAYS);
    expect(momAnnouncementStopped(KICKOFF, null, new Date(KICKOFF.getTime() + 9 * DAY))).toBe(false);
    expect(momAnnouncementStopped(KICKOFF, null, new Date(KICKOFF.getTime() + 9 * DAY + 1))).toBe(true);
    const next = new Date(KICKOFF.getTime() + 3 * DAY);
    expect(momAnnouncementStopped(KICKOFF, next, new Date(next.getTime() - 1))).toBe(false);
    expect(momAnnouncementStopped(KICKOFF, next, next)).toBe(true);
  });

  it("the next 09:00 to 21:00 London tick: now inside it; else the next 09:00 (GMT and BST)", () => {
    const inside = new Date("2026-11-10T15:30:00Z");
    expect(nextMomCivilTick(inside).toISOString()).toBe(inside.toISOString());
    expect(nextMomCivilTick(new Date("2026-11-10T04:07:00Z")).toISOString()).toBe("2026-11-10T09:00:00.000Z");
    expect(nextMomCivilTick(new Date("2026-11-10T21:30:00Z")).toISOString()).toBe("2026-11-11T09:00:00.000Z");
    // BST: 09:00 London is 08:00 UTC.
    expect(nextMomCivilTick(new Date("2026-07-01T03:00:00Z")).toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(nextMomCivilTick(new Date("2026-07-01T20:30:00Z")).toISOString()).toBe("2026-07-02T08:00:00.000Z");
  });

  it("a pick will be posted: one player, the scheduler able to post, and no stop by its next tick", () => {
    const base = { kickoff: KICKOFF, nextFixtureAt: null, announceable: true, pickers: 1 };
    expect(momPickWillBePosted({ ...base, now: new Date(KICKOFF.getTime() + 2 * H) })).toBe(true);
    expect(momPickWillBePosted({ ...base, announceable: false, now: new Date(KICKOFF.getTime() + 2 * H) })).toBe(false);
    expect(momPickWillBePosted({ ...base, pickers: 2, now: new Date(KICKOFF.getTime() + 2 * H) })).toBe(false);
  });
});
