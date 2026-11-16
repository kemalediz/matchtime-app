/**
 * A /play sign-up from a MatchTime staff browser (2026-11-16): made exactly
 * as any other waiting sign-up, with `staffTest` stored on the profile, and
 * not counted as sent. The confirm comes later by WhatsApp, where there is
 * no cookie: the stored flag is what keeps it out of "confirmed" too
 * (`visits.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  db: {
    poolAttempt: { count: vi.fn(), create: vi.fn() },
    poolProfile: { create: vi.fn(), findUnique: vi.fn() },
    poolCampaign: { findFirst: vi.fn() },
  },
}));
vi.mock("../../db", () => dbMock);
vi.mock("../profile-store", () => ({
  resolveArea: vi.fn(async () => ({ ok: true, areaDistrict: "SM1", areaLat: 51.36, areaLng: -0.19 })),
  sportRows: () => [],
  availabilityRows: () => [],
}));
const visits = vi.hoisted(() => ({ recordPoolSignupSent: vi.fn() }));
vi.mock("../visits", () => visits);

import { createPoolSignup } from "../signup";
import type { PoolFields } from "../profile-fields";

const FIELDS = { displayName: "Ali K", areaDistrict: "SM1", maxMiles: 3, availability: [], sports: [], language: "en" } as unknown as PoolFields;
const NOW = new Date("2026-11-16T12:00:00Z");
const signUp = (staffTest?: boolean) =>
  createPoolSignup({ fields: FIELDS, ip: "203.0.113.9", source: { campaignCode: "fb", referralCode: null }, earlyList: true, now: NOW, ...(staffTest === undefined ? {} : { staffTest }) });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.db.poolAttempt.count.mockResolvedValue(0);
  dbMock.db.poolAttempt.create.mockResolvedValue({});
  dbMock.db.poolCampaign.findFirst.mockResolvedValue({ code: "fb" });
  dbMock.db.poolProfile.create.mockResolvedValue({ id: "p1" });
  visits.recordPoolSignupSent.mockResolvedValue("fb");
});

describe("createPoolSignup: a staff test", () => {
  it("is a waiting sign-up like any other, with staffTest stored, and the sent step told so", async () => {
    const res = await signUp(true);
    expect(res).toMatchObject({ ok: true, id: "p1", earlyList: true });
    const data = dbMock.db.poolProfile.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "pending-verify", source: "campaign", sourceCode: "fb", staffTest: true });
    expect(visits.recordPoolSignupSent).toHaveBeenCalledWith(expect.objectContaining({ source: "campaign", sourceCode: "fb", staffTest: true }), NOW);
  });

  it("anybody else's: staffTest false, stored and passed on", async () => {
    for (const flag of [false, undefined]) {
      vi.clearAllMocks();
      dbMock.db.poolProfile.create.mockResolvedValue({ id: "p1" });
      dbMock.db.poolCampaign.findFirst.mockResolvedValue({ code: "fb" });
      dbMock.db.poolAttempt.count.mockResolvedValue(0);
      await signUp(flag);
      expect(dbMock.db.poolProfile.create.mock.calls[0][0].data).toMatchObject({ staffTest: false });
      expect(visits.recordPoolSignupSent).toHaveBeenCalledWith(expect.objectContaining({ staffTest: false }), NOW);
    }
  });
});
