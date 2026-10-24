/**
 * A MEMBER TAKEN OFF A CLUB IS TAKEN OFF ITS UPCOMING MATCHES (FNF,
 * 2026-10-24).
 *
 * Prod: "Glazers" was put on the bench of FNF's Fri 30 Oct match by an HQ
 * "Glazers in", then removed on the admin players page. The removal set
 * `Membership.leftAt` and left his BENCH row. The roster (memberships with
 * `leftAt` null) no longer had him, so the HQ squad post printed
 * "Bench (1): 1. a player", and "Glazers out" could not find him.
 *
 * `takeRemovedMemberOffUpcomingMatches` is the one helper every removal
 * calls: each CONFIRMED or BENCH row on a match of THIS club that has not
 * kicked off and is not finished or cancelled goes through
 * `cancelAttendance` (so the event is written and the bench/slot rules run
 * as on any drop). Past matches are never read, other clubs' matches are
 * never read, and a member who is back (leftAt null) is left alone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  membership: { leftAt: new Date("2026-10-24T12:51:15Z") } as { leftAt: Date | null } | null,
  rows: [] as Array<{ matchId: string; status: string }>,
  findManyArgs: [] as unknown[],
  cancel: vi.fn(async (_u: string, _m: string, _e: unknown) => ({ status: "DROPPED" as const })),
}));

vi.mock("../db", () => ({
  db: {
    membership: { findUnique: async () => h.membership },
    attendance: {
      findMany: async (args: unknown) => {
        h.findManyArgs.push(args);
        return h.rows;
      },
    },
  },
}));
vi.mock("../attendance", () => ({ cancelAttendance: h.cancel }));

import { takeRemovedMemberOffUpcomingMatches, MEMBER_REMOVED_CAUSE } from "../member-removal";
import { ATTENDANCE_EVENT_CAUSES } from "../attendance-events";

const NOW = new Date("2026-10-24T12:51:15Z");
const EVENT = { cause: MEMBER_REMOVED_CAUSE, actorKind: "admin" as const, actorUserId: "admin1", sourceRef: "admin:removeProvisionalPlayer" };

beforeEach(() => {
  h.membership = { leftAt: NOW };
  h.rows = [];
  h.findManyArgs = [];
  h.cancel.mockClear();
});

describe("takeRemovedMemberOffUpcomingMatches", () => {
  it("the cause is a declared one (the event log refuses an unknown cause)", () => {
    expect(ATTENDANCE_EVENT_CAUSES).toContain(MEMBER_REMOVED_CAUSE);
  });

  it("drops his BENCH and CONFIRMED rows on the club's upcoming matches through cancelAttendance", async () => {
    h.rows = [
      { matchId: "fri-30-oct", status: "BENCH" },
      { matchId: "fri-6-nov", status: "CONFIRMED" },
    ];
    const out = await takeRemovedMemberOffUpcomingMatches({ userId: "glazers", orgId: "fnf", event: EVENT, now: NOW });
    expect(h.cancel).toHaveBeenCalledTimes(2);
    expect(h.cancel).toHaveBeenCalledWith("glazers", "fri-30-oct", EVENT);
    expect(h.cancel).toHaveBeenCalledWith("glazers", "fri-6-nov", EVENT);
    expect(out).toEqual([
      { matchId: "fri-30-oct", fromStatus: "BENCH" },
      { matchId: "fri-6-nov", fromStatus: "CONFIRMED" },
    ]);
  });

  it("reads only live rows of THIS club's matches that have not kicked off and are not finished or cancelled", async () => {
    await takeRemovedMemberOffUpcomingMatches({ userId: "glazers", orgId: "fnf", event: EVENT, now: NOW });
    expect(h.findManyArgs[0]).toMatchObject({
      where: {
        userId: "glazers",
        status: { in: ["CONFIRMED", "BENCH"] },
        match: {
          activity: { orgId: "fnf" },
          date: { gt: NOW },
          status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
        },
      },
    });
  });

  it("a member who is back in the club (leftAt null) is left on his matches", async () => {
    h.membership = { leftAt: null };
    h.rows = [{ matchId: "fri-30-oct", status: "BENCH" }];
    expect(await takeRemovedMemberOffUpcomingMatches({ userId: "glazers", orgId: "fnf", event: EVENT, now: NOW })).toEqual([]);
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("no membership at all: nothing", async () => {
    h.membership = null;
    expect(await takeRemovedMemberOffUpcomingMatches({ userId: "glazers", orgId: "fnf", event: EVENT, now: NOW })).toEqual([]);
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("one failed drop never stops the others, and never throws", async () => {
    h.rows = [
      { matchId: "a", status: "BENCH" },
      { matchId: "b", status: "BENCH" },
    ];
    h.cancel.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const out = await takeRemovedMemberOffUpcomingMatches({ userId: "glazers", orgId: "fnf", event: EVENT, now: NOW });
    expect(h.cancel).toHaveBeenCalledTimes(2);
    expect(out).toEqual([{ matchId: "b", fromStatus: "BENCH" }]);
  });
});
