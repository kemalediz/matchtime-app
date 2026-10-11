/**
 * SIGN IN WITH WHATSAPP (the /login page, 2026-10-11).
 *
 * Reported live by the owner: an organiser who signed up with a phone
 * number was later shown /login, which offered only email + password and
 * Google. A phone account has neither, so the only way back in was to
 * "sign up" again. Kemal: "the user shouldn't be signing up again. nobody
 * would do that."
 *
 * Pinned here:
 *   - an existing phone user gets a session token and lands where a
 *     signed-in user of that kind lands;
 *   - signing in NEVER creates a user, and never asks for a name;
 *   - nobody can find out whether a number has an account without holding
 *     that phone: the start action never looks at User at all, and the
 *     "no account" answer exists only behind a correct code;
 *   - the code is the SAME code system as sign-up: same table, same
 *     expiry, same attempt limit, same three caps;
 *   - `callbackUrl` is followed only when it stays on this site.
 *
 * db, next/headers and the token signer are mocked. No network, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  phoneOtp: { count: vi.fn(), create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  platformJob: { create: vi.fn() },
  user: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  membership: { count: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

const headerMock = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerMock.values),
}));

const signMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/magic-link", () => ({
  signMagicLinkToken: signMock,
  MAGIC_LINK_TTL: {},
}));

import { startPhoneSignIn, startPhoneSignup, verifyPhoneSignIn } from "../phone-signup";
import { SITE_SIGNUP_CODES_PER_DAY, SIGNUP_ATTEMPTS_PER_IP_PER_HOUR } from "@/lib/signup-caps";

type CountArgs = { where: Record<string, unknown> };

function counts(c: { phone?: number; ip?: number; site?: number }) {
  dbMock.phoneOtp.count.mockImplementation(async ({ where }: CountArgs) => {
    if ("phone" in where) return c.phone ?? 0;
    if ("requestIp" in where) return c.ip ?? 0;
    return c.site ?? 0;
  });
}

const PHONE = "+447700900123";
const DIGITS = "447700900123";
const USER = { id: "u1", name: "Ali Demir", phoneNumber: PHONE, onboarded: true };

function liveOtp(over: Partial<{ code: string; attempts: number }> = {}) {
  dbMock.phoneOtp.findFirst.mockResolvedValue({ id: "otp1", phone: DIGITS, code: "123456", attempts: 0, ...over });
}

beforeEach(() => {
  vi.clearAllMocks();
  headerMock.values = { "x-forwarded-for": "203.0.113.7, 10.0.0.1" };
  counts({});
  dbMock.phoneOtp.create.mockResolvedValue({ id: "otp1" });
  dbMock.phoneOtp.update.mockResolvedValue({});
  dbMock.platformJob.create.mockResolvedValue({ id: "pj1" });
  dbMock.user.findUnique.mockResolvedValue(USER);
  dbMock.user.update.mockImplementation(async ({ data }: { data: object }) => ({ ...USER, ...data }));
  dbMock.membership.count.mockResolvedValue(1);
  signMock.mockReturnValue("signed.token");
  liveOtp();
});

describe("startPhoneSignIn", () => {
  it("sends a 6 digit code on the platform channel", async () => {
    expect(await startPhoneSignIn({ phone: "+44 7700 900123" })).toEqual({ ok: true });
    const otp = dbMock.phoneOtp.create.mock.calls[0][0].data;
    expect(otp.phone).toBe(DIGITS);
    expect(otp.code).toMatch(/^\d{6}$/);
    expect(otp.requestIp).toBe("203.0.113.7");
    const ttl = otp.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);
    const { data } = dbMock.platformJob.create.mock.calls[0][0];
    expect(data).toMatchObject({ kind: "dm", phone: DIGITS, purpose: "otp", status: "queued" });
  });

  it("the message is a sign-in message, with no name and no dashes", async () => {
    await startPhoneSignIn({ phone: PHONE });
    const code = dbMock.phoneOtp.create.mock.calls[0][0].data.code as string;
    const text = dbMock.platformJob.create.mock.calls[0][0].data.text as string;
    expect(text).toBe(
      `🔐 Your MatchTime sign-in code: *${code}*\n\n` +
        `It expires in 10 minutes. If you didn't ask for this, just ignore the message.`,
    );
    expect(text).not.toMatch(/[–—]/);
  });

  it("refuses a number that is not a phone number, and sends nothing", async () => {
    const res = await startPhoneSignIn({ phone: "hello" });
    expect(res.ok).toBe(false);
    expect(dbMock.phoneOtp.create).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  // ── The privacy rule ────────────────────────────────────────────────
  it("never looks at User: a number with an account and one without are indistinguishable", async () => {
    dbMock.user.findUnique.mockResolvedValue(USER);
    const known = await startPhoneSignIn({ phone: PHONE });
    const knownText = (dbMock.platformJob.create.mock.calls[0][0].data.text as string).replace(/\d{6}/, "CODE");

    vi.clearAllMocks();
    counts({});
    dbMock.user.findUnique.mockResolvedValue(null);
    const unknown = await startPhoneSignIn({ phone: "+447700900999" });
    const unknownText = (dbMock.platformJob.create.mock.calls[0][0].data.text as string).replace(/\d{6}/, "CODE");

    expect(known).toEqual({ ok: true });
    expect(unknown).toEqual(known);
    expect(unknownText).toBe(knownText);
    expect(dbMock.user.findUnique).not.toHaveBeenCalled();
    expect(dbMock.user.findFirst).not.toHaveBeenCalled();
    expect(dbMock.membership.count).not.toHaveBeenCalled();
  });

  // ── The same caps as sign-up, with the same answers ─────────────────
  it("per phone: 3 codes an hour, shared with sign-up", async () => {
    counts({ phone: 3 });
    const res = await startPhoneSignIn({ phone: PHONE });
    expect(res).toEqual(await startPhoneSignup({ phone: PHONE, name: "Ali" }));
    expect(res.ok).toBe(false);
    expect(dbMock.phoneOtp.create).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it(`per IP: ${SIGNUP_ATTEMPTS_PER_IP_PER_HOUR} an hour`, async () => {
    counts({ ip: SIGNUP_ATTEMPTS_PER_IP_PER_HOUR - 1 });
    expect(await startPhoneSignIn({ phone: PHONE })).toEqual({ ok: true });

    vi.clearAllMocks();
    counts({ ip: SIGNUP_ATTEMPTS_PER_IP_PER_HOUR });
    expect(await startPhoneSignIn({ phone: PHONE })).toEqual({
      ok: false,
      error: "We're busy right now, please try again tomorrow.",
    });
    expect(dbMock.phoneOtp.create).not.toHaveBeenCalled();
  });

  it(`whole site: ${SITE_SIGNUP_CODES_PER_DAY} a day`, async () => {
    counts({ site: SITE_SIGNUP_CODES_PER_DAY });
    expect(await startPhoneSignIn({ phone: PHONE })).toEqual({
      ok: false,
      error: "We're busy right now, please try again tomorrow.",
    });
    expect(dbMock.phoneOtp.create).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });
});

describe("verifyPhoneSignIn", () => {
  it("an existing phone user signs in and lands on the dashboard", async () => {
    const res = await verifyPhoneSignIn({ phone: PHONE, code: "123456" });
    expect(res).toEqual({ ok: true, magicLinkToken: "signed.token", nextPath: "/" });
    expect(dbMock.user.findUnique).toHaveBeenCalledWith({ where: { phoneNumber: PHONE } });
    expect(signMock).toHaveBeenCalledWith({ userId: "u1", purpose: "sign-in", nextPath: "/", ttlSeconds: 300 });
    // The code is spent.
    expect(dbMock.phoneOtp.update).toHaveBeenCalledWith({ where: { id: "otp1" }, data: { usedAt: expect.any(Date) } });
    expect(dbMock.user.create).not.toHaveBeenCalled();
  });

  it("looks for the newest live code for THAT phone only", async () => {
    await verifyPhoneSignIn({ phone: PHONE, code: "123456" });
    const q = dbMock.phoneOtp.findFirst.mock.calls[0][0];
    expect(q.where).toMatchObject({ phone: DIGITS, usedAt: null, expiresAt: { gt: expect.any(Date) } });
    expect(q.orderBy).toEqual({ createdAt: "desc" });
  });

  it("a user with no club yet goes where sign-up sends them", async () => {
    dbMock.membership.count.mockResolvedValue(0);
    const res = await verifyPhoneSignIn({ phone: PHONE, code: "123456" });
    expect(res).toMatchObject({ ok: true, nextPath: "/onboarding" });
  });

  it("a player the bot added, who never opened the site, is not sent through /welcome", async () => {
    dbMock.user.findUnique.mockResolvedValue({ ...USER, onboarded: false });
    const res = await verifyPhoneSignIn({ phone: PHONE, code: "123456" });
    expect(res.ok).toBe(true);
    expect(dbMock.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { onboarded: true } });
  });

  it("an onboarded user is not written to at all", async () => {
    await verifyPhoneSignIn({ phone: PHONE, code: "123456" });
    expect(dbMock.user.update).not.toHaveBeenCalled();
  });

  // ── Never creates an account ────────────────────────────────────────
  it("an unknown number with a CORRECT code is refused, and nothing is created", async () => {
    dbMock.user.findUnique.mockResolvedValue(null);
    const res = await verifyPhoneSignIn({ phone: PHONE, code: "123456" });
    expect(res).toEqual({
      ok: false,
      noAccount: true,
      error: "There is no MatchTime account for this number.",
    });
    expect(dbMock.user.create).not.toHaveBeenCalled();
    expect(dbMock.user.upsert).not.toHaveBeenCalled();
    expect(dbMock.user.update).not.toHaveBeenCalled();
    expect(signMock).not.toHaveBeenCalled();
    // The code is spent all the same: it cannot be replayed.
    expect(dbMock.phoneOtp.update).toHaveBeenCalledWith({ where: { id: "otp1" }, data: { usedAt: expect.any(Date) } });
  });

  it("an unknown number with a WRONG code learns nothing: same answer as a known number", async () => {
    dbMock.user.findUnique.mockResolvedValue(null);
    const unknown = await verifyPhoneSignIn({ phone: PHONE, code: "000000" });
    expect(dbMock.user.findUnique).not.toHaveBeenCalled();

    vi.clearAllMocks();
    liveOtp();
    dbMock.user.findUnique.mockResolvedValue(USER);
    const known = await verifyPhoneSignIn({ phone: PHONE, code: "000000" });
    expect(dbMock.user.findUnique).not.toHaveBeenCalled();

    expect(unknown).toEqual({ ok: false, error: "Wrong code" });
    expect(known).toEqual(unknown);
  });

  // ── Wrong, expired, used, over the limit ────────────────────────────
  it("a wrong code counts an attempt and mints nothing", async () => {
    liveOtp({ attempts: 2 });
    const res = await verifyPhoneSignIn({ phone: PHONE, code: "654321" });
    expect(res).toEqual({ ok: false, error: "Wrong code" });
    expect(dbMock.phoneOtp.update).toHaveBeenCalledWith({ where: { id: "otp1" }, data: { attempts: 3 } });
    expect(signMock).not.toHaveBeenCalled();
  });

  it("an expired or already used code is not found, so nothing is minted", async () => {
    dbMock.phoneOtp.findFirst.mockResolvedValue(null);
    const res = await verifyPhoneSignIn({ phone: PHONE, code: "123456" });
    expect(res).toEqual({ ok: false, error: "Code expired, request a new one" });
    expect(dbMock.user.findUnique).not.toHaveBeenCalled();
    expect(signMock).not.toHaveBeenCalled();
  });

  it("after 5 wrong attempts even the RIGHT code is refused", async () => {
    liveOtp({ attempts: 5 });
    const res = await verifyPhoneSignIn({ phone: PHONE, code: "123456" });
    expect(res).toEqual({ ok: false, error: "Too many wrong attempts. Request a new code." });
    expect(dbMock.phoneOtp.update).not.toHaveBeenCalled();
    expect(dbMock.user.findUnique).not.toHaveBeenCalled();
    expect(signMock).not.toHaveBeenCalled();
  });

  it("the 5th attempt is still allowed", async () => {
    liveOtp({ attempts: 4 });
    expect((await verifyPhoneSignIn({ phone: PHONE, code: "123456" })).ok).toBe(true);
  });

  it.each(["12345", "1234567", "12a456", ""])("a code that is not 6 digits (%j) never reaches the database", async (code) => {
    const res = await verifyPhoneSignIn({ phone: PHONE, code });
    expect(res).toEqual({ ok: false, error: "Code must be 6 digits" });
    expect(dbMock.phoneOtp.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a number that is not a phone number", async () => {
    const res = await verifyPhoneSignIn({ phone: "hello", code: "123456" });
    expect(res.ok).toBe(false);
    expect(dbMock.phoneOtp.findFirst).not.toHaveBeenCalled();
  });

  // ── callbackUrl ─────────────────────────────────────────────────────
  it("follows a same-site callbackUrl", async () => {
    const res = await verifyPhoneSignIn({ phone: PHONE, code: "123456", callbackUrl: "/admin/players?tab=new" });
    expect(res).toMatchObject({ ok: true, nextPath: "/admin/players?tab=new" });
    expect(signMock).toHaveBeenCalledWith(expect.objectContaining({ nextPath: "/admin/players?tab=new" }));
  });

  it("follows a same-site callbackUrl for a user with no club too (e.g. /create-org)", async () => {
    dbMock.membership.count.mockResolvedValue(0);
    const res = await verifyPhoneSignIn({ phone: PHONE, code: "123456", callbackUrl: "/create-org" });
    expect(res).toMatchObject({ ok: true, nextPath: "/create-org" });
  });

  it.each(["https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)", "admin"])(
    "ignores the off-site callbackUrl %s and uses the default landing",
    async (callbackUrl) => {
      const res = await verifyPhoneSignIn({ phone: PHONE, code: "123456", callbackUrl });
      expect(res).toMatchObject({ ok: true, nextPath: "/" });
      expect(signMock).toHaveBeenCalledWith(expect.objectContaining({ nextPath: "/" }));
    },
  );

  it('a bare "/" callbackUrl (the page default) means "the default landing"', async () => {
    dbMock.membership.count.mockResolvedValue(0);
    const res = await verifyPhoneSignIn({ phone: PHONE, code: "123456", callbackUrl: "/" });
    expect(res).toMatchObject({ ok: true, nextPath: "/onboarding" });
  });
});
