/**
 * THE POOL'S SWEEPS, ONE HOME (WhatsApp Cloud API plan, PR C4). The Pi's
 * platform poll and the Cloud dispatcher's per-minute sweep both run them
 * through `runPlatformPoolSweeps`, so neither copies the other: the pool,
 * the club invitations and the partner pool invites, in that order, each
 * on its own (one failing never stops the next), never throwing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const m = vi.hoisted(() => ({ sweepPool: vi.fn(), sweepClubInvitations: vi.fn(), sweepPartnerPoolInvites: vi.fn() }));
vi.mock("../round", () => ({ sweepPool: (...a: unknown[]) => m.sweepPool(...a) }));
vi.mock("../club-invitation", () => ({ sweepClubInvitations: (...a: unknown[]) => m.sweepClubInvitations(...a) }));
vi.mock("../partner-invite", () => ({ sweepPartnerPoolInvites: (...a: unknown[]) => m.sweepPartnerPoolInvites(...a) }));

import { runPlatformPoolSweeps } from "../platform-sweeps";

const NOW = new Date("2026-11-07T12:00:00Z");
const ENV = { POOL: "1" };

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  m.sweepPool.mockImplementation(async () => void calls.push("pool"));
  m.sweepClubInvitations.mockImplementation(async () => void calls.push("invitations"));
  m.sweepPartnerPoolInvites.mockImplementation(async () => void calls.push("partner"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runPlatformPoolSweeps", () => {
  it("runs the three sweeps in order with the same clock and switch", async () => {
    await runPlatformPoolSweeps(NOW, ENV, "platform-jobs");
    expect(calls).toEqual(["pool", "invitations", "partner"]);
    for (const f of [m.sweepPool, m.sweepClubInvitations, m.sweepPartnerPoolInvites]) expect(f).toHaveBeenCalledWith(NOW, ENV);
  });

  it("one failing never stops the next, and nothing is thrown", async () => {
    m.sweepPool.mockRejectedValueOnce(new Error("db"));
    m.sweepClubInvitations.mockRejectedValueOnce(new Error("db"));
    await expect(runPlatformPoolSweeps(NOW, ENV, "cloud-dispatch")).resolves.toBeUndefined();
    expect(m.sweepPartnerPoolInvites).toHaveBeenCalled();
    expect(String((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])).toContain("[cloud-dispatch] pool sweep failed");
  });
});
