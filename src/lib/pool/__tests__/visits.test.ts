/**
 * Recording the /play sign-up funnel (visits 2026-11-03, every step
 * 2026-11-04), the thin I/O half: a fetcher writes nothing, each step adds
 * one to its bucket's day with ONE atomic upsert, and a failure is logged
 * and swallowed (a count must never break or slow the page, the sign-up or
 * the confirm). Nothing about the person is stored: no address, no user
 * agent, no id, only the bucket, the day, the step and the count. Since
 * 2026-11-13 each page step also leaves one visit log row, kept 90 days:
 * the coarse fields of `visit-log-rules.ts` only, best-effort on its own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  db: {
    poolCampaign: { findFirst: vi.fn() },
    poolProfile: { findUnique: vi.fn() },
    poolVisitEvent: { create: vi.fn(), count: vi.fn(), deleteMany: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));
vi.mock("../../db", () => dbMock);

import { purgeOldPoolVisitEvents, recordPoolSignupConfirmed, recordPoolSignupSent, recordPoolVisit } from "../visits";
import { POOL_VISIT_DIRECT, POOL_VISIT_REFERRAL } from "../visit-rules";

const info = vi.spyOn(console, "info").mockImplementation(() => {});

const PERSON = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const NOW = new Date("2026-11-03T12:00:00Z");

/** The bound values of the one upsert. */
function upsertValues(): unknown[] {
  expect(dbMock.db.$executeRaw).toHaveBeenCalledTimes(1);
  const [strings, ...values] = dbMock.db.$executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  const sql = strings.join("?");
  expect(sql).toMatch(/INSERT INTO "PoolCampaignVisit" \("code", "day", "step", "count"\)/);
  expect(sql).toMatch(/ON CONFLICT \("code", "day", "step"\) DO UPDATE SET "count" = "PoolCampaignVisit"\."count" \+ 1/);
  return values;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.db.poolCampaign.findFirst.mockResolvedValue({ code: "fb-sutton" });
  dbMock.db.poolProfile.findUnique.mockResolvedValue({ userId: "u-friend" });
  dbMock.db.$executeRaw.mockResolvedValue(1);
  dbMock.db.poolVisitEvent.create.mockResolvedValue({});
  dbMock.db.poolVisitEvent.count.mockResolvedValue(0);
  dbMock.db.poolVisitEvent.deleteMany.mockResolvedValue({ count: 0 });
});

