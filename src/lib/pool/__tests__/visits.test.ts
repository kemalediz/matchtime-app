/**
 * Recording the /play sign-up funnel (visits 2026-11-03, every step
 * 2026-11-04), the thin I/O half: a fetcher counts nothing, each step adds
 * one to its bucket's day with ONE atomic upsert, and a failure is logged
 * and swallowed (a count must never break or slow the page, the sign-up or
 * the confirm). Nothing about the person is stored: no address, no user
 * agent, no id, only the bucket, the day, the step and the count.
 *
 * The breakdown (2026-11-16, daily totals only): each OPEN also adds one
 * to a daily total by in-app browser and scanner flag
 * ("PoolVisitDaily"), ONE atomic upsert, best-effort on its own; a start
 * adds nothing; no browser, device, hour or time on screen. The server log
 * line holds the same categories, never the user agent. Deleted 90 days after its day. A staff test sign-up
 * (`PoolProfile.staffTest`) counts as neither sent nor confirmed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  db: {
    poolCampaign: { findFirst: vi.fn() },
    poolProfile: { findUnique: vi.fn() },
    poolVisitDaily: { deleteMany: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));
vi.mock("../../db", () => dbMock);

import { purgeOldPoolVisitDaily, recordPoolSignupConfirmed, recordPoolSignupSent, recordPoolVisit } from "../visits";
import { POOL_VISIT_DIRECT, POOL_VISIT_REFERRAL } from "../visit-rules";

const info = vi.spyOn(console, "info").mockImplementation(() => {});

const PERSON = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const NOW = new Date("2026-11-03T12:00:00Z");

type Raw = { sql: string; values: unknown[] };
const raws = (): Raw[] =>
  dbMock.db.$executeRaw.mock.calls.map((c) => {
    const [strings, ...values] = c as [TemplateStringsArray, ...unknown[]];
    return { sql: strings.join("?"), values };
  });
const counterCalls = () => raws().filter((r) => r.sql.includes('"PoolCampaignVisit"'));
const dailyCalls = () => raws().filter((r) => r.sql.includes('"PoolVisitDaily"'));

/** The bound values of the one counter upsert. */
function upsertValues(): unknown[] {
  const calls = counterCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0].sql).toMatch(/INSERT INTO "PoolCampaignVisit" \("code", "day", "step", "count"\)/);
  expect(calls[0].sql).toMatch(/ON CONFLICT \("code", "day", "step"\) DO UPDATE SET "count" = "PoolCampaignVisit"\."count" \+ 1/);
  return calls[0].values;
}

const DAILY_COLUMNS = ["code", "day", "inApp", "scanner"];

/** The bound values of the one daily total upsert, by column. */
function dailyRow(): Record<string, unknown> {
  const calls = dailyCalls();
  expect(calls).toHaveLength(1);
  const cols = `"code", "day", "inApp", "scanner"`;
  expect(calls[0].sql).toContain(`INSERT INTO "PoolVisitDaily" (${cols}, "count")`);
  expect(calls[0].sql).toContain(`ON CONFLICT (${cols}) DO UPDATE SET "count" = "PoolVisitDaily"."count" + 1`);
  expect(calls[0].values).toHaveLength(DAILY_COLUMNS.length);
  return Object.fromEntries(DAILY_COLUMNS.map((c, i) => [c, calls[0].values[i]]));
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.db.poolCampaign.findFirst.mockResolvedValue({ code: "fb-sutton" });
  dbMock.db.poolProfile.findUnique.mockResolvedValue({ userId: "u-friend" });
  dbMock.db.$executeRaw.mockResolvedValue(1);
  dbMock.db.poolVisitDaily.deleteMany.mockResolvedValue({ count: 0 });
});

