/**
 * `Organisation.language` reaches the pipeline through the features
 * path, and nowhere else.
 *
 * `loadSquadState` already calls `getOrgFeatures` once per batch and
 * stores the result on `SquadState.features`, so plumbing the language
 * through `OrgFeatures` gives every composer `state.features.language`
 * with no extra query (the loader's own comment is about avoiding "an
 * extra findUnique"; this adds none). Phase 0 of
 * MDs/multi-language-design-2026-09-16.md, section 4.1.
 *
 * Three things are pinned:
 *   1. the SELECT names the column, so a row that has it comes back
 *      with it;
 *   2. an unrecognised value in the column normalises to "en" (a bad
 *      value can never produce a blank message);
 *   3. the all-off fallback for a missing org is "en" too.
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
};

beforeEach(() => {
  findUnique.mockReset();
  findFirst.mockReset();
});

describe("getOrgFeatures: language", () => {
  it("selects the language column", async () => {
    findUnique.mockResolvedValueOnce(ROW);
    await getOrgFeatures("org-1");
    const call = findUnique.mock.calls[0]?.[0] as { select: Record<string, boolean> };
    expect(call.select.language).toBe(true);
  });

  it("carries 'en' for an English org (Sutton FC's row)", async () => {
    findUnique.mockResolvedValueOnce(ROW);
    const f = await getOrgFeatures("org-1");
    expect(f.language).toBe("en");
  });

  it("carries 'tr' for a Turkish org", async () => {
    findUnique.mockResolvedValueOnce({ ...ROW, language: "tr" });
    const f = await getOrgFeatures("org-1");
    expect(f.language).toBe("tr");
  });

  it("normalises an unrecognised value to 'en' rather than passing it through", async () => {
    findUnique.mockResolvedValueOnce({ ...ROW, language: "klingon" });
    const f = await getOrgFeatures("org-1");
    expect(f.language).toBe("en");
  });

  it("normalises case and a region suffix", async () => {
    findUnique.mockResolvedValueOnce({ ...ROW, language: "TR-tr" });
    const f = await getOrgFeatures("org-1");
    expect(f.language).toBe("tr");
  });

  it("a missing org falls back to all-off AND English", async () => {
    findUnique.mockResolvedValueOnce(null);
    const f = await getOrgFeatures("nope");
    expect(f.botEnabled).toBe(false);
    expect(f.language).toBe("en");
  });

  it("does not change any other feature flag's mapping", async () => {
    findUnique.mockResolvedValueOnce({ ...ROW, featureBench: false, paymentTrackingEnabled: true });
    const f = await getOrgFeatures("org-1");
    expect(f.bench).toBe(false);
    expect(f.paymentTracking).toBe(true);
    expect(f.attendance).toBe(true);
  });
});

describe("getOrgFeaturesByGroup: language", () => {
  it("carries the language through the group lookup too", async () => {
    findFirst.mockResolvedValueOnce({ ...ROW, language: "tr" });
    const r = await getOrgFeaturesByGroup("group@g.us");
    expect(r?.orgId).toBe("org-1");
    expect(r?.features.language).toBe("tr");
    const call = findFirst.mock.calls[0]?.[0] as { select: Record<string, boolean> };
    expect(call.select.language).toBe(true);
  });
});