/** The one visit event row written. */
function eventRow(): Record<string, unknown> {
  expect(dbMock.db.poolVisitEvent.create).toHaveBeenCalledTimes(1);
  return (dbMock.db.poolVisitEvent.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

describe("recordPoolVisit: the page's steps, opened and started", () => {
  it("a person on a live campaign's link: one more opened for that code today", async () => {
    expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW })).toBe("fb-sutton");
    expect(dbMock.db.poolCampaign.findFirst).toHaveBeenCalledWith({ where: { code: "fb-sutton", active: true }, select: { code: true } });
    expect(upsertValues()).toEqual(["fb-sutton", "2026-11-03", "opened"]);
  });

  it("started counts under the same bucket, on its own step", async () => {
    expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW, step: "started" })).toBe("fb-sutton");
    expect(upsertValues()).toEqual(["fb-sutton", "2026-11-03", "started"]);
  });

  it("plain /play: direct, and no lookup at all", async () => {
    expect(await recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: PERSON, now: NOW })).toBe(POOL_VISIT_DIRECT);
    expect(dbMock.db.poolCampaign.findFirst).not.toHaveBeenCalled();
    expect(dbMock.db.poolProfile.findUnique).not.toHaveBeenCalled();
    expect(upsertValues()).toEqual([POOL_VISIT_DIRECT, "2026-11-03", "opened"]);
  });

  it("a switched-off or unknown code: direct", async () => {
    dbMock.db.poolCampaign.findFirst.mockResolvedValue(null);
    expect(await recordPoolVisit({ source: { campaignCode: "old", referralCode: null }, userAgent: PERSON, now: NOW })).toBe(POOL_VISIT_DIRECT);
  });

  it("a friend's link: referral, when the share code is a confirmed player's (as the sign-up checks)", async () => {
    expect(await recordPoolVisit({ source: { campaignCode: null, referralCode: "AB12cd" }, userAgent: PERSON, now: NOW })).toBe(POOL_VISIT_REFERRAL);
    expect(dbMock.db.poolProfile.findUnique).toHaveBeenCalledWith({ where: { shareCode: "AB12cd" }, select: { userId: true } });
  });

  it("a share code nobody holds falls through to the live campaign, as the sign-up does", async () => {
    dbMock.db.poolProfile.findUnique.mockResolvedValue(null);
    expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: "zzzzzz" }, userAgent: PERSON, now: NOW })).toBe("fb-sutton");
  });

  it("a link preview fetcher counts nothing; its visit is logged only as a scanner (2026-11-13)", async () => {
    for (const ua of ["facebookexternalhit/1.1", "WhatsApp/2.23.20.0 A", "Twitterbot/1.0", null]) {
      expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: ua, now: NOW, step: "started" })).toBeNull();
    }
    expect(dbMock.db.$executeRaw).not.toHaveBeenCalled();
    const rows = dbMock.db.poolVisitEvent.create.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toMatchObject({ code: "fb-sutton", step: "started", scanner: true });
  });

  it("stores nothing about the person: only the bucket, the day and the step are bound", async () => {
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
    expect(String(warn.mock.calls[0][0])).toContain("[pool-funnel]");
    warn.mockRestore();
  });
});

describe("recordPoolVisit: the visit log, kept 90 days (2026-11-13)", () => {
  const ALLOWED = ["at", "browser", "code", "device", "hasRef", "inApp", "openedBy", "scanner", "step", "visibleMs"];

  it("one row per counted beacon, holding only the allowed fields", async () => {
    await recordPoolVisit({
      source: { campaignCode: "fb-sutton", referralCode: null },
      userAgent: PERSON,
      now: new Date("2026-11-03T12:34:56.789Z"),
      step: "opened",
      detail: { openedBy: "scroll", visibleMs: 2300 },
    });
    const row = eventRow();
    expect(Object.keys(row).sort()).toEqual(ALLOWED);
    expect(row).toEqual({
      at: new Date("2026-11-03T12:00:00.000Z"),
      code: "fb-sutton",
      step: "opened",
      openedBy: "scroll",
      visibleMs: 2300,
      hasRef: false,
      browser: "safari",
      inApp: "none",
      device: "mobile",
      scanner: false,
    });
  });

  it("a friend's link: hasRef only, never the code, and never the user agent", async () => {
    await recordPoolVisit({ source: { campaignCode: null, referralCode: "AB12cd" }, userAgent: PERSON, now: NOW, step: "started" });
    const row = eventRow();
    expect(row).toMatchObject({ code: POOL_VISIT_REFERRAL, step: "started", hasRef: true, openedBy: null, visibleMs: null });
    const stored = JSON.stringify(row);
    for (const secret of ["AB12cd", "iPhone", "Mozilla", "Safari/604"]) expect(stored).not.toContain(secret);
  });

  it("no detail from an old cached page: the row is still written, its detail none", async () => {
    await recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: PERSON, now: NOW });
    expect(eventRow()).toMatchObject({ code: POOL_VISIT_DIRECT, step: "opened", openedBy: null, visibleMs: null });
  });

  it("a failed log write never costs the count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.db.poolVisitEvent.create.mockRejectedValue(new Error('relation "PoolVisitEvent" does not exist'));
    expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW })).toBe("fb-sutton");
    expect(upsertValues()).toEqual(["fb-sutton", "2026-11-03", "opened"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("[pool-funnel]");
    warn.mockRestore();
  });

  it("a failed count still logs the visit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.db.$executeRaw.mockRejectedValue(new Error("pool down"));
    expect(await recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: PERSON, now: NOW })).toBeNull();
    expect(eventRow()).toMatchObject({ code: POOL_VISIT_DIRECT, scanner: false });
    warn.mockRestore();
  });
});

