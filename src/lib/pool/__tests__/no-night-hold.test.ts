/**
 * NO NIGHT HOLD ON POOL OFFERS (Kemal, 2026-10-29): "I would remove this
 * quiet hours for now." The pool's hard-coded 21:30 to 08:30 hold is gone
 * for every ask, the organiser's and the automatic one: an offer made at
 * 03:00 London is queued to go now (`sendAfter` null), and its planned
 * window runs from now. Every cap is unchanged (caps.test.ts,
 * dispatch-rules.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const NIGHT = new Date("2026-11-03T03:00:00Z"); // 03:00 London (GMT)
const KICKOFF = new Date("2026-11-03T19:00:00Z");

const tx = vi.hoisted(() => ({
  $executeRaw: vi.fn(async () => 0),
  $executeRawUnsafe: vi.fn(async () => 0),
  poolAsk: { findUnique: vi.fn(async () => ({ status: "open" })) },
  poolOffer: {
    findMany: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: "offer1" })),
    update: vi.fn(async () => ({})),
  },
}));
const dbMock = vi.hoisted(() => ({
  match: { findUnique: vi.fn() },
  poolAsk: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({ id: "ask1" })), findUnique: vi.fn() },
  poolProfile: { findMany: vi.fn() },
  attendance: { count: vi.fn(async () => 0) },
  membership: { findUnique: vi.fn(async () => ({ role: "ADMIN", leftAt: null, guestMatchId: null })) },
  partnerAsk: { count: vi.fn(async () => 0) },
  $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
}));
vi.mock("../../db", () => ({ db: dbMock }));
const jobs = vi.hoisted(() => ({ queuePlatformDm: vi.fn(async () => ({ id: "job1" })), cancelQueuedPlatformDms: vi.fn() }));
vi.mock("../../platform-jobs", () => jobs);
vi.mock("../../club-partnership", () => ({ loadPartnerAskSettings: vi.fn(async () => ({ cutoffHours: 4 })) }));
vi.mock("../candidates", () => ({
  findPoolCandidates: vi.fn(async () => ({
    ctx: { kickoff: KICKOFF, orgId: "fnf" },
    selection: { gate: null, eligible: [{ userId: "u1", distanceMiles: 2 }], excluded: {} },
  })),
}));
vi.mock("../offer-facts", () => ({ loadMatchOfferFacts: vi.fn(async () => ({ club: "FNF" })) }));
vi.mock("../offer-copy", () => ({ poolOfferText: vi.fn(() => "offer"), poolPausedText: vi.fn(() => "paused") }));
vi.mock("../links", () => ({ buildPoolManageLink: vi.fn(async () => "https://x/m") }));
vi.mock("../offer-token", () => ({ poolOfferPath: (id: string) => `/o/${id}` }));
vi.mock("../flags", async (orig) => ({ ...(await orig<typeof import("../flags")>()), poolOffersOpenForClub: () => true }));

import { requestPoolAsk } from "../round";
import { POOL_ROUND } from "../rules";

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.match.findUnique.mockImplementation(async ({ select }: { select: Record<string, unknown> }) =>
    "maxPlayers" in select ? { maxPlayers: 14 } : { date: KICKOFF, activity: { orgId: "fnf", org: { featurePlayerPool: true } } },
  );
  dbMock.poolAsk.findUnique.mockResolvedValue({ id: "ask1", matchId: "m1", orgId: "fnf", places: 1, status: "open" });
  dbMock.poolProfile.findMany.mockResolvedValue([{ userId: "u1", language: "en", user: { phoneNumber: "+447700900111" } }]);
});

describe("a pool ask at 03:00 London sends its offers now", () => {
  it.each(["page", "words", "notice", "auto"] as const)("via %s: queued with no hold, its window from now", async (via) => {
    const r = await requestPoolAsk({ orgId: "fnf", matchId: "m1", places: 1, roundId: null, approvedByUserId: via === "auto" ? null : "u-admin", via, now: NIGHT });
    expect(r).toEqual({ ok: true, askId: "ask1", waveSent: true });
    expect(jobs.queuePlatformDm).toHaveBeenCalledTimes(1);
    const queued = (jobs.queuePlatformDm.mock.calls[0] as unknown as [{ purpose: string; sendAfter: Date | null }])[0];
    expect(queued).toMatchObject({ purpose: "pool-offer", sendAfter: null });
    const created = (tx.poolOffer.create.mock.calls[0] as unknown as [{ data: { expiresAt: Date } }])[0].data;
    expect(created.expiresAt).toEqual(new Date(NIGHT.getTime() + POOL_ROUND.offerTtlHours * 3600_000));
  });
});
