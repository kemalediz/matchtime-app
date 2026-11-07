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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { startPhoneSignIn, startPhoneSignup } from "../phone-signup";
import { SITE_SIGNUP_CODES_PER_DAY, SIGNUP_ATTEMPTS_PER_IP_PER_HOUR } from "@/lib/signup-caps";
import { startClaimAccount } from "../claim";
import { templateParams } from "@/lib/cloud-api/templates";

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

// ── WhatsApp Cloud API plan, PR C7a (section 3.1): all three code actions
//    queue through the one code door (src/lib/code-dm.ts). Flags off: the
//    answer and the row are exactly what they were. Codes listed for the
//    official number: Meta's `mt_code` in the browser's language, and the
//    official number named for the page. ──

const CLOUD_ENV = ["CLOUD_API_ENABLED", "CLOUD_API_PURPOSES", "WA_CLOUD_NUMBER", "MATCHTIME_WA_NUMBER"] as const;

const ACTIONS = [
  { name: "startPhoneSignup", run: () => startPhoneSignup({ phone: "+447700900123", name: "Ali" }) },
  { name: "startPhoneSignIn", run: () => startPhoneSignIn({ phone: "+447700900123" }) },
  { name: "startClaimAccount", run: () => startClaimAccount("+447700900123") },
] as const;

const issuedCode = () => dbMock.phoneOtp.create.mock.calls[0][0].data.code as string;

describe("the three code actions with the Cloud API flags off (C7a): exactly as before", () => {
  afterEach(() => vi.unstubAllEnvs());

  for (const a of ACTIONS) {
    it(`${a.name}: answers { ok: true } and writes the pre-C7a row, the club number's, no template`, async () => {
      for (const k of CLOUD_ENV) vi.stubEnv(k, undefined as unknown as string);
      // Numbers configured and codes listed: the master switch alone decides.
      vi.stubEnv("MATCHTIME_WA_NUMBER", "447700900555");
      vi.stubEnv("WA_CLOUD_NUMBER", "447700900999");
      vi.stubEnv("CLOUD_API_PURPOSES", "otp");
      headerMock.values = { "x-forwarded-for": "203.0.113.7", "accept-language": "tr-TR,tr;q=0.9" };
      expect(await a.run()).toEqual({ ok: true });
      const { data } = dbMock.platformJob.create.mock.calls[0][0];
      expect(Object.keys(data).sort()).toEqual(["channel", "kind", "phone", "purpose", "refId", "sendAfter", "status", "text"]);
      expect(data).toMatchObject({ kind: "dm", phone: "447700900123", purpose: "otp", status: "queued", refId: null, sendAfter: null, channel: "baileys" });
      expect(data.text).toContain(issuedCode());
    });
  }
});

describe("the three code actions with codes on the official number (C7a)", () => {
  afterEach(() => vi.unstubAllEnvs());

  function codesOn() {
    vi.stubEnv("CLOUD_API_ENABLED", "1");
    vi.stubEnv("CLOUD_API_PURPOSES", "otp");
    vi.stubEnv("WA_CLOUD_NUMBER", "447700900999");
    vi.stubEnv("MATCHTIME_WA_NUMBER", "447700900555");
  }

  for (const a of ACTIONS) {
    it(`${a.name}: mt_code with the issued code in en_GB, and the official number for the page`, async () => {
      codesOn();
      headerMock.values = { "accept-language": "en-GB,en;q=0.9" };
      expect(await a.run()).toEqual({ ok: true, from: "+447700900999" });
      const { data } = dbMock.platformJob.create.mock.calls[0][0];
      const filled = templateParams("mt_code", "en", { code: issuedCode() });
      if (!filled.ok) throw new Error(filled.reason);
      expect(data).toMatchObject({ purpose: "otp", channel: "cloud", templateName: "mt_code", templateLang: "en_GB", templateParams: filled.params });
      // The club number's text stays on the job, for a handover.
      expect(data.text).toContain(issuedCode());
    });

    it(`${a.name}: a Turkish browser gets Meta's tr`, async () => {
      codesOn();
      headerMock.values = { "accept-language": "tr-TR,tr;q=0.9,en;q=0.8" };
      await a.run();
      expect(dbMock.platformJob.create.mock.calls[0][0].data.templateLang).toBe("tr");
    });
  }

  it("a refused request queues nothing, on either number", async () => {
    codesOn();
    counts({ phone: 3 });
    for (const a of ACTIONS) expect((await a.run()).ok).toBe(false);
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });
});