describe("recordPoolVisit: the page's steps, opened and started", () => {
  it("a person on a live campaign's link: one more opened for that code today", async () => {
    expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW, step: "opened" })).toBe("fb-sutton");
    expect(dbMock.db.poolCampaign.findFirst).toHaveBeenCalledWith({ where: { code: "fb-sutton", active: true }, select: { code: true } });
    expect(upsertValues()).toEqual(["fb-sutton", "2026-11-03", "opened"]);
  });

  it("started counts under the same bucket, on its own step, and is added to no breakdown (the counters already count it)", async () => {
    expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW, step: "started" })).toBe("fb-sutton");
    expect(upsertValues()).toEqual(["fb-sutton", "2026-11-03", "started"]);
    expect(dailyCalls()).toHaveLength(0);
  });

  it("plain /play: direct, and no lookup at all", async () => {
    expect(await recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: PERSON, now: NOW, step: "opened" })).toBe(POOL_VISIT_DIRECT);
    expect(dbMock.db.poolCampaign.findFirst).not.toHaveBeenCalled();
    expect(dbMock.db.poolProfile.findUnique).not.toHaveBeenCalled();
    expect(upsertValues()).toEqual([POOL_VISIT_DIRECT, "2026-11-03", "opened"]);
  });

  it("a switched-off or unknown code: direct", async () => {
    dbMock.db.poolCampaign.findFirst.mockResolvedValue(null);
    expect(await recordPoolVisit({ source: { campaignCode: "old", referralCode: null }, userAgent: PERSON, now: NOW, step: "opened" })).toBe(POOL_VISIT_DIRECT);
  });

  it("a friend's link: referral, when the share code is a confirmed player's (as the sign-up checks)", async () => {
    expect(await recordPoolVisit({ source: { campaignCode: null, referralCode: "AB12cd" }, userAgent: PERSON, now: NOW, step: "opened" })).toBe(POOL_VISIT_REFERRAL);
    expect(dbMock.db.poolProfile.findUnique).toHaveBeenCalledWith({ where: { shareCode: "AB12cd" }, select: { userId: true } });
  });

  it("a share code nobody holds falls through to the live campaign, as the sign-up does", async () => {
    dbMock.db.poolProfile.findUnique.mockResolvedValue(null);
    expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: "zzzzzz" }, userAgent: PERSON, now: NOW, step: "opened" })).toBe("fb-sutton");
  });

  it("a link preview fetcher counts nothing; it is added to the daily totals only as a scanner", async () => {
    for (const ua of ["facebookexternalhit/1.1", "WhatsApp/2.23.20.0 A", "Twitterbot/1.0", null]) {
      expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: ua, now: NOW, step: "opened" })).toBeNull();
      expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: ua, now: NOW, step: "started" })).toBeNull();
    }
    expect(counterCalls()).toHaveLength(0);
    const rows = dailyCalls().map((c) => Object.fromEntries(DAILY_COLUMNS.map((k, i) => [k, c.values[i]])));
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toMatchObject({ code: "fb-sutton", scanner: true });
  });

  it("stores nothing about the person: only the bucket, the day and the step are bound", async () => {
    await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW, step: "opened" });
    expect(JSON.stringify(upsertValues())).not.toContain("iPhone");
  });

  it("a database error is logged and swallowed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.db.$executeRaw.mockRejectedValue(new Error("pool down"));
    await expect(recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: PERSON, now: NOW, step: "opened" })).resolves.toBeNull();
    dbMock.db.poolCampaign.findFirst.mockRejectedValue(new Error("pool down"));
    await expect(recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW, step: "opened" })).resolves.toBeNull();
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const c of warn.mock.calls) expect(String(c[0])).toContain("[pool-funnel]");
    warn.mockRestore();
  });
});

describe("recordPoolVisit: the daily totals by category (2026-11-16)", () => {
  it("one more for the open's code, London day, in-app browser and scanner flag, and nothing else: no browser, device or interaction type", async () => {
    await recordPoolVisit({
      source: { campaignCode: "fb-sutton", referralCode: null },
      userAgent: PERSON,
      now: new Date("2026-11-03T23:34:56.789Z"),
      step: "opened",
    });
    expect(dailyRow()).toEqual({ code: "fb-sutton", day: "2026-11-03", inApp: "none", scanner: false });
  });

  it("a friend's link: under _referral, and never the friend's code, the user agent or the time of day", async () => {
    await recordPoolVisit({ source: { campaignCode: null, referralCode: "AB12cd" }, userAgent: PERSON, now: new Date("2026-11-03T12:34:56Z"), step: "opened" });
    expect(dailyRow()).toMatchObject({ code: POOL_VISIT_REFERRAL });
    const stored = JSON.stringify(dailyCalls()[0].values);
    for (const secret of ["AB12cd", "iPhone", "Mozilla", "Safari", "safari", "mobile", "12:34", "T12", "key", "opened"]) expect(stored).not.toContain(secret);
  });

  it("a failed total never costs the count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.db.$executeRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      if (strings.join("").includes('"PoolVisitDaily"')) throw new Error('relation "PoolVisitDaily" does not exist');
      return 1;
    });
    expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW, step: "opened" })).toBe("fb-sutton");
    expect(upsertValues()).toEqual(["fb-sutton", "2026-11-03", "opened"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("[pool-funnel]");
    warn.mockRestore();
  });

  it("a failed count still adds the total", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.db.$executeRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      if (strings.join("").includes('"PoolCampaignVisit"')) throw new Error("pool down");
      return 1;
    });
    expect(await recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: PERSON, now: NOW, step: "opened" })).toBeNull();
    expect(dailyRow()).toMatchObject({ code: POOL_VISIT_DIRECT, scanner: false });
    warn.mockRestore();
  });
});

