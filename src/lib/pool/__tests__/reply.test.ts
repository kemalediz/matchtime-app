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
  // No friend-link places here (friend link, 2026-11-01).
  friendLink: { findMany: vi.fn(async () => []) },
  platformJob: { findMany: vi.fn() },
  attendance: { findMany: vi.fn() },
  membership: { findFirst: vi.fn() },
  botJob: { count: vi.fn() },
  sentNotification: { create: vi.fn() },
}));
vi.mock("../../db", () => ({ db: dbMock }));
vi.mock("../../ai-budget", () => ({ withOrgAiBudget: (_k: string, fn: () => Promise<unknown>) => fn(), onboardingUserKey: (id: string) => `onboarding-user:${id}` }));
const queue = vi.hoisted(() => ({ queuePlatformDm: vi.fn() }));
vi.mock("../../platform-jobs", () => queue);
vi.mock("../links", () => ({ buildPoolManageLink: async () => "https://m/r/x" }));
const reader = vi.hoisted(() => ({ readPoolReply: vi.fn() }));
vi.mock("../reply-reader", () => reader);
const writers = vi.hoisted(() => ({ acceptOffer: vi.fn(), declineOffer: vi.fn(), pullOutOfOffer: vi.fn() }));
vi.mock("../accept", () => writers);
const manage = vi.hoisted(() => ({ applyManageAction: vi.fn() }));
vi.mock("../manage", () => manage);
const details = vi.hoisted(() => ({ loadDetailsAsk: vi.fn(), saveDetailsFromWords: vi.fn(), claimDetailsReask: vi.fn() }));
vi.mock("../details", async (orig) => ({ ...(await orig<typeof import("../details")>()), ...details }));
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
  details.loadDetailsAsk.mockResolvedValue(null);
  details.saveDetailsFromWords.mockResolvedValue(null);
  details.claimDetailsReask.mockResolvedValue(true);
  reading("neither");
});

const fromHim = { userId: "ali", phone: HIS, now: NOW, waMessageId: "wamid-1" };

