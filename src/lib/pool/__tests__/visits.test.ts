/**
 * Recording a visit to /play (2026-11-03), the thin I/O half: a fetcher
 * writes nothing, a person adds one to his bucket's day with ONE atomic
 * upsert, and a failure is logged and swallowed (a visit must never break
 * or slow the page). Nothing about the person is stored: no address, no
 * user agent, only the bucket, the day and the count.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  db: {
    poolCampaign: { findFirst: vi.fn() },
    $executeRaw: vi.fn(),
    poolCampaignVisit: { findMany: vi.fn() },
  },
}));
vi.mock("../../db", () => dbMock);

import { recordPoolVisit } from "../visits";
import { POOL_VISIT_DIRECT, POOL_VISIT_REFERRAL } from "../visit-rules";

const PERSON = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const NOW = new Date("2026-11-03T12:00:00Z");

/** The bound values of the one upsert. */
function upsertValues(): unknown[] {
  expect(dbMock.db.$executeRaw).toHaveBeenCalledTimes(1);
  const [strings, ...values] = dbMock.db.$executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  const sql = strings.join("?");
  expect(sql).toMatch(/INSERT INTO "PoolCampaignVisit"/);
  expect(sql).toMatch(/ON CONFLICT \("code", "day"\) DO UPDATE SET "count" = "PoolCampaignVisit"\."count" \+ 1/);
  return values;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.db.poolCampaign.findFirst.mockResolvedValue({ code: "fb-sutton" });
  dbMock.db.$executeRaw.mockResolvedValue(1);
});

describe("recordPoolVisit", () => {
  it("a person on a live campaign's link: one more for that code today", async () => {
    expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW })).toBe("fb-sutton");
    expect(dbMock.db.poolCampaign.findFirst).toHaveBeenCalledWith({ where: { code: "fb-sutton", active: true }, select: { code: true } });
    expect(upsertValues()).toEqual(["fb-sutton", "2026-11-03"]);
  });

  it("plain /play: direct, and no campaign lookup", async () => {
    expect(await recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: PERSON, now: NOW })).toBe(POOL_VISIT_DIRECT);
    expect(dbMock.db.poolCampaign.findFirst).not.toHaveBeenCalled();
    expect(upsertValues()).toEqual([POOL_VISIT_DIRECT, "2026-11-03"]);
  });

  it("a switched-off or unknown code: direct", async () => {
    dbMock.db.poolCampaign.findFirst.mockResolvedValue(null);
    expect(await recordPoolVisit({ source: { campaignCode: "old", referralCode: null }, userAgent: PERSON, now: NOW })).toBe(POOL_VISIT_DIRECT);
  });

  it("a friend's link: referral", async () => {
    expect(await recordPoolVisit({ source: { campaignCode: null, referralCode: "AB12cd" }, userAgent: PERSON, now: NOW })).toBe(POOL_VISIT_REFERRAL);
  });

  it("a link preview fetcher writes nothing at all", async () => {
    for (const ua of ["facebookexternalhit/1.1", "WhatsApp/2.23.20.0 A", "Twitterbot/1.0", null]) {
      expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: ua, now: NOW })).toBeNull();
    }
    expect(dbMock.db.poolCampaign.findFirst).not.toHaveBeenCalled();
    expect(dbMock.db.$executeRaw).not.toHaveBeenCalled();
  });

  it("stores nothing about the person: only the bucket and the day are bound", async () => {
    await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW });
    expect(JSON.stringify(upsertValues())).not.toContain("iPhone");
  });

  it("a database error is logged and swallowed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.db.$executeRaw.mockRejectedValue(new Error("pool down"));
    await expect(recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: PERSON, now: NOW })).resolves.toBeNull();
    dbMock.db.poolCampaign.findFirst.mockRejectedValue(new Error("pool down"));
    await expect(recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain("[pool-visit]");
    warn.mockRestore();
  });
});
