/**
 * Review of #404, 4: deleting the profile and signing up again (or joining
 * from a member's profile) must not escape a pause MatchTime decided. The
 * activation re-runs the rules on his surviving records, in its own
 * transaction.
 */
import { describe, expect, it, vi } from "vitest";
import { applyStandingPause } from "../standing-pause";

const NOW = new Date("2026-12-01T12:00:00Z");
const DAY = 24 * 3600_000;

function client(o: { places?: unknown[]; reports?: unknown[] }) {
  return {
    guestPlace: { findMany: vi.fn(async () => o.places ?? []) },
    poolReport: { findMany: vi.fn(async () => o.reports ?? []) },
    poolProfile: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
}
const noShow = (daysAgo: number) => ({ result: "no-show", settledAt: new Date(NOW.getTime() - daysAgo * DAY), match: { date: new Date(NOW.getTime() - (daysAgo + 1) * DAY), status: "COMPLETED" } });

describe("applyStandingPause", () => {
  it("two recent final no-shows: the new profile is paused for no-shows, dated from the later one", async () => {
    const c = client({ places: [noShow(20), noShow(10)] });
    expect(await applyStandingPause(c, "u1", NOW)).toBe("no-shows");
    expect(c.poolProfile.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", status: "active" },
      data: { status: "paused", pausedReason: "no-shows", pausedAt: new Date(NOW.getTime() - 10 * DAY) },
    });
  });
  it("open reports from two clubs: paused for reports", async () => {
    const c = client({ reports: [{ orgId: "a" }, { orgId: "b" }] });
    expect(await applyStandingPause(c, "u1", NOW)).toBe("reports");
    expect((c.poolProfile.updateMany.mock.calls as unknown as [{ data: unknown }][])[0][0].data).toMatchObject({ pausedReason: "reports", pausedAt: NOW });
  });
  it("nothing standing: untouched", async () => {
    const c = client({ places: [noShow(10)] });
    expect(await applyStandingPause(c, "u1", NOW)).toBeNull();
    expect(c.poolProfile.updateMany).not.toHaveBeenCalled();
  });
});
