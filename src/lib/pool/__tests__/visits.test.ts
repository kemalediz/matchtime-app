/**
 * Recording the /play sign-up funnel (visits 2026-11-03, every step
 * 2026-11-04), the thin I/O half: a fetcher counts nothing, each step adds
 * one to its bucket's day with ONE atomic upsert, and a failure is logged
 * and swallowed (a count must never break or slow the page, the sign-up or
 * the confirm). Nothing about the person is stored: no address, no user
 * agent, no id, only the bucket, the day, the step and the count.
 *
 * The breakdown (2026-11-16, daily totals only): each OPEN also adds one
 * to a daily total by trigger, in-app browser and scanner flag
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

const DAILY_COLUMNS = ["code", "day", "step", "trigger", "inApp", "scanner"];

/** The bound values of the one daily total upsert, by column. */
function dailyRow(): Record<string, unknown> {
  const calls = dailyCalls();
  expect(calls).toHaveLength(1);
  const cols = `"code", "day", "step", "trigger", "inApp", "scanner"`;
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
    expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW, step: "opened", trigger: "touch" })).toBe("fb-sutton");
    expect(dbMock.db.poolCampaign.findFirst).toHaveBeenCalledWith({ where: { code: "fb-sutton", active: true }, select: { code: true } });
    expect(upsertValues()).toEqual(["fb-sutton", "2026-11-03", "opened"]);
  });

  it("started counts under the same bucket, on its own step, and is added to no breakdown (the counters already count it)", async () => {
    expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW, step: "started", trigger: "none" })).toBe("fb-sutton");
    expect(upsertValues()).toEqual(["fb-sutton", "2026-11-03", "started"]);
    expect(dailyCalls()).toHaveLength(0);
  });

  it("plain /play: direct, and no lookup at all", async () => {
    expect(await recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: PERSON, now: NOW, step: "opened", trigger: "scroll" })).toBe(POOL_VISIT_DIRECT);
    expect(dbMock.db.poolCampaign.findFirst).not.toHaveBeenCalled();
    expect(dbMock.db.poolProfile.findUnique).not.toHaveBeenCalled();
    expect(upsertValues()).toEqual([POOL_VISIT_DIRECT, "2026-11-03", "opened"]);
  });

  it("a switched-off or unknown code: direct", async () => {
    dbMock.db.poolCampaign.findFirst.mockResolvedValue(null);
    expect(await recordPoolVisit({ source: { campaignCode: "old", referralCode: null }, userAgent: PERSON, now: NOW, step: "opened", trigger: "key" })).toBe(POOL_VISIT_DIRECT);
  });

  it("a friend's link: referral, when the share code is a confirmed player's (as the sign-up checks)", async () => {
    expect(await recordPoolVisit({ source: { campaignCode: null, referralCode: "AB12cd" }, userAgent: PERSON, now: NOW, step: "opened", trigger: "key" })).toBe(POOL_VISIT_REFERRAL);
    expect(dbMock.db.poolProfile.findUnique).toHaveBeenCalledWith({ where: { shareCode: "AB12cd" }, select: { userId: true } });
  });

  it("a share code nobody holds falls through to the live campaign, as the sign-up does", async () => {
    dbMock.db.poolProfile.findUnique.mockResolvedValue(null);
    expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: "zzzzzz" }, userAgent: PERSON, now: NOW, step: "opened", trigger: "key" })).toBe("fb-sutton");
  });

  it("a link preview fetcher counts nothing; it is added to the daily totals only as a scanner", async () => {
    for (const ua of ["facebookexternalhit/1.1", "WhatsApp/2.23.20.0 A", "Twitterbot/1.0", null]) {
      expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: ua, now: NOW, step: "opened", trigger: "touch" })).toBeNull();
      expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: ua, now: NOW, step: "started", trigger: "none" })).toBeNull();
    }
    expect(counterCalls()).toHaveLength(0);
    const rows = dailyCalls().map((c) => Object.fromEntries(DAILY_COLUMNS.map((k, i) => [k, c.values[i]])));
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toMatchObject({ code: "fb-sutton", step: "opened", scanner: true });
  });

  it("stores nothing about the person: only the bucket, the day and the step are bound", async () => {
    await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW, step: "opened", trigger: "touch" });
    expect(JSON.stringify(upsertValues())).not.toContain("iPhone");
  });

  it("a database error is logged and swallowed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.db.$executeRaw.mockRejectedValue(new Error("pool down"));
    await expect(recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: PERSON, now: NOW, step: "opened", trigger: "touch" })).resolves.toBeNull();
    dbMock.db.poolCampaign.findFirst.mockRejectedValue(new Error("pool down"));
    await expect(recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW, step: "opened", trigger: "touch" })).resolves.toBeNull();
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const c of warn.mock.calls) expect(String(c[0])).toContain("[pool-funnel]");
    warn.mockRestore();
  });
});

