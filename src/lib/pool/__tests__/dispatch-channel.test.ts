/**
 * WhatsApp Cloud API plan, PR C2 (MDs/whatsapp-cloud-api-plan-2026-11-04.md
 * section 5.5): a pool offer is claimed only for the number it was stored
 * for. `claimDuePlatformJobs` passes its channel ("baileys" for the Pi) to
 * `admitPoolOfferJobs`, whose compare-and-set then names it. With no
 * channel given the claim is the one it always was.
 *
 * db is mocked (one admitted offer, a transaction stand-in). No network,
 * no model calls.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-11-04T12:00:00Z");
const KICKOFF = new Date("2026-11-06T19:00:00Z");

const tx = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  poolOffer: { findMany: vi.fn(), updateMany: vi.fn() },
  poolProfile: { findMany: vi.fn() },
  membership: { findMany: vi.fn() },
  platformJob: { findMany: vi.fn(), updateMany: vi.fn() },
}));
const dbMock = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock("../../db", () => ({ db: dbMock }));
vi.mock("../../club-partnership", () => ({ loadPartnerAskSettings: vi.fn(async () => null) }));

import { admitPoolOfferJobs } from "../dispatch";
import { poolSwitchEnv } from "../flags";

const OPEN = poolSwitchEnv(true);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.$transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  tx.poolOffer.findMany.mockImplementation(async (args: { where: { platformJobId?: unknown } }) =>
    args.where.platformJobId
      ? [
          {
            id: "o1",
            userId: "u1",
            orgId: "org1",
            outcome: null,
            expiresAt: new Date(NOW.getTime() + 6 * 3600_000),
            platformJobId: "j1",
            ask: { status: "open", org: { featurePlayerPool: true, whatsappBotEnabled: true }, match: { date: KICKOFF, status: "UPCOMING", isHistorical: false } },
          },
        ]
      : [],
  );
  tx.poolProfile.findMany.mockResolvedValue([{ userId: "u1", status: "active", consentAt: new Date("2026-10-30T10:00:00Z") }]);
  tx.membership.findMany.mockResolvedValue([]);
  tx.platformJob.findMany.mockResolvedValue([]);
  tx.platformJob.updateMany.mockResolvedValue({ count: 1 });
});

const claimCall = () => tx.platformJob.updateMany.mock.calls.find((c) => c[0].data?.status === "claimed");

describe("the pool offer claim names the claimer's channel (Cloud API C2)", () => {
  it("the Pi's claim (channel baileys) is a compare-and-set on the channel too", async () => {
    const r = await admitPoolOfferJobs(["j1"], { now: NOW, limit: 5, env: OPEN, channel: "baileys" });
    expect([...r.claimed]).toEqual(["j1"]);
    expect(claimCall()![0].where).toEqual({ id: "j1", status: "queued", channel: "baileys" });
  });

  it("a job stored for the other number is not claimed (the compare-and-set finds nothing)", async () => {
    tx.platformJob.updateMany.mockImplementation(async (args: { where: { channel?: string } }) => ({ count: args.where.channel === "baileys" ? 0 : 1 }));
    const r = await admitPoolOfferJobs(["j1"], { now: NOW, limit: 5, env: OPEN, channel: "baileys" });
    expect(r.claimed.size).toBe(0);
    expect([...r.skip]).toEqual(["j1"]);
  });

  it("no channel given: the claim is exactly the one before C2", async () => {
    await admitPoolOfferJobs(["j1"], { now: NOW, limit: 5, env: OPEN });
    expect(claimCall()![0].where).toEqual({ id: "j1", status: "queued" });
  });

  it("his caps still count offers on both numbers (the in flight read is not narrowed)", async () => {
    await admitPoolOfferJobs(["j1"], { now: NOW, limit: 5, env: OPEN, channel: "baileys" });
    const busyRead = tx.platformJob.findMany.mock.calls[0][0];
    expect(busyRead.where).not.toHaveProperty("channel");
  });
});
