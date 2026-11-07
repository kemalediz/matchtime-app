/**
 * SIGN-UP, SIGN-IN AND CLAIM CODES ON THE OFFICIAL NUMBER (WhatsApp Cloud
 * API plan, PR C7a; MDs/whatsapp-cloud-api-plan-2026-11-04.md 3.1, 5.1,
 * 5.5, section 6 items 4 and 5).
 *
 * `queueCodeDm` is the one door every code goes through, and it is only a
 * thin layer over `queuePlatformDm` (purpose "otp"): it names the `mt_code`
 * template with the code and the person's language, and answers which
 * number the code comes from, for the page. Pinned here:
 *   - flags off: the row is exactly the row written before C7a, and no
 *     number is named (the club number never reaches a signed-out page);
 *   - otp listed for the official number: `mt_code` in Meta's `en_GB` or
 *     `tr`, the params as C6's `templateParams` fills them, and the
 *     official number named, when it is configured;
 *   - the language is the browser's first preference (Accept-Language).
 *
 * db and next/headers are mocked. No network, no model, $0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  platformJob: { create: vi.fn() },
  user: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const kick = vi.hoisted(() => ({ scheduleCloudDispatch: vi.fn() }));
vi.mock("../cloud-api/kick", () => kick);
const headerMock = vi.hoisted(() => ({ values: {} as Record<string, string>, throws: false }));
vi.mock("next/headers", () => ({
  headers: async () => {
    if (headerMock.throws) throw new Error("outside a request");
    return new Headers(headerMock.values);
  },
}));

import { codeLangFromRequest, queueCodeDm } from "../code-dm";
import { codeSenderNumber } from "../club-connect";
import { templateParams } from "../cloud-api/templates";

const CLOUD_ENV = ["CLOUD_API_ENABLED", "CLOUD_API_PURPOSES", "WA_CLOUD_NUMBER", "MATCHTIME_WA_NUMBER"] as const;
const clear = () => {
  for (const k of CLOUD_ENV) vi.stubEnv(k, undefined as unknown as string);
};
const codeOn = () => {
  vi.stubEnv("CLOUD_API_ENABLED", "1");
  vi.stubEnv("CLOUD_API_PURPOSES", "otp");
  vi.stubEnv("WA_CLOUD_NUMBER", "+44 7700 900999");
  vi.stubEnv("MATCHTIME_WA_NUMBER", "447700900555");
};

beforeEach(() => {
  vi.clearAllMocks();
  headerMock.values = {};
  headerMock.throws = false;
  dbMock.platformJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "pj1", ...data }));
  clear();
});
afterEach(() => vi.unstubAllEnvs());

describe("codeSenderNumber: the number a page may name", () => {
  const env = { MATCHTIME_WA_NUMBER: "447700900555", WA_CLOUD_NUMBER: "447700900999" };

  it("the official number, with its plus, for a code it sends", () => {
    expect(codeSenderNumber("cloud", env)).toBe("+447700900999");
  });

  it("never the club number: it stays off signed-out pages (wa-number-server-only)", () => {
    expect(codeSenderNumber("baileys", env)).toBeNull();
  });

  it("the official number not configured: nothing named, never the club number instead", () => {
    expect(codeSenderNumber("cloud", { MATCHTIME_WA_NUMBER: "447700900555" })).toBeNull();
    expect(codeSenderNumber("cloud", { ...env, WA_CLOUD_NUMBER: "not a number" })).toBeNull();
  });
});

describe("queueCodeDm, flags off: exactly as before C7a", () => {
  it("the row is the C2 row (club number, no template), and no number is named", async () => {
    vi.stubEnv("MATCHTIME_WA_NUMBER", "447700900555");
    vi.stubEnv("WA_CLOUD_NUMBER", "447700900999");
    vi.stubEnv("CLOUD_API_PURPOSES", "otp");
    const out = await queueCodeDm({ phone: "447700900123", code: "482913", text: "Your code *482913*", lang: "tr" });
    expect(dbMock.platformJob.create.mock.calls[0][0]).toEqual({
      data: { kind: "dm", phone: "447700900123", text: "Your code *482913*", purpose: "otp", refId: null, status: "queued", sendAfter: null, channel: "baileys" },
    });
    expect(out).toEqual({ from: null });
    expect(kick.scheduleCloudDispatch).not.toHaveBeenCalled();
  });

  it("master on, otp not listed: the club number, no template, no number named", async () => {
    codeOn();
    vi.stubEnv("CLOUD_API_PURPOSES", "pool-offer");
    const out = await queueCodeDm({ phone: "447700900123", code: "482913", text: "code", lang: "en" });
    expect(dbMock.platformJob.create.mock.calls[0][0].data).not.toHaveProperty("templateName");
    expect(out).toEqual({ from: null });
  });
});

describe("queueCodeDm, otp on the official number", () => {
  it("mt_code in en_GB, filled by templateParams, and the official number named", async () => {
    codeOn();
    const out = await queueCodeDm({ phone: "447700900123", code: "482913", text: "Your code *482913*", lang: "en" });
    const filled = templateParams("mt_code", "en", { code: "482913" });
    if (!filled.ok) throw new Error(filled.reason);
    expect(dbMock.platformJob.create.mock.calls[0][0].data).toEqual({
      kind: "dm",
      phone: "447700900123",
      // Kept for the club number, should the code be handed over to it.
      text: "Your code *482913*",
      purpose: "otp",
      refId: null,
      status: "queued",
      sendAfter: null,
      channel: "cloud",
      templateName: "mt_code",
      templateLang: "en_GB",
      templateParams: filled.params,
    });
    expect(out).toEqual({ from: "+447700900999" });
    expect(kick.scheduleCloudDispatch).toHaveBeenCalledTimes(1);
  });

  it("Turkish: Meta's tr", async () => {
    codeOn();
    await queueCodeDm({ phone: "447700900123", code: "482913", text: "code", lang: "tr" });
    expect(dbMock.platformJob.create.mock.calls[0][0].data.templateLang).toBe("tr");
  });

  it("the official number not configured: the job is still the official number's, nothing named", async () => {
    codeOn();
    vi.stubEnv("WA_CLOUD_NUMBER", undefined as unknown as string);
    const out = await queueCodeDm({ phone: "447700900123", code: "482913", text: "code", lang: "en" });
    expect(dbMock.platformJob.create.mock.calls[0][0].data.channel).toBe("cloud");
    expect(out).toEqual({ from: null });
  });
});

describe("codeLangFromRequest: the browser's first preference", () => {
  it("tr-TR first: tr", async () => {
    headerMock.values = { "accept-language": "tr-TR,tr;q=0.9,en;q=0.8" };
    expect(await codeLangFromRequest()).toBe("tr");
  });

  it("English or anything not shipped: en", async () => {
    for (const v of ["en-GB,en;q=0.9", "de-DE,tr;q=0.5", ""]) {
      headerMock.values = { "accept-language": v };
      expect(await codeLangFromRequest()).toBe("en");
    }
    headerMock.values = {};
    expect(await codeLangFromRequest()).toBe("en");
  });

  it("outside a request: en, never a throw", async () => {
    headerMock.throws = true;
    expect(await codeLangFromRequest()).toBe("en");
  });
});
