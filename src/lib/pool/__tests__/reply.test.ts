/**
 * A reply in words to a pool offer: the I/O adapter (slices L5a and L6).
 * The rules are `reply-rules.test.ts`; the reader `reply-reader.test.ts`.
 * Here: what is loaded (only offers that REACHED him, on his number), when
 * the reader is asked at all, and that each answer goes through the tap
 * link's own writers, with every line rate-limited.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  poolProfile: { findUnique: vi.fn(), updateMany: vi.fn() },
  poolOffer: { findMany: vi.fn(), findUnique: vi.fn() },
  platformJob: { findMany: vi.fn() },
  attendance: { findMany: vi.fn() },
  membership: { findFirst: vi.fn() },
  botJob: { count: vi.fn() },
  sentNotification: { create: vi.fn() },
}));
vi.mock("../../db", () => ({ db: dbMock }));
vi.mock("../../ai-budget", () => ({ withOrgAiBudget: (_k: string, fn: () => Promise<unknown>) => fn() }));
const queue = vi.hoisted(() => ({ queuePlatformDm: vi.fn() }));
vi.mock("../../platform-jobs", () => queue);
vi.mock("../links", () => ({ buildPoolManageLink: async () => "https://m/r/x" }));
const reader = vi.hoisted(() => ({ readPoolReply: vi.fn() }));
vi.mock("../reply-reader", () => reader);
const writers = vi.hoisted(() => ({ acceptOffer: vi.fn(), declineOffer: vi.fn(), pullOutOfOffer: vi.fn() }));
vi.mock("../accept", () => writers);
const manage = vi.hoisted(() => ({ applyManageAction: vi.fn() }));
vi.mock("../manage", () => manage);
vi.mock("../offer-facts", () => ({
  loadMatchOfferFacts: async () => ({
    club: "Newer FC",
    sport: "football",
    format: 7,
    kickoff: new Date("2026-10-27T20:00:00Z"),
    durationMins: 60,
    venueName: "Goals North Cheam",
    address: null,
    mapUrl: null,
    playStyle: null,
    members: 0,
    gamesLast8Weeks: 0,
    fee: null,
    orgId: "org-new",
    language: "en",
  }),
}));

import { answerPoolOfferReply } from "../reply";

const NOW = new Date("2026-10-27T12:00:00Z");
const HIS = "447700900111";
const live = { date: new Date(NOW.getTime() + 8 * 3600_000), status: "UPCOMING", isHistorical: false };
const newOffer = {
  id: "new",
  orgId: "org-new",
  matchId: "m-new",
  outcome: null,
  sentAt: new Date(NOW.getTime() - 3600_000),
  expiresAt: new Date(NOW.getTime() + 3600_000),
  platformJobId: "j-new",
  ask: { status: "open", org: { name: "Newer FC" }, match: live },
};
const oldOffer = {
  id: "old",
  orgId: "org-old",
  matchId: "m-old",
  outcome: "expired",
  sentAt: new Date(NOW.getTime() - 5 * 3600_000),
  expiresAt: new Date(NOW.getTime() - 3600_000),
  platformJobId: "j-old",
  ask: { status: "filled", org: { name: "Older FC" }, match: live },
};
const reading = (intent: string, confidence = 0.95) => reader.readPoolReply.mockResolvedValue({ intent, confidence, reasoning: "t" });
const texts = () => queue.queuePlatformDm.mock.calls.map((c) => c[0].text as string);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET ||= "test-secret-for-reply";
  dbMock.poolProfile.findUnique.mockResolvedValue({ status: "active", language: "en", user: { phoneNumber: `+${HIS}` } });
  dbMock.poolOffer.findMany.mockResolvedValue([newOffer, oldOffer]);
  dbMock.poolOffer.findUnique.mockResolvedValue({ distanceMiles: 1.8, ask: { places: 1 } });
  dbMock.platformJob.findMany.mockResolvedValue([
    { id: "j-new", waMessageId: "wa-new", text: "⚽ *Newer FC* needs 1 player", phone: HIS },
    { id: "j-old", waMessageId: "wa-old", text: "⚽ *Older FC* needs 1 player", phone: HIS },
  ]);
  dbMock.attendance.findMany.mockResolvedValue([]);
  dbMock.membership.findFirst.mockResolvedValue(null);
  dbMock.botJob.count.mockResolvedValue(0);
  dbMock.sentNotification.create.mockResolvedValue({});
  writers.acceptOffer.mockResolvedValue("in");
  writers.declineOffer.mockResolvedValue("declined");
  manage.applyManageAction.mockResolvedValue({ ok: true });
  reading("neither");
});

const fromHim = { userId: "ali", phone: HIS, now: NOW, waMessageId: "wamid-1" };

describe("what is loaded, and when the reader is asked", () => {
  it("nothing delivered: null, and no model", async () => {
    dbMock.poolOffer.findMany.mockResolvedValue([]);
    expect(await answerPoolOfferReply({ ...fromHim, text: "yes" })).toBeNull();
    expect(reader.readPoolReply).not.toHaveBeenCalled();
  });
  it("no pool profile: null, and no model", async () => {
    dbMock.poolProfile.findUnique.mockResolvedValue(null);
    expect(await answerPoolOfferReply({ ...fromHim, text: "yes" })).toBeNull();
    expect(reader.readPoolReply).not.toHaveBeenCalled();
  });
  it("an offer that went to another number is not his to answer from this one", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([{ id: "j-new", waMessageId: "wa-new", text: "x", phone: "447700900999" }]);
    dbMock.poolOffer.findMany.mockResolvedValue([newOffer]);
    expect(await answerPoolOfferReply({ ...fromHim, text: "yes" })).toBeNull();
    expect(reader.readPoolReply).not.toHaveBeenCalled();
  });
  it("a member quoting the OLDER offer is read and answered about that one", async () => {
    dbMock.membership.findFirst.mockResolvedValue({ org: { name: "Sutton FC" } });
    expect(await answerPoolOfferReply({ ...fromHim, text: "still on?", quotedId: "wa-old" })).toBe("pool-offer-gone");
    expect(reader.readPoolReply.mock.calls[0][1]).toMatchObject({ ownClub: "Sutton FC", quotedIndex: 0, offers: [{ state: "ended" }] });
    expect(texts()[0]).toContain("Older FC");
    expect(queue.queuePlatformDm.mock.calls[0][0].refId).toBe("old");
  });
  it("a member's plain DM after a club DM to him: left to his club, no model", async () => {
    dbMock.membership.findFirst.mockResolvedValue({ org: { name: "Sutton FC" } });
    dbMock.botJob.count.mockResolvedValue(1);
    expect(await answerPoolOfferReply({ ...fromHim, text: "is Tuesday on?" })).toBeNull();
    expect(reader.readPoolReply).not.toHaveBeenCalled();
  });
  it("a member's plain 'neither' DM carries on, nothing sent", async () => {
    dbMock.membership.findFirst.mockResolvedValue({ org: { name: "Sutton FC" } });
    expect(await answerPoolOfferReply({ ...fromHim, text: "what time do we play?" })).toBeNull();
    expect(queue.queuePlatformDm).not.toHaveBeenCalled();
  });
});

describe("each answer goes through the tap link's own writers", () => {
  it("a yes from his own number: acceptOffer by words; the match details DM is acceptOffer's", async () => {
    reading("accept");
    expect(await answerPoolOfferReply({ ...fromHim, text: "yes please" })).toBe("pool-reply-accept");
    expect(writers.acceptOffer).toHaveBeenCalledWith("new", NOW, undefined, "words");
    expect(queue.queuePlatformDm).not.toHaveBeenCalled();
    expect(dbMock.poolProfile.updateMany).toHaveBeenCalled();
  });
  it("a yes that lost the race: told the place has gone", async () => {
    reading("accept");
    writers.acceptOffer.mockResolvedValue("gone");
    await answerPoolOfferReply({ ...fromHim, text: "yes" });
    expect(texts()[0]).toMatch(/^Sorry, this place has gone\./);
  });
  it("a yes from a number that is not his (display-name match): nothing booked, the tap link", async () => {
    reading("accept");
    expect(await answerPoolOfferReply({ ...fromHim, phone: "447700900222", text: "yes" })).toBe("pool-offer-tap-link");
    expect(writers.acceptOffer).not.toHaveBeenCalled();
    expect(texts()[0]).toMatch(/^To answer the offer, tap the link: /);
  });
  it("a no: declineOffer by words (the 14-day cooldown is the outcome), and one thank-you", async () => {
    reading("decline");
    expect(await answerPoolOfferReply({ ...fromHim, text: "no thanks" })).toBe("pool-reply-decline");
    expect(writers.declineOffer).toHaveBeenCalledWith("new", NOW, "words");
    expect(texts()[0]).toMatch(/^Thanks for letting us know\./);
  });
  it("stop: the manage page's stop, its evidence his WhatsApp message", async () => {
    reading("stop");
    expect(await answerPoolOfferReply({ ...fromHim, text: "stop sending these" })).toBe("pool-reply-stop");
    expect(manage.applyManageAction).toHaveBeenCalledWith("ali", "stop", { now: NOW, via: { channel: "whatsapp", waMessageId: "wamid-1" } });
    expect(texts()[0]).toMatch(/^Done, I've stopped game offers\./);
  });
  it("a question: the offer's facts and the link, at most three times", async () => {
    reading("question");
    expect(await answerPoolOfferReply({ ...fromHim, text: "where is it?" })).toBe("pool-reply-facts");
    expect(texts()[0]).toMatch(/^Here's everything I know about this game:\n⚽ \*Newer FC\*/);
    expect(texts()[0]).toContain("Goals North Cheam");
    dbMock.sentNotification.create.mockRejectedValue(new Error("unique"));
    expect(await answerPoolOfferReply({ ...fromHim, text: "and parking?" })).toBeNull();
  });
  it("unsure: one re-ask with the link; unsure again: today's one line; then nothing", async () => {
    reading("accept", 0.5);
    expect(await answerPoolOfferReply({ ...fromHim, text: "hmm" })).toBe("pool-reply-reask");
    expect(texts()[0]).toMatch(/^Sorry, I didn't quite get that\./);
    dbMock.sentNotification.create.mockImplementation(async ({ data }: { data: { key: string } }) => {
      if (data.key.endsWith(":reask")) throw new Error("unique");
      return {};
    });
    expect(await answerPoolOfferReply({ ...fromHim, text: "hmm hmm" })).toBe("pool-offer-tap-link");
    dbMock.sentNotification.create.mockRejectedValue(new Error("unique"));
    expect(await answerPoolOfferReply({ ...fromHim, text: "hmm hmm hmm" })).toBeNull();
  });
  it("never throws: a failed read is the route carrying on", async () => {
    dbMock.poolOffer.findMany.mockRejectedValue(new Error("db down"));
    expect(await answerPoolOfferReply({ ...fromHim, text: "yes" })).toBeNull();
  });
});
