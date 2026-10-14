/**
 * `Organisation.featureGearReminder` through the features path (Kemal,
 * 2026-10-15). The match-day "bring goalie gloves, a ball and spare bibs"
 * post is a club setting: OFF for a new club (the column default), ON for
 * every club that existed before it (the migration sets them), and a row
 * read without the column (an older caller, a hand-built fixture) keeps
 * today's behaviour: ON.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();

vi.mock("../db", () => ({
  db: { organisation: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

import { getOrgFeatures } from "../org-features";

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

beforeEach(() => findUnique.mockReset());

describe("getOrgFeatures: gearReminder", () => {
  it("selects the column", async () => {
    findUnique.mockResolvedValueOnce(ROW);
    await getOrgFeatures("org-1");
    const call = findUnique.mock.calls[0]?.[0] as { select: Record<string, boolean> };
    expect(call.select.featureGearReminder).toBe(true);
  });

  it("reads the row: off for a new club, on for an existing one", async () => {
    findUnique.mockResolvedValueOnce({ ...ROW, featureGearReminder: false });
    expect((await getOrgFeatures("org-1")).gearReminder).toBe(false);
    findUnique.mockResolvedValueOnce({ ...ROW, featureGearReminder: true });
    expect((await getOrgFeatures("org-1")).gearReminder).toBe(true);
  });

  it("a row read without the column keeps today's behaviour (on)", async () => {
    findUnique.mockResolvedValueOnce(ROW);
    expect((await getOrgFeatures("org-1")).gearReminder).toBe(true);
  });

  it("an unknown club: off, like everything else", async () => {
    findUnique.mockResolvedValueOnce(null);
    expect((await getOrgFeatures("org-1")).gearReminder).toBe(false);
  });
});
