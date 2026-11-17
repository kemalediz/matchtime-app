/**
 * "INACTIVE" ON THE ADMIN PLAYER PAGES: A MEMBER WHO PLAYS IS NEVER INACTIVE.
 *
 * The positions, phones and ratings pages badge a member "Inactive" and
 * hide him under the default "Active" filter, from `User.isActive`. That
 * flag was written once by a rebuild script on 18 Apr 2026 and never
 * again, so Sutton regulars who play every week showed as Inactive
 * (Ersan Arik and Recai Gunay played 17 Nov 2026).
 *
 * The fix is narrow on purpose: active = `User.isActive` OR played for
 * THIS club inside the stats page's window. It only rescues members who
 * play; everyone else keeps the value they had. "Played" is the stats
 * page's own definition (`playedAttendanceWhere`), so the admin pages and
 * the leaderboards agree.
 */
import { describe, it, expect, vi } from "vitest";
import { isActiveInClub, loadRecentlyPlayedUserIds } from "@/lib/club-member-activity";
import { playedAttendanceWhere, rankedTableCutoff } from "@/lib/ranked-table-activity";

const NOW = new Date("2026-11-17T22:00:00Z");

describe("isActiveInClub", () => {
  it("a stale-false member who played here in the window is rescued", () => {
    expect(isActiveInClub({ globalIsActive: false, playedInWindow: true })).toBe(true);
  });

  it("a flag-true member who never played stays active (no new Inactives)", () => {
    expect(isActiveInClub({ globalIsActive: true, playedInWindow: false })).toBe(true);
  });

  it("a flag-false member with no game here in the window stays inactive", () => {
    expect(isActiveInClub({ globalIsActive: false, playedInWindow: false })).toBe(false);
  });
});

describe("playedAttendanceWhere: the stats page's 'played'", () => {
  it("is a CONFIRMED row on a COMPLETED, non-historical match of this club", () => {
    expect(playedAttendanceWhere("org-sutton")).toEqual({
      status: "CONFIRMED",
      match: { activity: { orgId: "org-sutton" }, status: "COMPLETED", isHistorical: false },
    });
  });

  it("is the filter loadLastPlayedByUser uses", async () => {
    const { loadLastPlayedByUser } = await import("@/lib/ranked-table-activity");
    const findMany = vi.fn().mockResolvedValue([]);
    await loadLastPlayedByUser({ attendance: { findMany } }, "org-sutton");
    expect(findMany.mock.calls[0][0].where).toEqual(playedAttendanceWhere("org-sutton"));
  });
});

describe("loadRecentlyPlayedUserIds", () => {
  function fakeDb(rows: Array<{ userId: string }>) {
    const groupBy = vi.fn().mockResolvedValue(rows);
    const findMany = vi.fn();
    return { db: { attendance: { groupBy, findMany } }, groupBy, findMany };
  }

  it("asks ONE grouped query for the roster: the stats page's 'played', in this club, inside the window", async () => {
    const { db, groupBy, findMany } = fakeDb([{ userId: "ersan" }, { userId: "recai" }]);
    const ids = await loadRecentlyPlayedUserIds(db, "org-sutton", ["ersan", "recai", "mehmet"], NOW);

    expect(ids).toEqual(new Set(["ersan", "recai"]));
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(findMany).not.toHaveBeenCalled();
    const args = groupBy.mock.calls[0][0];
    expect(args.by).toEqual(["userId"]);
    expect(args.where).toEqual({
      userId: { in: ["ersan", "recai", "mehmet"] },
      status: "CONFIRMED",
      match: {
        activity: { orgId: "org-sutton" },
        status: "COMPLETED",
        isHistorical: false,
        date: { gte: rankedTableCutoff(NOW) },
      },
    });
  });

  it("runs no query for an empty roster", async () => {
    const { db, groupBy } = fakeDb([]);
    expect(await loadRecentlyPlayedUserIds(db, "org-sutton", [], NOW)).toEqual(new Set());
    expect(groupBy).not.toHaveBeenCalled();
  });
});
