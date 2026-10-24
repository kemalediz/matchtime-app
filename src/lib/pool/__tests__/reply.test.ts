/**
 * The one-line reply to a pool offer (L5a; review of #400 minor 1, second
 * review item 4): only for an offer that REACHED him; a club member gets
 * it only when he quotes the offer, and the quote may be of any delivered
 * offer in the window, not only the newest.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  poolOffer: { findMany: vi.fn() },
  platformJob: { findMany: vi.fn() },
  membership: { count: vi.fn() },
  sentNotification: { create: vi.fn() },
  poolProfile: { findUnique: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("../../db", () => ({ db: dbMock }));
const queue = vi.hoisted(() => ({ queuePlatformDm: vi.fn() }));
vi.mock("../../platform-jobs", () => queue);
vi.mock("../links", () => ({ buildPoolManageLink: async () => "https://m/r/x" }));

import { answerPoolOfferReply } from "../reply";

const NOW = new Date("2026-10-27T12:00:00Z");
const open = { outcome: null, expiresAt: new Date(NOW.getTime() + 3600_000), ask: { status: "open", org: { name: "Newer FC" } } };
const ended = { outcome: "expired", expiresAt: new Date(NOW.getTime() - 3600_000), ask: { status: "filled", org: { name: "Older FC" } } };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET ||= "test-secret-for-reply";
  dbMock.poolOffer.findMany.mockResolvedValue([
    { id: "new", platformJobId: "j-new", ...open },
    { id: "old", platformJobId: "j-old", ...ended },
  ]);
  dbMock.platformJob.findMany.mockResolvedValue([
    { id: "j-new", waMessageId: "wa-new" },
    { id: "j-old", waMessageId: "wa-old" },
  ]);
  dbMock.membership.count.mockResolvedValue(1);
  dbMock.sentNotification.create.mockResolvedValue({});
  dbMock.poolProfile.findUnique.mockResolvedValue({ language: "en", user: { phoneNumber: "+447700900111" } });
});

describe("answerPoolOfferReply", () => {
  it("a member quoting the OLDER offer is answered about that one", async () => {
    expect(await answerPoolOfferReply({ userId: "pete", quotedId: "wa-old", now: NOW })).toBe("pool-offer-gone");
    expect(queue.queuePlatformDm.mock.calls[0][0].text).toContain("Older FC");
    expect(queue.queuePlatformDm.mock.calls[0][0].refId).toBe("old");
  });
  it("a member's plain DM is left to his club's handlers", async () => {
    expect(await answerPoolOfferReply({ userId: "pete", quotedId: null, now: NOW })).toBeNull();
    expect(queue.queuePlatformDm).not.toHaveBeenCalled();
  });
  it("someone in no club gets the line about his newest offer", async () => {
    dbMock.membership.count.mockResolvedValue(0);
    expect(await answerPoolOfferReply({ userId: "ali", now: NOW })).toBe("pool-offer-tap-link");
  });
  it("nothing delivered: nothing", async () => {
    dbMock.poolOffer.findMany.mockResolvedValue([]);
    expect(await answerPoolOfferReply({ userId: "ali", now: NOW })).toBeNull();
  });
});
