/**
 * Review of #404: a club's report names a match only of that club with that
 * guest (13); a database refusal is a friendly answer (11); the pause DMs
 * respect the pool's quiet hours (9).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  guestPlace: { findFirst: vi.fn() },
  membership: { findFirst: vi.fn() },
  poolReport: { create: vi.fn(), findMany: vi.fn(async () => []), updateMany: vi.fn() },
  poolProfile: { findUnique: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
  $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(dbMock)),
}));
vi.mock("../../db", () => ({ db: dbMock }));
vi.mock("../../owner-dm", () => ({ queueOwnerDm: vi.fn(async () => ({ queued: 1, skipped: 0 })) }));
const jobs = vi.hoisted(() => ({ queuePlatformDm: vi.fn(async () => ({ id: "j" })) }));
vi.mock("../../platform-jobs", () => jobs);
vi.mock("../links", () => ({ buildPoolManageLink: vi.fn(async () => "https://x/m") }));

import { liftPoolPause, reportFromClub } from "../safety";

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.guestPlace.findFirst.mockResolvedValue({ id: "gp" });
  dbMock.membership.findFirst.mockResolvedValue(null);
  dbMock.poolReport.create.mockResolvedValue({ id: "r1" });
});

describe("reportFromClub", () => {
  it("a match that is not this club's game with this guest is refused, nothing written", async () => {
    dbMock.guestPlace.findFirst.mockImplementation(async ({ where }: { where: { matchId?: string } }) => (where.matchId ? null : { id: "gp" }));
    expect(await reportFromClub({ orgId: "o", userId: "u", byUserId: "a", text: "He was rude.", matchId: "other-club-match" })).toEqual({ ok: false, reason: "not-allowed" });
    expect(dbMock.poolReport.create).not.toHaveBeenCalled();
  });
  it("his game here: written with the match", async () => {
    expect(await reportFromClub({ orgId: "o", userId: "u", byUserId: "a", text: "He was rude.", matchId: "m1" })).toEqual({ ok: true });
    expect(dbMock.poolReport.create.mock.calls[0][0].data).toMatchObject({ matchId: "m1" });
  });
  it("the database refuses the row: a friendly refusal, never a thrown error", async () => {
    dbMock.poolReport.create.mockRejectedValue(new Error('violates check constraint "PoolReport_text_check"'));
    expect(await reportFromClub({ orgId: "o", userId: "u", byUserId: "a", text: "He was rude." })).toEqual({ ok: false, reason: "failed" });
  });
});

describe("the owner lifts a pause at night", () => {
  it("the 'offers on again' DM waits for the pool's morning", async () => {
    dbMock.poolProfile.findUnique.mockResolvedValue({ id: "p", status: "paused", pausedReason: "no-shows", language: "en", user: { phoneNumber: "+447700900111" } });
    const night = new Date("2026-11-03T23:30:00Z");
    expect(await liftPoolPause("u", "owner", night, { POOL_OFFERS_ENABLED: "1" })).toBe(true);
    const sendAfter = (jobs.queuePlatformDm.mock.calls[0] as unknown as [{ sendAfter: Date | null }])[0].sendAfter;
    expect(sendAfter).not.toBeNull();
    expect(sendAfter!.getTime()).toBeGreaterThan(night.getTime());
  });
});