describe("recordPoolVisit: the visit log's volume cap (review of #600)", () => {
  it("counts the bucket's rows in the visit's hour before writing", async () => {
    await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: new Date("2026-11-03T12:34:56Z") });
    expect(dbMock.db.poolVisitEvent.count).toHaveBeenCalledWith({ where: { code: "fb-sutton", at: new Date("2026-11-03T12:00:00Z") } });
    expect(dbMock.db.poolVisitEvent.create).toHaveBeenCalledTimes(1);
  });

  it("once the code's hour holds 200 rows, no more are written, and the visit still counts", async () => {
    dbMock.db.poolVisitEvent.count.mockResolvedValue(200);
    expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW })).toBe("fb-sutton");
    expect(dbMock.db.poolVisitEvent.create).not.toHaveBeenCalled();
    expect(upsertValues()).toEqual(["fb-sutton", "2026-11-03", "opened"]);
  });

  it("199 rows: room for one more", async () => {
    dbMock.db.poolVisitEvent.count.mockResolvedValue(199);
    await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW });
    expect(dbMock.db.poolVisitEvent.create).toHaveBeenCalledTimes(1);
  });

  it("a failed check writes no row, is logged, and never costs the count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.db.poolVisitEvent.count.mockRejectedValue(new Error("pool down"));
    expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW })).toBe("fb-sutton");
    expect(dbMock.db.poolVisitEvent.create).not.toHaveBeenCalled();
    expect(upsertValues()).toEqual(["fb-sutton", "2026-11-03", "opened"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("purgeOldPoolVisitEvents: the daily cron deletes the log after 90 days", () => {
  it("deletes every row older than 90 days", async () => {
    dbMock.db.poolVisitEvent.deleteMany.mockResolvedValue({ count: 7 });
    expect(await purgeOldPoolVisitEvents(new Date("2026-11-13T06:00:00Z"))).toBe(7);
    expect(dbMock.db.poolVisitEvent.deleteMany).toHaveBeenCalledWith({ where: { at: { lt: new Date("2026-08-15T06:00:00Z") } } });
  });

  it("a failure (the table not migrated yet) is 0, never a throw into the cron", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    dbMock.db.poolVisitEvent.deleteMany.mockRejectedValue(new Error('relation "PoolVisitEvent" does not exist'));
    expect(await purgeOldPoolVisitEvents(new Date("2026-11-13T06:00:00Z"))).toBe(0);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

describe("recordPoolVisit: one server log line per beacon, to identify scanners (2026-11-06)", () => {
  const lines = () => info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[pool-funnel] beacon "));

  it("counted: the step, the code as sent, the bucket and the raw user agent, quoted", async () => {
    await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW, step: "started" });
    expect(lines()).toEqual([`[pool-funnel] beacon step=started code=fb-sutton ref=no result=counted bucket=fb-sutton ua=${JSON.stringify(PERSON)}`]);
  });

  it("a link preview fetcher: filtered, with its user agent, and nothing written", async () => {
    await recordPoolVisit({ source: { campaignCode: "fb", referralCode: null }, userAgent: "facebookexternalhit/1.1", now: NOW });
    expect(lines()).toEqual(['[pool-funnel] beacon step=opened code=fb ref=no result=fetcher bucket=- ua="facebookexternalhit/1.1"']);
    expect(dbMock.db.$executeRaw).not.toHaveBeenCalled();
  });

  it("no user agent at all, plain /play: filtered, ua=none", async () => {
    await recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: null, now: NOW });
    expect(lines()).toEqual(["[pool-funnel] beacon step=opened code=- ref=no result=fetcher bucket=- ua=none"]);
  });

  it("a friend's link logs that there was a share code, never the code itself", async () => {
    await recordPoolVisit({ source: { campaignCode: null, referralCode: "AB12cd" }, userAgent: PERSON, now: NOW });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("ref=yes result=counted bucket=_referral");
    expect(lines()[0]).not.toContain("AB12cd");
  });

  it("a failure is logged as failed, still with its user agent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.db.$executeRaw.mockRejectedValue(new Error("pool down"));
    await recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: PERSON, now: NOW });
    expect(lines()).toEqual([`[pool-funnel] beacon step=opened code=- ref=no result=failed bucket=- ua=${JSON.stringify(PERSON)}`]);
    warn.mockRestore();
  });

  it("a user agent with quotes or a line break stays on one line", async () => {
    await recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: 'Evil "x"\nnext', now: NOW });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).not.toContain("\n");
    expect(lines()[0]).toContain('ua="Evil \\"x\\"\\nnext"');
  });
});

