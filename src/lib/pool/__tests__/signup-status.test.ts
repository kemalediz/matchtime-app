/**
 * POST /api/play/signup/status (2026-10-31): the /play reminder asks whether
 * this browser's sign-up is still waiting for its WhatsApp code. It answers
 * {state} and nothing else; a guessed or forged token learns nothing and
 * never reaches the database; checks are capped per requesting address.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ poolProfile: { findUnique: vi.fn() } }));
vi.mock("../../db", () => ({ db: dbMock }));

import { POST } from "@/app/api/play/signup/status/route";
import { POOL_SIGNUP_STATUS } from "../rules";
import { checkPoolSignupStatus, resetPoolSignupStatusLimiter } from "../signup-status";
import { poolSignupStatusToken } from "../signup-status-token";

const NOW = new Date("2026-10-31T12:00:00Z");
const LATER = new Date("2026-11-02T12:00:00Z");

function req(body: unknown, ip = "203.0.113.9"): Request {
  return new Request("http://x/api/play/signup/status", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.AUTH_SECRET = "unit-secret";
  vi.clearAllMocks();
  resetPoolSignupStatusLimiter();
  dbMock.poolProfile.findUnique.mockResolvedValue({ status: "pending-verify", confirmCode: "ABCDE", confirmCodeExpiresAt: LATER });
});

describe("the token", () => {
  it("names the profile and is bound to its code", async () => {
    const token = poolSignupStatusToken("prof1", "ABCDE");
    expect(token.startsWith("prof1.")).toBe(true);
    expect(await checkPoolSignupStatus({ token, code: "ABCDE", ip: "1.1.1.1", now: NOW })).toEqual({ ok: true, state: "waiting" });
    expect(dbMock.poolProfile.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "prof1" } }));
  });
  it("the same token with another code is forged: gone, no database read", async () => {
    const token = poolSignupStatusToken("prof1", "ABCDE");
    expect(await checkPoolSignupStatus({ token, code: "ABCDF", ip: "1.1.1.1", now: NOW })).toEqual({ ok: true, state: "gone" });
    expect(dbMock.poolProfile.findUnique).not.toHaveBeenCalled();
  });
  it("a guessed token (another id, a made-up signature): gone, no database read", async () => {
    const real = poolSignupStatusToken("prof1", "ABCDE");
    for (const token of [`prof2.${real.split(".")[1]}`, "prof1.AAAAAAAAAAAAAAAAAAAAAA", "prof1", "", "a.b.c", "x".repeat(500)]) {
      expect(await checkPoolSignupStatus({ token, code: "ABCDE", ip: "1.1.1.1", now: NOW })).toEqual({ ok: true, state: "gone" });
    }
    expect(dbMock.poolProfile.findUnique).not.toHaveBeenCalled();
  });
  it("a token signed with another secret is refused", async () => {
    process.env.AUTH_SECRET = "other";
    const token = poolSignupStatusToken("prof1", "ABCDE");
    process.env.AUTH_SECRET = "unit-secret";
    expect(await checkPoolSignupStatus({ token, code: "ABCDE", ip: "1.1.1.1", now: NOW })).toEqual({ ok: true, state: "gone" });
  });
});

describe("the state", () => {
  const token = () => poolSignupStatusToken("prof1", "ABCDE");
  it("confirmed: done", async () => {
    dbMock.poolProfile.findUnique.mockResolvedValue({ status: "active", confirmCode: null, confirmCodeExpiresAt: null });
    expect(await checkPoolSignupStatus({ token: token(), code: "ABCDE", ip: "1.1.1.1", now: NOW })).toEqual({ ok: true, state: "done" });
  });
  it("deleted: gone", async () => {
    dbMock.poolProfile.findUnique.mockResolvedValue(null);
    expect(await checkPoolSignupStatus({ token: token(), code: "ABCDE", ip: "1.1.1.1", now: NOW })).toEqual({ ok: true, state: "gone" });
  });
  it("run out: gone", async () => {
    dbMock.poolProfile.findUnique.mockResolvedValue({ status: "pending-verify", confirmCode: "ABCDE", confirmCodeExpiresAt: new Date(NOW.getTime() - 1) });
    expect(await checkPoolSignupStatus({ token: token(), code: "ABCDE", ip: "1.1.1.1", now: NOW })).toEqual({ ok: true, state: "gone" });
  });
  it("reads only the three columns it needs", async () => {
    await checkPoolSignupStatus({ token: token(), code: "ABCDE", ip: "1.1.1.1", now: NOW });
    expect(dbMock.poolProfile.findUnique.mock.calls[0][0].select).toEqual({ status: true, confirmCode: true, confirmCodeExpiresAt: true });
  });
});

describe("the cap per requesting address", () => {
  it("refuses the check after the cap, guessed or not, and other addresses are not held", async () => {
    for (let i = 0; i < POOL_SIGNUP_STATUS.perIpPerHour; i++) {
      expect((await checkPoolSignupStatus({ token: "guess", code: "ABCDE", ip: "9.9.9.9", now: NOW })).ok).toBe(true);
    }
    expect(await checkPoolSignupStatus({ token: poolSignupStatusToken("prof1", "ABCDE"), code: "ABCDE", ip: "9.9.9.9", now: NOW })).toEqual({ ok: false, reason: "busy" });
    expect(dbMock.poolProfile.findUnique).not.toHaveBeenCalled();
    expect(await checkPoolSignupStatus({ token: poolSignupStatusToken("prof1", "ABCDE"), code: "ABCDE", ip: "8.8.8.8", now: NOW })).toEqual({ ok: true, state: "waiting" });
  });
  it("no address at all shares one bucket, so it is capped too", async () => {
    for (let i = 0; i < POOL_SIGNUP_STATUS.perIpPerHour; i++) await checkPoolSignupStatus({ token: "g", code: "ABCDE", ip: null, now: NOW });
    expect(await checkPoolSignupStatus({ token: "g", code: "ABCDE", ip: null, now: NOW })).toEqual({ ok: false, reason: "busy" });
  });
});

describe("the route answers {state} and nothing else", () => {
  it("waiting", async () => {
    const res = await POST(req({ token: poolSignupStatusToken("prof1", "ABCDE"), code: "ABCDE" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "waiting" });
  });
  it("done carries no name, id or anything else", async () => {
    dbMock.poolProfile.findUnique.mockResolvedValue({ status: "active", confirmCode: null, confirmCodeExpiresAt: null, displayName: "Ali K", id: "prof1" });
    const res = await POST(req({ token: poolSignupStatusToken("prof1", "ABCDE"), code: "ABCDE" }));
    expect(await res.json()).toEqual({ state: "done" });
  });
  it("a guess, a broken body, or wrong types: gone, the same answer as a deleted sign-up", async () => {
    for (const body of [{ token: "prof1.zzz", code: "ABCDE" }, "not json", { token: 5, code: ["x"] }, {}, null]) {
      const res = await POST(req(body));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ state: "gone" });
    }
    expect(dbMock.poolProfile.findUnique).not.toHaveBeenCalled();
  });
  it("over the cap: 429 with no state", async () => {
    for (let i = 0; i < POOL_SIGNUP_STATUS.perIpPerHour; i++) await POST(req({ token: "g", code: "ABCDE" }, "7.7.7.7"));
    const res = await POST(req({ token: "g", code: "ABCDE" }, "7.7.7.7"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ reason: "busy" });
  });
});