describe("recordPoolVisit: the daily totals by category (2026-11-16)", () => {
  it("one more for the open's code, London day, trigger, in-app browser and scanner flag, and nothing else: no browser, no device", async () => {
    await recordPoolVisit({
      source: { campaignCode: "fb-sutton", referralCode: null },
      userAgent: PERSON,
      now: new Date("2026-11-03T23:34:56.789Z"),
      step: "opened",
      trigger: "scroll",
    });
    expect(dailyRow()).toEqual({
      code: "fb-sutton",
      day: "2026-11-03",
      step: "opened",
      trigger: "scroll",
      inApp: "none",
      scanner: false,
    });
  });

  it("a friend's link: under _referral, and never the friend's code, the user agent or the time of day", async () => {
    await recordPoolVisit({ source: { campaignCode: null, referralCode: "AB12cd" }, userAgent: PERSON, now: new Date("2026-11-03T12:34:56Z"), step: "opened", trigger: "key" });
    expect(dailyRow()).toMatchObject({ code: POOL_VISIT_REFERRAL, step: "opened", trigger: "key" });
    const stored = JSON.stringify(dailyCalls()[0].values);
    for (const secret of ["AB12cd", "iPhone", "Mozilla", "Safari", "safari", "mobile", "12:34", "T12"]) expect(stored).not.toContain(secret);
  });

  it("a failed total never costs the count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.db.$executeRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      if (strings.join("").includes('"PoolVisitDaily"')) throw new Error('relation "PoolVisitDaily" does not exist');
      return 1;
    });
    expect(await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW, step: "opened", trigger: "touch" })).toBe("fb-sutton");
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
    expect(await recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: PERSON, now: NOW, step: "opened", trigger: "touch" })).toBeNull();
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

describe("recordPoolVisit: one server log line per beacon, the kept categories only (2026-11-06, 2026-11-16)", () => {
  const lines = () => info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[pool-funnel] beacon "));

  it("counted: the step, the bucket, the trigger, the in-app browser, the scanner flag; never the user agent", async () => {
    await recordPoolVisit({ source: { campaignCode: "fb-sutton", referralCode: null }, userAgent: PERSON, now: NOW, step: "started", trigger: "none" });
    expect(lines()).toEqual(["[pool-funnel] beacon step=started code=fb-sutton trigger=none inApp=none scanner=no result=counted"]);
    for (const secret of ["Mozilla", "iPhone", "Safari", "ua="]) expect(lines()[0]).not.toContain(secret);
  });

  it("a link preview fetcher: filtered, as a scanner, and nothing counted", async () => {
    await recordPoolVisit({ source: { campaignCode: "fb", referralCode: null }, userAgent: "facebookexternalhit/1.1", now: NOW, step: "opened", trigger: "touch" });
    expect(lines()).toEqual(["[pool-funnel] beacon step=opened code=fb trigger=touch inApp=none scanner=yes result=fetcher"]);
    expect(counterCalls()).toHaveLength(0);
  });

  it("no user agent at all, plain /play: filtered as a scanner", async () => {
    await recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: null, now: NOW, step: "opened", trigger: "touch" });
    expect(lines()).toEqual(["[pool-funnel] beacon step=opened code=_direct trigger=touch inApp=none scanner=yes result=fetcher"]);
  });

  it("a friend's link: only its bucket, never the code itself", async () => {
    await recordPoolVisit({ source: { campaignCode: null, referralCode: "AB12cd" }, userAgent: PERSON, now: NOW, step: "opened", trigger: "touch" });
    expect(lines()).toEqual(["[pool-funnel] beacon step=opened code=_referral trigger=touch inApp=none scanner=no result=counted"]);
  });

  it("a failed count is logged as failed; a failed lookup has no bucket", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.db.$executeRaw.mockRejectedValue(new Error("pool down"));
    await recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: PERSON, now: NOW, step: "opened", trigger: "touch" });
    dbMock.db.poolCampaign.findFirst.mockRejectedValue(new Error("pool down"));
    await recordPoolVisit({ source: { campaignCode: "fb", referralCode: null }, userAgent: PERSON, now: NOW, step: "opened", trigger: "key" });
    expect(lines()).toEqual([
      "[pool-funnel] beacon step=opened code=_direct trigger=touch inApp=none scanner=no result=failed",
      "[pool-funnel] beacon step=opened code=- trigger=key inApp=none scanner=no result=failed",
    ]);
    warn.mockRestore();
  });

  it("a user agent with quotes or a line break never reaches the log", async () => {
    await recordPoolVisit({ source: { campaignCode: null, referralCode: null }, userAgent: 'Evil "x"\nnext', now: NOW, step: "opened", trigger: "touch" });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).not.toMatch(/Evil|next|\n/);
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