describe("purgeOldPoolVisitDaily: the daily cron deletes the totals after 90 days", () => {
  it("deletes every day's totals from before 90 days ago", async () => {
    dbMock.db.poolVisitDaily.deleteMany.mockResolvedValue({ count: 7 });
    expect(await purgeOldPoolVisitDaily(new Date("2026-11-13T06:00:00Z"))).toBe(7);
    expect(dbMock.db.poolVisitDaily.deleteMany).toHaveBeenCalledWith({ where: { day: { lt: new Date("2026-08-15T00:00:00Z") } } });
  });

  it("a failure (the table not migrated yet) is 0, never a throw into the cron", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    dbMock.db.poolVisitDaily.deleteMany.mockRejectedValue(new Error('relation "PoolVisitDaily" does not exist'));
    expect(await purgeOldPoolVisitDaily(new Date("2026-11-13T06:00:00Z"))).toBe(0);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

describe("recordPoolVisit: nothing per visit in the server log (round 3 of #607)", () => {
  it("a counted visit, a fetcher, a friend's link or a user agent with a line break: no info line at all", async () => {
    await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW, step: "started" });
    await recordPoolVisit({ source: { campaignCode: "fb", referralCode: null }, userAgent: "facebookexternalhit/1.1", now: NOW, step: "opened" });
    await recordPoolVisit({ source: { campaignCode: null, referralCode: "AB12cd" }, userAgent: PERSON, now: NOW, step: "opened" });
    await recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: 'Evil "x"\nnext', now: NOW, step: "opened" });
    expect(info).not.toHaveBeenCalled();
  });

  it("a failure is still a warning, with the error and no visitor detail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.db.$executeRaw.mockRejectedValue(new Error("pool down"));
    await recordPoolVisit({ source: { campaignCode: null, referralCode: "AB12cd" }, userAgent: PERSON, now: NOW, step: "opened" });
    const logged = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).toContain("pool down");
    expect(logged).not.toMatch(/AB12cd|Mozilla|iPhone/);
    warn.mockRestore();
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
  it("a staff test sign-up (2026-11-16) is not counted", async () => {
    expect(await recordPoolSignupSent({ source: "campaign", sourceCode: "fb-sutton", staffTest: true }, NOW)).toBeNull();
    expect(await recordPoolSignupSent({ source: "web", sourceCode: null, staffTest: true }, NOW)).toBeNull();
    expect(dbMock.db.$executeRaw).not.toHaveBeenCalled();
    expect(await recordPoolSignupSent({ source: "web", sourceCode: null, staffTest: false }, NOW)).toBe(POOL_VISIT_DIRECT);
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
    dbMock.db.poolProfile.findUnique.mockResolvedValue({ source: "campaign", sourceCode: "fb-sutton", staffTest: false });
    expect(await recordPoolSignupConfirmed("p1", NOW)).toBe("fb-sutton");
    expect(dbMock.db.poolProfile.findUnique).toHaveBeenCalledWith({ where: { id: "p1" }, select: { source: true, sourceCode: true, staffTest: true } });
    expect(upsertValues()).toEqual(["fb-sutton", "2026-11-03", "confirmed"]);
  });
  it("a friend link's sign-up, or a profile that is gone, writes nothing", async () => {
    dbMock.db.poolProfile.findUnique.mockResolvedValueOnce({ source: "friend", sourceCode: null, staffTest: false }).mockResolvedValueOnce(null);
    expect(await recordPoolSignupConfirmed("p1", NOW)).toBeNull();
    expect(await recordPoolSignupConfirmed("p2", NOW)).toBeNull();
    expect(dbMock.db.$executeRaw).not.toHaveBeenCalled();
  });
  // The confirm comes later, by WhatsApp, where no cookie exists: the flag
  // the sign-up stored is what says it was a staff test (2026-11-16).
  it("a staff test sign-up is not counted as confirmed", async () => {
    dbMock.db.poolProfile.findUnique.mockResolvedValue({ source: "campaign", sourceCode: "fb-sutton", staffTest: true });
    expect(await recordPoolSignupConfirmed("p1", NOW)).toBeNull();
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
