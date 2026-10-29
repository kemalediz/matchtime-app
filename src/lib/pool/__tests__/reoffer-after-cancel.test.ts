/**
 * ASKING THE POOL AGAIN AFTER A CANCELLED ROUND (2026-10-29). An offer
 * cancelled before its DM went never reached him, so a new ask for the
 * same match may offer him again: the never-reached row (the unique
 * matchId+userId index stays) is reset in place for the new ask, with a
 * fresh job. One that reached him, or whose DM may still be going (its job
 * claimed, not failed), still blocks him.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-11-03T12:00:00Z");
const KICKOFF = new Date("2026-11-03T19:00:00Z");

const tx = vi.hoisted(() => ({
  $executeRaw: vi.fn(async () => 0),
  $executeRawUnsafe: vi.fn(async () => 0),
  poolAsk: { findUnique: vi.fn(async () => ({ status: "open" })) },
  poolOffer: {
    findMany: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: "offer1" })),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  platformJob: { findMany: vi.fn(async () => [] as Array<{ id: string }>) },
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


const asked = () => requestPoolAsk({ orgId: "fnf", matchId: "m1", places: 1, roundId: null, approvedByUserId: "u-admin", via: "page", now: NOW });
// The second findMany in the wave is "his offers for this match".
const onMatch = (rows: unknown[]) =>
  tx.poolOffer.findMany.mockImplementation((async (args: { where: { poolAskId?: string } }) => (args.where.poolAskId ? [] : rows)) as never);

describe("a new ask re-offers a player whose earlier offer never reached him", () => {
  it("cancelled before its DM went (job failed): the same row is reset for the new ask, and a DM queued", async () => {
    onMatch([{ id: "old1", userId: "u1", sentAt: null, outcome: "cancelled", platformJobId: "jobOld" }]);
    tx.platformJob.findMany.mockResolvedValue([]); // no live job: the old one failed
    const r = await asked();
    expect(r).toMatchObject({ ok: true, waveSent: true });
    expect(tx.poolOffer.create).not.toHaveBeenCalled();
    const reset = (tx.poolOffer.updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }])[0];
    expect(reset.where).toMatchObject({ id: "old1", sentAt: null, outcome: "cancelled" });
    expect(reset.data).toMatchObject({ poolAskId: "ask1", wave: 1, outcome: null, resolvedAt: null, sentAt: null, platformJobId: null, repliedVia: null, createdAt: NOW });
    expect(jobs.queuePlatformDm).toHaveBeenCalledTimes(1);
    expect((jobs.queuePlatformDm.mock.calls[0] as unknown as [{ refId: string }])[0].refId).toBe("old1");
    expect(tx.poolOffer.update).toHaveBeenCalledWith({ where: { id: "old1" }, data: { platformJobId: "job1" } });
  });

  it("an offer that reached him (sentAt set) still blocks him, whatever its outcome", async () => {
    onMatch([{ id: "old1", userId: "u1", sentAt: new Date("2026-11-03T10:00:00Z"), outcome: "cancelled", platformJobId: "jobOld" }]);
    const r = await asked();
    expect(r).toMatchObject({ ok: true, waveSent: false });
    expect(tx.poolOffer.create).not.toHaveBeenCalled();
    expect(tx.poolOffer.updateMany).not.toHaveBeenCalled();
    expect(jobs.queuePlatformDm).not.toHaveBeenCalled();
  });

  it("cancelled but its DM was already claimed by the Pi (it may still go): he is not offered again", async () => {
    onMatch([{ id: "old1", userId: "u1", sentAt: null, outcome: "cancelled", platformJobId: "jobOld" }]);
    tx.platformJob.findMany.mockResolvedValue([{ id: "jobOld" }]);
    const r = await asked();
    expect(r).toMatchObject({ ok: true, waveSent: false });
    expect(tx.poolOffer.updateMany).not.toHaveBeenCalled();
    expect(jobs.queuePlatformDm).not.toHaveBeenCalled();
  });

  it("no earlier offer: a new row is created as before", async () => {
    onMatch([]);
    await asked();
    expect(tx.poolOffer.create).toHaveBeenCalledTimes(1);
    expect(tx.poolOffer.updateMany).not.toHaveBeenCalled();
  });
});
