/**
 * "INACTIVE" ON THE ADMIN PLAYER PAGES IS DERIVED FROM REAL PLAY, PER CLUB.
 *
 * The positions, phones and ratings pages badge a member "Inactive" and
 * hide him under the default "Active" filter. That used to read
 * `User.isActive`, a global flag written once by a rebuild script on
 * 18 Apr 2026 and never again, so Sutton regulars who play every week
 * showed as Inactive (Ersan Arik and Recai Gunay played 17 Nov 2026).
 *
 * The rule now: a member is active at THIS club when he has a CONFIRMED
 * attendance at a played match of this club (kicked off, not cancelled)
 * inside the stats page's window (`RANKED_TABLE_INACTIVE_AFTER_MONTHS`),
 * or when he joined this club inside that window and simply has not had
 * a game yet. A new member is not "Inactive" on day one.
 */
import { describe, it, expect, vi } from "vitest";
import { isActiveInClub, loadRecentlyPlayedUserIds } from "@/lib/club-member-activity";
import { RANKED_TABLE_INACTIVE_AFTER_MONTHS, rankedTableCutoff } from "@/lib/ranked-table-activity";

const NOW = new Date("2026-11-17T22:00:00Z");
const monthsAgo = (n: number, extraMs = 0) => {
  const d = new Date(NOW.getTime());
  d.setMonth(d.getMonth() - n);
  return new Date(d.getTime() + extraMs);
};

describe("isActiveInClub", () => {
  it("uses the stats page's window, three months", () => {
    expect(RANKED_TABLE_INACTIVE_AFTER_MONTHS).toBe(3);
  });

  it("a member who played inside the window is active, however long ago he joined", () => {
    expect(isActiveInClub({ joinedAt: monthsAgo(7), playedInWindow: true }, NOW)).toBe(true);
  });

  it("a long-standing member with no game inside the window is inactive", () => {
    expect(isActiveInClub({ joinedAt: monthsAgo(7), playedInWindow: false }, NOW)).toBe(false);
  });

  it("a member who joined inside the window and has not played yet is NOT inactive", () => {
    expect(isActiveInClub({ joinedAt: new Date(NOW.getTime() - 60_000), playedInWindow: false }, NOW)).toBe(true);
    expect(isActiveInClub({ joinedAt: monthsAgo(2), playedInWindow: false }, NOW)).toBe(true);
  });

  it("joining exactly at the cutoff still counts as inside the window; a moment earlier does not", () => {
    const cutoff = rankedTableCutoff(NOW);
    expect(isActiveInClub({ joinedAt: cutoff, playedInWindow: false }, NOW)).toBe(true);
    expect(isActiveInClub({ joinedAt: new Date(cutoff.getTime() - 1), playedInWindow: false }, NOW)).toBe(false);
  });
});

describe("loadRecentlyPlayedUserIds", () => {
  function fakeDb(rows: Array<{ userId: string }>) {
    const groupBy = vi.fn().mockResolvedValue(rows);
    const findMany = vi.fn();
    return { db: { attendance: { groupBy, findMany } }, groupBy, findMany };
  }

  it("asks ONE grouped query for the whole roster, scoped to this club's played matches in the window", async () => {
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
        status: { not: "CANCELLED" },
        date: { gte: rankedTableCutoff(NOW), lte: NOW },
      },
    });
  });

  it("runs no query for an empty roster", async () => {
    const { db, groupBy } = fakeDb([]);
    expect(await loadRecentlyPlayedUserIds(db, "org-sutton", [], NOW)).toEqual(new Set());
    expect(groupBy).not.toHaveBeenCalled();
  });
});