describe("recordPoolSignupSent: the form sent, a waiting sign-up made", () => {
  it("under the sign-up's own attribution, on its London day", async () => {
    expect(await recordPoolSignupSent({ source: "campaign", sourceCode: "fb-sutton" }, NOW)).toBe("fb-sutton");
    expect(upsertValues()).toEqual(["fb-sutton", "2026-11-03", "sent"]);
  });
  it("the web is direct, a friend's share link is referral", async () => {
    expect(await recordPoolSignupSent({ source: "web", sourceCode: null }, NOW)).toBe(POOL_VISIT_DIRECT);
    expect(await recordPoolSignupSent({ source: "referral", sourceCode: "AB12cd" }, NOW)).toBe(POOL_VISIT_REFERRAL);
  });
  it("a friend link for one game, or a member's own profile, is not a /play sign-up: nothing written", async () => {
    expect(await recordPoolSignupSent({ source: "friend", sourceCode: null }, NOW)).toBeNull();
    expect(await recordPoolSignupSent({ source: "profile", sourceCode: null }, NOW)).toBeNull();
    expect(dbMock.db.$executeRaw).not.toHaveBeenCalled();
  });
  it("a database error is logged and swallowed: the sign-up goes on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.db.$executeRaw.mockRejectedValue(new Error("pool down"));
    await expect(recordPoolSignupSent({ source: "web", sourceCode: null }, NOW)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("recordPoolSignupConfirmed: the WhatsApp message sent, the profile active", () => {
  it("reads the profile's attribution and counts it once on the London day", async () => {
    dbMock.db.poolProfile.findUnique.mockResolvedValue({ source: "campaign", sourceCode: "fb-sutton" });
    expect(await recordPoolSignupConfirmed("p1", NOW)).toBe("fb-sutton");
    expect(dbMock.db.poolProfile.findUnique).toHaveBeenCalledWith({ where: { id: "p1" }, select: { source: true, sourceCode: true } });
    expect(upsertValues()).toEqual(["fb-sutton", "2026-11-03", "confirmed"]);
  });
  it("a friend link's sign-up, or a profile that is gone, writes nothing", async () => {
    dbMock.db.poolProfile.findUnique.mockResolvedValueOnce({ source: "friend", sourceCode: null }).mockResolvedValueOnce(null);
    expect(await recordPoolSignupConfirmed("p1", NOW)).toBeNull();
    expect(await recordPoolSignupConfirmed("p2", NOW)).toBeNull();
    expect(dbMock.db.$executeRaw).not.toHaveBeenCalled();
  });
  it("a database error is logged and swallowed: the welcome still goes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.db.poolProfile.findUnique.mockRejectedValue(new Error("pool down"));
    await expect(recordPoolSignupConfirmed("p1", NOW)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
