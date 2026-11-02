/**
 * The partner pool invite's sweep holds while the pool is closed: the
 * platform switch off (or unread), or pool sign-ups braked. It reads
 * nothing then, so nothing can be sent. (Who is due, and the DM itself,
 * are the rules' tests and the sim scenarios, e2e/sim/pool/partner-invite.)
 */
import { describe, expect, it, vi } from "vitest";

const guestPlace = vi.hoisted(() => ({ findMany: vi.fn(async () => []) }));
vi.mock("../../db", () => ({ db: { guestPlace } }));

import { sweepPartnerPoolInvites } from "../partner-invite";
import { poolSwitchEnv } from "../flags";

const NOW = new Date("2026-11-02T12:00:00Z");

describe("sweepPartnerPoolInvites: the switches", () => {
  it("the platform switch off, or never resolved: nothing read, nothing sent", async () => {
    expect(await sweepPartnerPoolInvites(NOW, poolSwitchEnv(false))).toBe(0);
    expect(await sweepPartnerPoolInvites(NOW, {})).toBe(0);
    expect(guestPlace.findMany).not.toHaveBeenCalled();
  });
  it("pool sign-ups braked: nothing read, nothing sent", async () => {
    expect(await sweepPartnerPoolInvites(NOW, poolSwitchEnv(true, { POOL_SIGNUP_PAUSED: "1" }))).toBe(0);
    expect(guestPlace.findMany).not.toHaveBeenCalled();
  });
  it("the pool open: the partner guest places of the after-game window are read", async () => {
    expect(await sweepPartnerPoolInvites(NOW, poolSwitchEnv(true))).toBe(0);
    expect(guestPlace.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ source: "partner", partnerAskId: { not: null } }) }));
  });
});
