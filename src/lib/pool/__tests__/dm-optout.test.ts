/**
 * The general DM opt-out also stops his pool offers (decision L6.11, the
 * manager, 2026-10-24): same path as Stop on the manage page, recorded from
 * his WhatsApp message; one pool line only when the opt-out step sent him
 * nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ poolProfile: { findUnique: vi.fn() } }));
vi.mock("../../db", () => ({ db: dbMock }));
const queue = vi.hoisted(() => ({ queuePlatformDm: vi.fn() }));
vi.mock("../../platform-jobs", () => queue);
vi.mock("../links", () => ({ buildPoolManageLink: async () => "https://m/r/x" }));
const manage = vi.hoisted(() => ({ applyManageAction: vi.fn() }));
vi.mock("../manage", () => manage);

import { dmOptOutStopsPool, poolLanguageOf, stopPoolOnDmOptOut } from "../dm-optout";

const NOW = new Date("2026-10-27T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.poolProfile.findUnique.mockResolvedValue({ status: "active", language: "en", user: { phoneNumber: "+447700900111" } });
  manage.applyManageAction.mockResolvedValue({ ok: true });
});

describe("dmOptOutStopsPool", () => {
  it("only the general opt-out withdraws pool consent", () => {
    expect(dmOptOutStopsPool("opt-out-all")).toBe(true);
    for (const k of ["opt-out-ratings", "opt-in-all", "opt-in-ratings"] as const) expect(dmOptOutStopsPool(k)).toBe(false);
  });
});

describe("stopPoolOnDmOptOut", () => {
  it("stops through the manage page's stop, evidence his message; one line when the opt-out sent nothing", async () => {
    expect(await stopPoolOnDmOptOut({ userId: "ali", waMessageId: "wamid-9", fromPhones: ["447700900111"], sendLine: true, now: NOW })).toEqual({ stopped: true });
    expect(manage.applyManageAction).toHaveBeenCalledWith("ali", "stop", { now: NOW, via: { channel: "whatsapp", waMessageId: "wamid-9" } });
    expect(queue.queuePlatformDm).toHaveBeenCalledWith(expect.objectContaining({ phone: "+447700900111", purpose: "pool-reply" }));
    expect(queue.queuePlatformDm.mock.calls[0][0].text).toMatch(/^Done, I've stopped game offers\. You can start them again here: https:\/\/m\/r\/x$/);
  });
  it("a member who got the club's opt-out reply hears nothing more", async () => {
    expect(await stopPoolOnDmOptOut({ userId: "pete", waMessageId: "w", fromPhones: ["447700900111"], sendLine: false, now: NOW })).toEqual({ stopped: true });
    expect(queue.queuePlatformDm).not.toHaveBeenCalled();
  });
  it("in Turkish for a Turkish profile", async () => {
    dbMock.poolProfile.findUnique.mockResolvedValue({ status: "paused", language: "tr", user: { phoneNumber: "+905321112233" } });
    await stopPoolOnDmOptOut({ userId: "can", waMessageId: "w", fromPhones: [null, "905321112233"], sendLine: true, now: NOW });
    expect(queue.queuePlatformDm.mock.calls[0][0].text).toMatch(/^Tamam, maç tekliflerini durdurdum\./);
  });
  it("no profile, already stopped, or still waiting for his confirm: nothing", async () => {
    for (const p of [null, { status: "stopped", language: "en", user: { phoneNumber: "+44" } }, { status: "pending-verify", language: "en", user: { phoneNumber: "+44" } }]) {
      dbMock.poolProfile.findUnique.mockResolvedValue(p);
      expect(await stopPoolOnDmOptOut({ userId: "x", waMessageId: "w", fromPhones: ["44"], sendLine: true, now: NOW })).toEqual({ stopped: false });
    }
    expect(manage.applyManageAction).not.toHaveBeenCalled();
    expect(queue.queuePlatformDm).not.toHaveBeenCalled();
  });
  it("never throws: a failed stop is no stop", async () => {
    manage.applyManageAction.mockRejectedValue(new Error("db"));
    expect(await stopPoolOnDmOptOut({ userId: "x", waMessageId: "w", fromPhones: ["447700900111"], sendLine: true, now: NOW })).toEqual({ stopped: false });
  });
  it("a sender not on his number (known only by display name): nothing stopped", async () => {
    expect(await stopPoolOnDmOptOut({ userId: "ali", waMessageId: "w", fromPhones: ["", "447700900999"], sendLine: true, now: NOW })).toEqual({ stopped: false });
    expect(manage.applyManageAction).not.toHaveBeenCalled();
  });
});

describe("poolLanguageOf", () => {
  it("his pool language, or null with no profile", async () => {
    dbMock.poolProfile.findUnique.mockResolvedValue({ language: "tr" });
    expect(await poolLanguageOf("can")).toBe("tr");
    dbMock.poolProfile.findUnique.mockResolvedValue(null);
    expect(await poolLanguageOf("x")).toBeNull();
  });
});
