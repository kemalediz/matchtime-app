/**
 * SIGN-UP CODES GO OUT ON THE PLATFORM CHANNEL (self-join slice 3).
 *
 * Until 2026-09-29 the sign-up code was queued as a `BotJob` under "the
 * first bot-enabled org", borrowed purely as a sender because `BotJob.orgId`
 * is required. Kemal muted Sutton FC twice in the week of 2026-09-06; had
 * it been the only live club, every sign-up would have died with "still
 * warming up". Now the code is a `PlatformJob` (purpose "otp") that the Pi
 * polls for directly, so it goes out whatever any club's switch says.
 *
 * Also pinned: the two site caps from plan section 7.
 *   cap 2  20 sign-up codes a day, whole site (London day)
 *   cap 3  5 sign-up attempts an hour per IP (first x-forwarded-for hop)
 * on top of today's 3 codes an hour per phone.
 *
 * db and next/headers are mocked. No network, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  phoneOtp: { count: vi.fn(), create: vi.fn() },
  platformJob: { create: vi.fn() },
  organisation: { findFirst: vi.fn() },
  botJob: { create: vi.fn() },
  user: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

const headerMock = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerMock.values),
}));

const authMock = vi.hoisted(() => ({ session: { user: { id: "u-signed-in" } } as unknown }));
vi.mock("@/lib/auth", () => ({ auth: async () => authMock.session }));

import { startPhoneSignup } from "../phone-signup";
import { SITE_SIGNUP_CODES_PER_DAY, SIGNUP_ATTEMPTS_PER_IP_PER_HOUR } from "@/lib/signup-caps";
import { startClaimAccount } from "../claim";

type CountArgs = { where: Record<string, unknown> };

/** Route each count query to the number the test wants. */
function counts(c: { phone?: number; ip?: number; site?: number }) {
  dbMock.phoneOtp.count.mockImplementation(async ({ where }: CountArgs) => {
    if ("phone" in where) return c.phone ?? 0;
    if ("requestIp" in where) return c.ip ?? 0;
    return c.site ?? 0;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  headerMock.values = { "x-forwarded-for": "203.0.113.7, 10.0.0.1" };
  counts({});
  dbMock.phoneOtp.create.mockResolvedValue({ id: "otp1" });
  dbMock.platformJob.create.mockResolvedValue({ id: "pj1" });
  // The trap: if anything still looked for a sender org, it would find none.
  dbMock.organisation.findFirst.mockResolvedValue(null);
});

describe("startPhoneSignup", () => {
  it("sends the code even when NO club has its bot switched on", async () => {
    const res = await startPhoneSignup({ phone: "+44 7700 900123", name: "Ali" });
    expect(res).toEqual({ ok: true });
    expect(dbMock.platformJob.create).toHaveBeenCalledTimes(1);
    const { data } = dbMock.platformJob.create.mock.calls[0][0];
    expect(data).toMatchObject({ kind: "dm", phone: "447700900123", purpose: "otp", status: "queued" });
    const code = dbMock.phoneOtp.create.mock.calls[0][0].data.code as string;
    expect(data.text).toContain(code);
    expect(dbMock.organisation.findFirst).not.toHaveBeenCalled();
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });

  it("keeps the code text byte-identical to what it was", async () => {
    await startPhoneSignup({ phone: "+447700900123", name: "Ali" });
    const code = dbMock.phoneOtp.create.mock.calls[0][0].data.code as string;
    expect(dbMock.platformJob.create.mock.calls[0][0].data.text).toBe(
      `👋 Welcome to MatchTime, Ali!\n\n` +
        `Your verification code: *${code}*\n\n` +
        `It expires in 10 minutes. If you didn't ask for this, just ignore the message.`,
    );
  });

  it("records the first forwarded hop as the request IP", async () => {
    await startPhoneSignup({ phone: "+447700900123", name: "Ali" });
    expect(dbMock.phoneOtp.create.mock.calls[0][0].data.requestIp).toBe("203.0.113.7");
  });

  it("per phone: still 3 an hour", async () => {
    counts({ phone: 3 });
    const res = await startPhoneSignup({ phone: "+447700900123", name: "Ali" });
    expect(res.ok).toBe(false);
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it(`cap 3: the ${SIGNUP_ATTEMPTS_PER_IP_PER_HOUR}th attempt from one IP in an hour is allowed, the next is not`, async () => {
    counts({ ip: SIGNUP_ATTEMPTS_PER_IP_PER_HOUR - 1 });
    expect(await startPhoneSignup({ phone: "+447700900123", name: "Ali" })).toEqual({ ok: true });

    vi.clearAllMocks();
    counts({ ip: SIGNUP_ATTEMPTS_PER_IP_PER_HOUR });
    const res = await startPhoneSignup({ phone: "+447700900124", name: "Bo" });
    expect(res).toEqual({ ok: false, error: "We're busy right now, please try again tomorrow." });
    expect(dbMock.phoneOtp.create).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("cap 3 counts by IP, within the last hour", async () => {
    const before = Date.now();
    await startPhoneSignup({ phone: "+447700900123", name: "Ali" });
    const ipQuery = dbMock.phoneOtp.count.mock.calls
      .map((c) => c[0] as CountArgs)
      .find((a) => "requestIp" in a.where)!;
    expect(ipQuery.where.requestIp).toBe("203.0.113.7");
    const gte = (ipQuery.where.createdAt as { gte: Date }).gte.getTime();
    expect(before - gte).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000);
    expect(before - gte).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
  });

  it("with no forwarding header there is no IP to count, so only the other caps apply", async () => {
    headerMock.values = {};
    counts({ ip: 999 });
    expect(await startPhoneSignup({ phone: "+447700900123", name: "Ali" })).toEqual({ ok: true });
    expect(dbMock.phoneOtp.create.mock.calls[0][0].data.requestIp).toBeNull();
  });

  it(`cap 2: code number ${SITE_SIGNUP_CODES_PER_DAY} today is sent, the next is refused`, async () => {
    counts({ site: SITE_SIGNUP_CODES_PER_DAY - 1 });
    expect(await startPhoneSignup({ phone: "+447700900123", name: "Ali" })).toEqual({ ok: true });

    vi.clearAllMocks();
    counts({ site: SITE_SIGNUP_CODES_PER_DAY });
    const res = await startPhoneSignup({ phone: "+447700900124", name: "Bo" });
    expect(res).toEqual({ ok: false, error: "We're busy right now, please try again tomorrow." });
    expect(dbMock.phoneOtp.create).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("cap 2 counts from the start of the London day", async () => {
    await startPhoneSignup({ phone: "+447700900123", name: "Ali" });
    const siteQuery = dbMock.phoneOtp.count.mock.calls
      .map((c) => c[0] as CountArgs)
      .find((a) => !("phone" in a.where) && !("requestIp" in a.where))!;
    const gte = (siteQuery.where.createdAt as { gte: Date }).gte;
    // Midnight London is 23:00 or 00:00 UTC, whichever the season.
    expect([0, 23]).toContain(gte.getUTCHours());
    expect(gte.getUTCMinutes()).toBe(0);
    expect(Date.now() - gte.getTime()).toBeLessThan(25 * 60 * 60 * 1000);
  });
});

describe("startClaimAccount", () => {
  it("sends the claim code on the platform channel, with no club on", async () => {
    const res = await startClaimAccount("+447700900123");
    expect(res).toEqual({ ok: true });
    expect(dbMock.platformJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "dm", phone: "447700900123", purpose: "otp" }),
    });
    expect(dbMock.organisation.findFirst).not.toHaveBeenCalled();
    expect(dbMock.botJob.create).not.toHaveBeenCalled();
  });
});
