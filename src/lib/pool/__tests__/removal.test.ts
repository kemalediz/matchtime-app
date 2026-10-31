/**
 * An organiser takes a pool guest off the game (slice L7; review of #404,
 * findings 5 and 6): the DM goes only when THIS call made him a past guest,
 * and after kickoff nothing is marked or sent (he stays on the no-show
 * panel for the organisers to mark).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  membership: { findUnique: vi.fn(), updateMany: vi.fn() },
  guestPlace: { updateMany: vi.fn(), findUnique: vi.fn() },
  organisation: { findUnique: vi.fn() },
  match: { findUnique: vi.fn() },
  poolProfile: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock("../../db", () => ({ db: dbMock }));
const jobs = vi.hoisted(() => ({ queuePlatformDm: vi.fn(async () => ({ id: "j" })) }));
vi.mock("../../platform-jobs", () => jobs);

import { tellPoolGuestRemoved } from "../removal";

const NOW = new Date("2026-11-03T12:00:00Z");
beforeEach(() => {
  vi.clearAllMocks();
  dbMock.membership.findUnique.mockResolvedValue({ guestVia: "pool", guestMatchId: "m1", leftAt: null });
  dbMock.membership.updateMany.mockResolvedValue({ count: 1 });
  dbMock.guestPlace.updateMany.mockResolvedValue({ count: 1 });
  dbMock.guestPlace.findUnique.mockResolvedValue({ friendLinkId: null });
  dbMock.organisation.findUnique.mockResolvedValue({ name: "FNF", language: "en" });
  dbMock.match.findUnique.mockResolvedValue({ date: new Date("2026-11-03T20:00:00Z") });
  dbMock.poolProfile.findUnique.mockResolvedValue({ language: "en" });
  dbMock.user.findUnique.mockResolvedValue({ phoneNumber: "+447700900111" });
});

describe("tellPoolGuestRemoved", () => {
  it("before kickoff: his place given up in time, a past guest, one neutral DM", async () => {
    expect(await tellPoolGuestRemoved({ userId: "u", matchId: "m1", orgId: "o", now: NOW })).toBe(true);
    expect(dbMock.guestPlace.updateMany).toHaveBeenCalled();
    expect(jobs.queuePlatformDm).toHaveBeenCalledTimes(1);
  });
  it("a member's friend (friend link, 2026-10-31): Kemal's own words, purpose friend-removed", async () => {
    dbMock.guestPlace.findUnique.mockResolvedValue({ friendLinkId: "fl1" });
    await tellPoolGuestRemoved({ userId: "u", matchId: "m1", orgId: "o", now: NOW });
    expect(jobs.queuePlatformDm).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "friend-removed",
        text: "The organisers of *FNF* took you out of the game on Tue 3 Nov, 20:00. You stay in the MatchTime player pool and will keep hearing about new games near you.",
      }),
    );
  });
  it("a pool guest keeps the neutral line", async () => {
    await tellPoolGuestRemoved({ userId: "u", matchId: "m1", orgId: "o", now: NOW });
    expect(jobs.queuePlatformDm).toHaveBeenCalledWith(expect.objectContaining({ purpose: "pool-removed" }));
  });
  it("another call already made him a past guest: no second DM", async () => {
    dbMock.membership.updateMany.mockResolvedValue({ count: 0 });
    await tellPoolGuestRemoved({ userId: "u", matchId: "m1", orgId: "o", now: NOW });
    expect(jobs.queuePlatformDm).not.toHaveBeenCalled();
  });
  it("after kickoff: nothing marked, nothing sent", async () => {
    expect(await tellPoolGuestRemoved({ userId: "u", matchId: "m1", orgId: "o", now: new Date("2026-11-03T20:30:00Z") })).toBe(false);
    expect(dbMock.guestPlace.updateMany).not.toHaveBeenCalled();
    expect(dbMock.membership.updateMany).not.toHaveBeenCalled();
    expect(jobs.queuePlatformDm).not.toHaveBeenCalled();
  });
});