describe("what is loaded, and when the reader is asked", () => {
  it("a club member with nothing delivered and no question about his times: null, and no model", async () => {
    dbMock.poolOffer.findMany.mockResolvedValue([]);
    dbMock.membership.findFirst.mockResolvedValue({ org: { name: "Sutton FC" } });
    expect(await answerPoolOfferReply({ ...fromHim, text: "yes" })).toBeNull();
    expect(reader.readPoolReply).not.toHaveBeenCalled();
  });
  it("someone in no club with nothing delivered is read for his times and formats; a neither is silence", async () => {
    dbMock.poolOffer.findMany.mockResolvedValue([]);
    expect(await answerPoolOfferReply({ ...fromHim, text: "thanks!" })).toBeNull();
    expect(reader.readPoolReply).toHaveBeenCalledTimes(1);
    expect(reader.readPoolReply.mock.calls[0][1]).toMatchObject({ offers: [], quotedIndex: null });
    expect(queue.queuePlatformDm).not.toHaveBeenCalled();
  });
  it("no pool profile: null, and no model", async () => {
    dbMock.poolProfile.findUnique.mockResolvedValue(null);
    expect(await answerPoolOfferReply({ ...fromHim, text: "yes" })).toBeNull();
    expect(reader.readPoolReply).not.toHaveBeenCalled();
  });
  it("an offer that went to another number is not his to answer from this one", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([{ id: "j-new", waMessageId: "wa-new", text: "x", phone: "447700900999" }]);
    dbMock.poolOffer.findMany.mockResolvedValue([newOffer]);
    dbMock.membership.findFirst.mockResolvedValue({ org: { name: "Sutton FC" } });
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

describe("proof by his number works for any country", () => {
  it("a Turkish number on the envelope as bare digits is his", async () => {
    dbMock.poolProfile.findUnique.mockResolvedValue({ status: "active", language: "tr", user: { phoneNumber: "+905321112233" } });
    dbMock.platformJob.findMany.mockResolvedValue([{ id: "j-new", waMessageId: "wa-new", text: "x", phone: "905321112233" }]);
    dbMock.poolOffer.findMany.mockResolvedValue([newOffer]);
    reading("accept");
    expect(await answerPoolOfferReply({ userId: "can", phone: "905321112233", text: "varım", now: NOW })).toBe("pool-reply-accept");
    expect(writers.acceptOffer).toHaveBeenCalled();
  });
});

describe("his times and formats, in his own words (2026-11-04)", () => {
  const SAID = { hours: [{ day: 2, from: "19:00", to: "24:00" }], notDays: [], formats: [5, 7], anyFormat: false, level: null };
  const SAVED = { days: [{ day: 2, any: false, ranges: [{ from: "19:00", to: "24:00" }] }, { day: 6, any: true, ranges: [] }], formats: [5, 7] };
  const said = (confidence = 0.95) => reader.readPoolReply.mockResolvedValue({ intent: "details", confidence, reasoning: "t", details: SAID });
  const profileRow = {
    id: "prof-1",
    status: "active",
    language: "en",
    user: { phoneNumber: `+${HIS}` },
    availability: [
      { day: 2, fromMin: 0, toMin: 1440 },
      { day: 6, fromMin: 0, toMin: 1440 },
    ],
    sports: [{ sport: "football", otherName: "", formats: [], level: null, levelText: null }],
  };
  const ASK = { sentAt: new Date(NOW.getTime() - 3600_000), text: "So I only send games that suit you: what times can you play on Tuesday and Saturday?", quoted: false };

  beforeEach(() => {
    dbMock.poolProfile.findUnique.mockResolvedValue(profileRow);
    dbMock.poolOffer.findMany.mockResolvedValue([]);
    details.loadDetailsAsk.mockResolvedValue(ASK);
    details.saveDetailsFromWords.mockResolvedValue(SAVED);
  });

  it("the reader is shown his profile and MatchTime's question, then his answer is saved and he is told what was saved", async () => {
    said();
    expect(await answerPoolOfferReply({ ...fromHim, text: "weekday evenings after 7, 5 or 7 a side" })).toBe("pool-details-saved");
    expect(details.loadDetailsAsk).toHaveBeenCalledWith("prof-1", HIS, null, true);
    expect(reader.readPoolReply.mock.calls[0][1]).toMatchObject({
      offers: [],
      detailsAsk: { sentAt: ASK.sentAt, text: ASK.text },
      quotedAsk: false,
      profile: { days: [{ day: 2, any: true }, { day: 6, any: true }], formats: [], level: null },
    });
    expect(details.saveDetailsFromWords).toHaveBeenCalledWith("ali", SAID, NOW);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toMatch(/^✅ Got it, saved: Tuesday from 19:00 and Saturday any time\. Formats: 5 and 7-a-side\./);
    expect(queue.queuePlatformDm.mock.calls[0][0]).toMatchObject({ phone: HIS, purpose: "pool-reply" });
  });

  it("a club member is read only while he answers the question, and saved the same way", async () => {
    dbMock.membership.findFirst.mockResolvedValue({ org: { name: "Sutton FC" } });
    said();
    expect(await answerPoolOfferReply({ ...fromHim, text: "Tue and Thu from 8" })).toBe("pool-details-saved");
    expect(reader.readPoolReply.mock.calls[0][1]).toMatchObject({ ownClub: "Sutton FC" });
  });

  it("a club member's DM after his club wrote to him is his club's: no model", async () => {
    dbMock.membership.findFirst.mockResolvedValue({ org: { name: "Sutton FC" } });
    dbMock.botJob.count.mockResolvedValue(1);
    expect(await answerPoolOfferReply({ ...fromHim, text: "Tue and Thu from 8" })).toBeNull();
    expect(reader.readPoolReply).not.toHaveBeenCalled();
  });

  it("from a number that is not his: nothing changed, nothing said", async () => {
    said();
    expect(await answerPoolOfferReply({ ...fromHim, phone: "447700900222", text: "after 7" })).toBeNull();
    expect(details.saveDetailsFromWords).not.toHaveBeenCalled();
    expect(queue.queuePlatformDm).not.toHaveBeenCalled();
  });

  it("a stopped profile is never read", async () => {
    dbMock.poolProfile.findUnique.mockResolvedValue({ ...profileRow, status: "stopped" });
    expect(await answerPoolOfferReply({ ...fromHim, text: "after 7" })).toBeNull();
    expect(reader.readPoolReply).not.toHaveBeenCalled();
  });

  it("a save the validator refused says nothing (never a false 'saved')", async () => {
    said();
    details.saveDetailsFromWords.mockResolvedValue(null);
    expect(await answerPoolOfferReply({ ...fromHim, text: "after 7" })).toBeNull();
    expect(queue.queuePlatformDm).not.toHaveBeenCalled();
  });

  it("unsure: asked once what he meant, then silence", async () => {
    said(0.5);
    expect(await answerPoolOfferReply({ ...fromHim, text: "erm the usual" })).toBe("pool-details-reask");
    expect(texts()[0]).toMatch(/^Sorry, I didn't quite get that\. Which times can you play/);
    details.claimDetailsReask.mockResolvedValue(false);
    expect(await answerPoolOfferReply({ ...fromHim, text: "erm the usual again" })).toBeNull();
    expect(texts()).toHaveLength(1);
    expect(details.saveDetailsFromWords).not.toHaveBeenCalled();
  });

  it("a reply that ignores the question changes nothing and says nothing", async () => {
    reading("neither");
    expect(await answerPoolOfferReply({ ...fromHim, text: "cool, cheers" })).toBeNull();
    expect(details.saveDetailsFromWords).not.toHaveBeenCalled();
    expect(queue.queuePlatformDm).not.toHaveBeenCalled();
  });

  it("a swipe-reply to the question is shown as one", async () => {
    details.loadDetailsAsk.mockResolvedValue({ ...ASK, quoted: true });
    said();
    await answerPoolOfferReply({ ...fromHim, text: "after 7", quotedId: "wa-ask" });
    expect(details.loadDetailsAsk).toHaveBeenCalledWith("prof-1", HIS, "wa-ask", true);
    expect(reader.readPoolReply.mock.calls[0][1]).toMatchObject({ quotedAsk: true });
  });
});
