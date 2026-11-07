/**
 * A SIGN-IN CODE, END TO END ON THE OFFICIAL NUMBER (WhatsApp Cloud API
 * plan, PR C7a, sections 3.1, 5.5 and 5.9): the real `startPhoneSignIn`
 * queues the code through the real `queuePlatformDm`, and the real Cloud
 * dispatcher sends that very row to the local Cloud API stub
 * (e2e/stubs/cloud-api.ts) over HTTP. Never Meta.
 *
 * db and next/headers are mocked; the claim and the outcome writer are
 * mocked as in dispatch.test.ts (their own tests pin the SQL). No model,
 * no Meta, $0.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startCloudApiStub, type CloudApiStub } from "../../../../e2e/stubs/cloud-api";

const dbMock = vi.hoisted(() => ({
  phoneOtp: { count: vi.fn(), create: vi.fn() },
  platformJob: { create: vi.fn(), findMany: vi.fn() },
  user: { findFirst: vi.fn() },
  waInbound: { findMany: vi.fn() },
  cloudTemplateStatus: { findMany: vi.fn(), upsert: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const headerMock = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(headerMock.values) }));
const pj = vi.hoisted(() => ({ claimDuePlatformJobs: vi.fn(), recordPlatformJobOutcome: vi.fn() }));
vi.mock("@/lib/platform-jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/platform-jobs")>()), ...pj }));
const kick = vi.hoisted(() => ({ scheduleCloudDispatch: vi.fn() }));
vi.mock("@/lib/cloud-api/kick", () => kick);
const switchEnv = vi.hoisted(() => ({ resolvePoolEnv: vi.fn() }));
vi.mock("@/lib/pool/switch-env", () => switchEnv);

import { startPhoneSignIn } from "@/app/actions/phone-signup";
import { dispatchCloudJobs } from "../dispatch";
import { templateMessage } from "../templates";

const NOW = new Date();
const TOKEN = "stub-token";
const PHONE = "447700900123";
let stub: CloudApiStub;
let rows: Array<Record<string, unknown>>;
let inbounds: Array<{ phone: string; receivedAt: Date }>;
let statuses: Array<{ name: string; language: string; status: string }>;

beforeAll(async () => {
  stub = await startCloudApiStub({ token: TOKEN });
});
afterAll(async () => {
  await stub.close();
});

const dispatchEnv = () => ({
  CLOUD_API_ENABLED: process.env.CLOUD_API_ENABLED,
  MT_TEST_MODE: "1",
  WA_CLOUD_API_BASE: stub.url,
  WA_CLOUD_ACCESS_TOKEN: TOKEN,
  WA_CLOUD_PHONE_NUMBER_ID: "1234567890",
});
const issuedCode = () => dbMock.phoneOtp.create.mock.calls[0][0].data.code as string;
const outcomes = () => pj.recordPlatformJobOutcome.mock.calls.map((c) => c[1]);

function codesOn() {
  vi.stubEnv("CLOUD_API_ENABLED", "1");
  vi.stubEnv("CLOUD_API_PURPOSES", "otp");
  vi.stubEnv("WA_CLOUD_NUMBER", "447700900999");
}

beforeEach(() => {
  vi.clearAllMocks();
  stub.reset();
  rows = [];
  inbounds = [];
  statuses = [];
  headerMock.values = { "accept-language": "en-GB,en;q=0.9" };
  dbMock.phoneOtp.count.mockResolvedValue(0);
  dbMock.phoneOtp.create.mockResolvedValue({ id: "otp1" });
  // The row the action writes is the row the dispatcher claims.
  dbMock.platformJob.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    rows.push({ id: `pj${rows.length + 1}`, createdAt: new Date(NOW.getTime() - 5_000), failReason: null, templateName: null, templateLang: null, templateParams: null, ...data });
    return { id: `pj${rows.length}` };
  });
  dbMock.platformJob.findMany.mockImplementation(async (args: { where: { id?: unknown } }) => (args.where.id ? rows : []));
  dbMock.waInbound.findMany.mockImplementation(async () => inbounds);
  dbMock.cloudTemplateStatus.findMany.mockImplementation(async () => statuses);
  pj.claimDuePlatformJobs.mockImplementation(async (args: { channel: string }) =>
    rows.filter((r) => r.channel === args.channel).map((r) => ({ id: r.id, kind: "dm", phone: r.phone, text: r.text, purpose: r.purpose })),
  );
  pj.recordPlatformJobOutcome.mockResolvedValue({ updated: true });
  switchEnv.resolvePoolEnv.mockResolvedValue({});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("flags off: the code stays the club number's, the official number sends nothing", () => {
  it("the job is the Pi's, and the dispatcher neither claims nor sends", async () => {
    for (const k of ["CLOUD_API_ENABLED", "CLOUD_API_PURPOSES", "WA_CLOUD_NUMBER"]) vi.stubEnv(k, undefined as unknown as string);
    expect(await startPhoneSignIn({ phone: "+447700900123" })).toEqual({ ok: true });
    expect(rows[0]).toMatchObject({ channel: "baileys", templateName: null });
    const report = await dispatchCloudJobs({ now: NOW, env: dispatchEnv() });
    expect(report.enabled).toBe(false);
    expect(pj.claimDuePlatformJobs).not.toHaveBeenCalled();
    expect(stub.requests).toHaveLength(0);
  });
});

describe("codes on the official number", () => {
  it("the code goes as mt_code in en_GB with a copy code button, and its wamid is stored", async () => {
    codesOn();
    expect(await startPhoneSignIn({ phone: "+447700900123" })).toEqual({ ok: true, from: "+447700900999" });
    const report = await dispatchCloudJobs({ now: NOW, env: dispatchEnv() });
    expect(report).toMatchObject({ claimed: 1, sent: 1 });
    const code = issuedCode();
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].body).toMatchObject({
      to: PHONE,
      type: "template",
      template: templateMessage("mt_code", "en", { body: [code], buttons: [{ index: 0, text: code }] }),
    });
    expect((stub.requests[0].body as { template: { language: { code: string } } }).template.language.code).toBe("en_GB");
    expect(outcomes()).toEqual([{ outcome: "sent", waMessageId: stub.requests[0].wamid }]);
  });

  it("a Turkish browser: Meta's tr", async () => {
    codesOn();
    headerMock.values = { "accept-language": "tr-TR,tr;q=0.9" };
    await startPhoneSignIn({ phone: "+447700900123" });
    await dispatchCloudJobs({ now: NOW, env: dispatchEnv() });
    expect((stub.requests[0].body as { template: { language: { code: string } } }).template.language.code).toBe("tr");
  });

  it("he wrote to the official number an hour ago: the code is still the template, never free form", async () => {
    codesOn();
    inbounds = [{ phone: PHONE, receivedAt: new Date(NOW.getTime() - 3600_000) }];
    await startPhoneSignIn({ phone: "+447700900123" });
    await dispatchCloudJobs({ now: NOW, env: dispatchEnv() });
    expect(stub.requests[0].body).toMatchObject({ type: "template", template: { name: "mt_code" } });
  });

  it("Meta cannot deliver it (131026): handed to the club number while the code is alive", async () => {
    codesOn();
    stub.answerNext({ httpStatus: 400, error: { code: 131026, message: "undeliverable" } });
    await startPhoneSignIn({ phone: "+447700900123" });
    await dispatchCloudJobs({ now: NOW, env: dispatchEnv() });
    expect(outcomes()[0]).toMatchObject({ outcome: "handover", channel: "baileys" });
  });

  it("mt_code paused by Meta: not sent, handed to the club number at once (not held past its life)", async () => {
    codesOn();
    statuses = [{ name: "mt_code", language: "en_GB", status: "PAUSED" }];
    await startPhoneSignIn({ phone: "+447700900123" });
    await dispatchCloudJobs({ now: NOW, env: dispatchEnv() });
    expect(stub.requests).toHaveLength(0);
    expect(outcomes()[0]).toMatchObject({ outcome: "handover", channel: "baileys" });
  });
});
