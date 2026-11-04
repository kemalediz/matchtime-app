/**
 * HIS TIMES AND FORMATS, ASKED ON WHATSAPP (2026-11-04): the I/O adapter.
 * The rules are `details-rules.test.ts`. Here: which days the welcome asks
 * about, the one later question (opted-in only, once, at a civil hour, low
 * rate), the question the reader is shown, and that his answer is saved
 * through the manage page's own validator and writer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  poolAvailability: { findMany: vi.fn() },
  poolProfile: { findMany: vi.fn(), findUnique: vi.fn() },
  sentNotification: { findMany: vi.fn(), create: vi.fn() },
  platformJob: { findMany: vi.fn() },
}));
vi.mock("../../db", () => ({ db: dbMock }));
vi.mock("../links", () => ({ buildPoolManageLink: async (id: string) => `https://m/r/${id}` }));
const q = vi.hoisted(() => ({ queueOnce: vi.fn() }));
vi.mock("../queue-once", () => q);
const manage = vi.hoisted(() => ({ savePoolFields: vi.fn(), savedPoolSportKeys: vi.fn() }));
vi.mock("../manage", () => manage);

import { detailsQuestionDays, loadDetailsAsk, saveDetailsFromWords, sweepPoolDetailsAsks } from "../details";
import { POOL_DETAILS } from "../details-rules";

const DAY = 24 * 3600_000;
const NOW = new Date("2026-11-10T06:00:00Z"); // 06:00 London (GMT)
const WHOLE = (day: number) => ({ day, fromMin: 0, toMin: 1440 });
const football = { sport: "football", otherName: "", formats: [], level: null, levelText: null };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.sentNotification.findMany.mockResolvedValue([]);
  dbMock.sentNotification.create.mockResolvedValue({});
  dbMock.platformJob.findMany.mockResolvedValue([]);
  q.queueOnce.mockResolvedValue(true);
  manage.savePoolFields.mockResolvedValue({ ok: true });
  manage.savedPoolSportKeys.mockResolvedValue(["football:"]);
});

describe("the welcome's question", () => {
  it("names his days while every one is the short form's whole day", async () => {
    dbMock.poolAvailability.findMany.mockResolvedValue([WHOLE(2), WHOLE(6)]);
    expect(await detailsQuestionDays("p1")).toEqual([2, 6]);
  });
  it("is left out once he gave hours (the full form, the manage page, a member's join)", async () => {
    dbMock.poolAvailability.findMany.mockResolvedValue([{ day: 2, fromMin: 19 * 60, toMin: 22 * 60 }]);
    expect(await detailsQuestionDays("p1")).toBeNull();
  });
});

describe("the one later question", () => {
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    userId: `u-${id}`,
    status: "active",
    consentAt: new Date(NOW.getTime() - 4 * DAY),
    displayName: "Ali Kaya",
    language: "en",
    user: { phoneNumber: "+447700900111" },
    availability: [WHOLE(2), WHOLE(6)],
    ...over,
  });

  it("asks only active, consented profiles 3 to 30 days old, with his own number", async () => {
    dbMock.poolProfile.findMany.mockResolvedValue([]);
    await sweepPoolDetailsAsks(NOW);
    const where = dbMock.poolProfile.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("active");
    expect(where.consentAt.lte).toEqual(new Date(NOW.getTime() - 3 * DAY));
    expect(where.consentAt.gte).toEqual(new Date(NOW.getTime() - 30 * DAY));
  });

  it("queues his question once, by its refId, held to 18:00 London, in his words", async () => {
    dbMock.poolProfile.findMany.mockResolvedValue([row("a")]);
    expect(await sweepPoolDetailsAsks(NOW)).toBe(1);
    const [phone, text, purpose, refId, sendAfter] = q.queueOnce.mock.calls[0];
    expect(phone).toBe("447700900111");
    expect(purpose).toBe("pool-details-ask");
    expect(refId).toBe("pool-details-ask:a");
    expect(sendAfter).toEqual(new Date("2026-11-10T18:00:00Z"));
    expect(text).toMatch(/^Ali, one quick question/);
    expect(text).toContain("Tuesday and Saturday");
    expect(text).toContain("https://m/r/u-a");
  });

  it("never asks someone who answered, was asked already, or gave hours", async () => {
    dbMock.poolProfile.findMany.mockResolvedValue([row("a"), row("b"), row("c", { availability: [{ day: 2, fromMin: 1140, toMin: 1440 }] }), row("d", { user: { phoneNumber: null } })]);
    dbMock.sentNotification.findMany.mockResolvedValue([{ key: "pool-details:a:answered" }]);
    dbMock.platformJob.findMany.mockResolvedValue([{ refId: "pool-details-ask:b" }]);
    expect(await sweepPoolDetailsAsks(NOW)).toBe(0);
    expect(q.queueOnce).not.toHaveBeenCalled();
  });

  it("goes at most perRun a day (low rate)", async () => {
    dbMock.poolProfile.findMany.mockResolvedValue(Array.from({ length: POOL_DETAILS.perRun + 5 }, (_, i) => row(`p${i}`)));
    expect(await sweepPoolDetailsAsks(NOW)).toBe(POOL_DETAILS.perRun);
  });

  it("after 18:00 it goes at once rather than tomorrow's", async () => {
    dbMock.poolProfile.findMany.mockResolvedValue([row("a")]);
    await sweepPoolDetailsAsks(new Date("2026-11-10T19:00:00Z"));
    expect(q.queueOnce.mock.calls[0][4]).toBeNull();
  });
});

describe("the question the reader is shown", () => {
  it("is his newest delivered question on his number; the welcome only while his hours are pending", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([{ text: "later", sentAt: new Date("2026-11-09T18:00:00Z"), createdAt: new Date("2026-11-09T06:00:00Z"), waMessageId: "wa-2" }]);
    expect(await loadDetailsAsk("p1", "447700900111", null, true)).toEqual({ sentAt: new Date("2026-11-09T18:00:00Z"), text: "later", quoted: false });
    const where = dbMock.platformJob.findMany.mock.calls[0][0].where;
    expect(where.phone).toBe("447700900111");
    expect(where.OR).toEqual([
      { purpose: "pool-details-ask", refId: "pool-details-ask:p1" },
      { purpose: "pool-welcome", refId: "pool-welcome:p1" },
    ]);
    await loadDetailsAsk("p1", "447700900111", null, false);
    expect(dbMock.platformJob.findMany.mock.calls[1][0].where.OR).toEqual([{ purpose: "pool-details-ask", refId: "pool-details-ask:p1" }]);
  });
  it("a swipe-reply picks the one he quoted", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([
      { text: "later", sentAt: new Date("2026-11-09T18:00:00Z"), createdAt: new Date(), waMessageId: "wa-2" },
      { text: "welcome", sentAt: new Date("2026-11-06T18:00:00Z"), createdAt: new Date(), waMessageId: "wa-1" },
    ]);
    expect(await loadDetailsAsk("p1", "447700900111", "wa-1", true)).toMatchObject({ text: "welcome", quoted: true });
  });
  it("none delivered: null", async () => {
    expect(await loadDetailsAsk("p1", "447700900111", null, true)).toBeNull();
  });
});

describe("saving his answer", () => {
  const profile = {
    id: "p1",
    status: "active",
    displayName: "Ali K",
    areaDistrict: "SM1",
    maxMiles: 3,
    language: "en",
    availability: [WHOLE(2), WHOLE(6)],
    sports: [football],
  };
  const said = { hours: [{ day: 2, from: "19:00", to: "24:00" }], notDays: [], formats: [5, 7], anyFormat: false, level: null };

  it("goes through the manage page's validator and writer, keeps everything else, and marks him answered", async () => {
    dbMock.poolProfile.findUnique.mockResolvedValue(profile);
    const out = await saveDetailsFromWords("ali", said, NOW);
    expect(manage.savePoolFields).toHaveBeenCalledWith(
      "ali",
      expect.objectContaining({
        displayName: "Ali K",
        areaDistrict: "SM1",
        maxMiles: 3,
        availability: [
          { day: 2, fromMin: 19 * 60, toMin: 1440 },
          { day: 6, fromMin: 0, toMin: 1440 },
        ],
        sports: [{ sport: "football", otherName: "", formats: [5, 7], level: null, levelText: null }],
      }),
      NOW,
    );
    expect(dbMock.sentNotification.create).toHaveBeenCalledWith({ data: { key: "pool-details:p1:answered", kind: "pool-details" } });
    expect(out).toEqual({ days: [{ day: 2, any: false, ranges: [{ from: "19:00", to: "24:00" }] }, { day: 6, any: true, ranges: [] }], formats: [5, 7] });
  });

  it("'any time, any format' changes nothing but still counts as his answer", async () => {
    dbMock.poolProfile.findUnique.mockResolvedValue(profile);
    const out = await saveDetailsFromWords("ali", { hours: [], notDays: [], formats: [], anyFormat: true, level: null }, NOW);
    expect(manage.savePoolFields).not.toHaveBeenCalled();
    expect(dbMock.sentNotification.create).toHaveBeenCalled();
    expect(out?.formats).toEqual([]);
  });

  it("nothing for a stopped or missing profile, or a save the writer refused", async () => {
    dbMock.poolProfile.findUnique.mockResolvedValue({ ...profile, status: "stopped" });
    expect(await saveDetailsFromWords("ali", said, NOW)).toBeNull();
    dbMock.poolProfile.findUnique.mockResolvedValue(null);
    expect(await saveDetailsFromWords("ali", said, NOW)).toBeNull();
    dbMock.poolProfile.findUnique.mockResolvedValue(profile);
    manage.savePoolFields.mockResolvedValue({ ok: false, reason: "no-profile" });
    expect(await saveDetailsFromWords("ali", said, NOW)).toBeNull();
    expect(dbMock.sentNotification.create).not.toHaveBeenCalled();
  });
});
