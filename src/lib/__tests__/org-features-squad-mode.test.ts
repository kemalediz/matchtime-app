/**
 * `Organisation.squadMode` through the features path (monthly squad,
 * slice 2, MDs/monthly-squad-plan-2026-10-05.md section 3).
 *
 * The mode is a per-club setting that is OFF by default. What is pinned:
 * every club reads "weekly" unless its row says exactly "monthly", so a
 * row from before the column, a typo and a missing club all behave as
 * today.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const findFirst = vi.fn();

vi.mock("../db", () => ({
  db: {
    organisation: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      findFirst: (...args: unknown[]) => findFirst(...args),
    },
  },
}));

import { getOrgFeatures, getOrgFeaturesByGroup } from "../org-features";

const ROW = {
  id: "org-1",
  whatsappBotEnabled: true,
  featureAttendance: true,
  featureBench: true,
  featureTeamBalancing: true,
  featureMomVoting: true,
  featurePlayerRating: true,
  featureReminders: true,
  featureStatsQa: true,
  paymentTrackingEnabled: false,
  paymentCollectionEnabled: false,
  featureSquadFromList: false,
  language: "en",
  rollingSquadEnabled: false,
};

beforeEach(() => {
  findUnique.mockReset();
  findFirst.mockReset();
});

describe("getOrgFeatures: squadMode", () => {
  it("selects the column", async () => {
    findUnique.mockResolvedValueOnce(ROW);
    await getOrgFeatures("org-1");
    const call = findUnique.mock.calls[0]?.[0] as { select: Record<string, boolean> };
    expect(call.select.squadMode).toBe(true);
  });

  it("defaults to weekly: the column default, and a row read without the column", async () => {
    findUnique.mockResolvedValueOnce({ ...ROW, squadMode: "weekly" });
    expect((await getOrgFeatures("org-1")).squadMode).toBe("weekly");
    findUnique.mockResolvedValueOnce(ROW);
    expect((await getOrgFeatures("org-1")).squadMode).toBe("weekly");
  });

  it("carries monthly for a club that switched it on", async () => {
    findUnique.mockResolvedValueOnce({ ...ROW, squadMode: "monthly" });
    expect((await getOrgFeatures("org-1")).squadMode).toBe("monthly");
  });

  it("anything unrecognised reads as weekly, never as a third mode", async () => {
    for (const bad of ["Monthly", "", "yearly", null]) {
      findUnique.mockResolvedValueOnce({ ...ROW, squadMode: bad });
      expect((await getOrgFeatures("org-1")).squadMode).toBe("weekly");
    }
  });

  it("a club that cannot be read is weekly too", async () => {
    findUnique.mockResolvedValueOnce(null);
    expect((await getOrgFeatures("nope")).squadMode).toBe("weekly");
  });

  it("the group lookup carries it as well", async () => {
    findFirst.mockResolvedValueOnce({ ...ROW, squadMode: "monthly" });
    expect((await getOrgFeaturesByGroup("g@g.us"))?.features.squadMode).toBe("monthly");
  });
});
