/**
 * THE CLOUD DISPATCHER (WhatsApp Cloud API plan, PR C4, section 5.5).
 *
 * It claims through THE SAME function as the Pi (`claimDuePlatformJobs`,
 * channel cloud), so pool admission stays in one place; it sends each
 * claimed job to the official number (here: the local stub, never Meta)
 * and records the outcome through the same `recordPlatformJobOutcome`.
 * With CLOUD_API_ENABLED off it does nothing at all.
 *
 * db and the two platform-jobs functions are mocked (their own tests pin
 * the claim and the writes); the HTTP round trip to the stub is real.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startCloudApiStub, type CloudApiStub } from "../../../../e2e/stubs/cloud-api";

const dbMock = vi.hoisted(() => ({
  platformJob: { findMany: vi.fn(), updateMany: vi.fn() },
  waInbound: { findMany: vi.fn() },
  cloudTemplateStatus: { findMany: vi.fn(), upsert: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const pj = vi.hoisted(() => ({ claimDuePlatformJobs: vi.fn(), recordPlatformJobOutcome: vi.fn() }));
vi.mock("../../platform-jobs", async (orig) => ({ ...(await orig<typeof import("../../platform-jobs")>()), ...pj }));
const switchEnv = vi.hoisted(() => ({ resolvePoolEnv: vi.fn() }));
vi.mock("../../pool/switch-env", () => switchEnv);
const sweeps = vi.hoisted(() => ({ runPlatformPoolSweeps: vi.fn() }));
vi.mock("../../pool/platform-sweeps", () => sweeps);

import { CLOUD_BATCH, CLOUD_HOLD_MS, dispatchCloudJobs, runCloudDispatchSweep } from "../dispatch";
import { cloudRetryNote } from "../dispatch-rules";
import { CLOUD_RETRY_BASE_MS } from "../errors";
import { cloudTemplate, templateMessage, templateParams, type CloudTemplateParams } from "../templates";

/** Real fills from C6's registry (its own example facts). */
function fill(name: "mt_pool_offer" | "mt_code"): CloudTemplateParams {
  const f = templateParams(name, "en", cloudTemplate(name).example as never);
  if (!f.ok) throw new Error(f.reason);
  return f.params;
}
const OFFER = fill("mt_pool_offer");
const CODE = fill("mt_code");

const NOW = new Date("2026-11-07T12:00:00Z");
const TOKEN = "stub-token";
const POOL_ENV = { POOL_RESOLVED: "1" };
let stub: CloudApiStub;

beforeAll(async () => {
  stub = await startCloudApiStub({ token: TOKEN });
});
afterAll(async () => {
  await stub.close();
});

type Row = {
  id: string;
  phone: string;
  text: string;
  purpose: string;
  createdAt: Date;
  failReason: string | null;
  templateName: string | null;
  templateLang: string | null;
  templateParams: unknown;
};
let rows: Row[];
let recentSends: Array<{ phone: string; sentAt: Date }>;
let inbounds: Array<{ phone: string; receivedAt: Date }>;
let templateStatuses: Array<{ name: string; language: string; status: string }>;

function row(over: Partial<Row> = {}): Row {
  return {
    id: "j1",
    phone: "447700900001",
    text: "A game near you",
    purpose: "pool-offer",
    createdAt: new Date(NOW.getTime() - 60_000),
    failReason: null,
    templateName: "mt_pool_offer",
    templateLang: "en_GB",
    templateParams: OFFER,
    ...over,
  };
}

const env = (over: Record<string, string | undefined> = {}) => ({
  CLOUD_API_ENABLED: "1",
  MT_TEST_MODE: "1",
  WA_CLOUD_API_BASE: stub.url,
  WA_CLOUD_ACCESS_TOKEN: TOKEN,
  WA_CLOUD_PHONE_NUMBER_ID: "1234567890",
  ...over,
});
const run = (over: Record<string, string | undefined> = {}, extra: Partial<Parameters<typeof dispatchCloudJobs>[0]> = {}) =>
  dispatchCloudJobs({ now: NOW, env: env(over), ...extra });
const outcomes = () => pj.recordPlatformJobOutcome.mock.calls.map((c) => [c[0], c[1]]);

beforeEach(() => {
  vi.clearAllMocks();
  stub.reset();
  rows = [row()];
  recentSends = [];
  inbounds = [];
  templateStatuses = [];
  pj.claimDuePlatformJobs.mockImplementation(async () => rows.map((r) => ({ id: r.id, kind: "dm", phone: r.phone, text: r.text, purpose: r.purpose })));
  pj.recordPlatformJobOutcome.mockResolvedValue({ updated: true });
  dbMock.platformJob.findMany.mockImplementation(async (args: { where: { id?: unknown } }) => (args.where.id ? rows : recentSends));
  dbMock.waInbound.findMany.mockImplementation(async () => inbounds);
  dbMock.cloudTemplateStatus.findMany.mockImplementation(async () => templateStatuses);
  dbMock.cloudTemplateStatus.upsert.mockResolvedValue({});
  switchEnv.resolvePoolEnv.mockResolvedValue(POOL_ENV);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("flags off: nothing at all", () => {
  it("master off: no claim, no read, no request", async () => {
    for (const off of [undefined, "0", "false", ""]) {
      const report = await run({ CLOUD_API_ENABLED: off });
      expect(report.enabled).toBe(false);
    }
    expect(pj.claimDuePlatformJobs).not.toHaveBeenCalled();
    expect(switchEnv.resolvePoolEnv).not.toHaveBeenCalled();
    expect(dbMock.platformJob.findMany).not.toHaveBeenCalled();
    expect(dbMock.waInbound.findMany).not.toHaveBeenCalled();
    expect(pj.recordPlatformJobOutcome).not.toHaveBeenCalled();
    expect(stub.requests).toHaveLength(0);
  });

  it("master on but the official number not configured: nothing is claimed for it, the jobs wait", async () => {
    dbMock.platformJob.findMany.mockResolvedValue([]);
    const report = await run({ WA_CLOUD_ACCESS_TOKEN: undefined });
    expect(report).toMatchObject({ enabled: true, configured: false, claimed: 0 });
    expect(pj.claimDuePlatformJobs).not.toHaveBeenCalled();
    expect(stub.requests).toHaveLength(0);
  });

  it("test mode with no stub address: nothing is claimed and Meta is never called", async () => {
    await run({ WA_CLOUD_API_BASE: undefined });
    expect(pj.claimDuePlatformJobs).not.toHaveBeenCalled();
  });
});

describe("the claim is the Pi's own function, for the official number", () => {
  it("claims DMs for channel cloud, with the pool switch resolved once", async () => {
    await run();
    expect(pj.claimDuePlatformJobs).toHaveBeenCalledWith({ now: NOW, kinds: ["dm"], limit: CLOUD_BATCH, env: POOL_ENV, channel: "cloud" });
  });

  it("a pool switch given by the caller is used as it is", async () => {
    await run({}, { poolEnv: { GIVEN: "1" } });
    expect(switchEnv.resolvePoolEnv).not.toHaveBeenCalled();
    expect(pj.claimDuePlatformJobs.mock.calls[0][0].env).toEqual({ GIVEN: "1" });
  });

  it("nothing claimed: nothing sent", async () => {
    rows = [];
    expect(await run()).toMatchObject({ claimed: 0, sent: 0 });
    expect(stub.requests).toHaveLength(0);
  });
});

describe("free form inside his window, template outside it", () => {
  it("he wrote in the last 24 hours: the job's text, and the wamid is stored", async () => {
    inbounds = [{ phone: "447700900001", receivedAt: new Date(NOW.getTime() - 3600_000) }];
    const report = await run();
    expect(stub.requests[0].body).toMatchObject({ to: "447700900001", type: "text", text: { body: "A game near you" }, biz_opaque_callback_data: "j1" });
    expect(outcomes()).toEqual([["j1", { outcome: "sent", waMessageId: stub.requests[0].wamid }]]);
    expect(report.sent).toBe(1);
  });

  it("he did not: the job's template, built by C6's templateMessage", async () => {
    await run();
    expect(stub.requests[0].body).toMatchObject({ type: "template", template: templateMessage("mt_pool_offer", "en", OFFER) });
    expect(outcomes()[0][1]).toMatchObject({ outcome: "sent" });
  });

  it("Turkish: Meta's tr code, the same params", async () => {
    rows = [row({ templateLang: "tr" })];
    await run();
    expect((stub.requests[0].body as { template: unknown }).template).toEqual(templateMessage("mt_pool_offer", "tr", OFFER));
  });

  it("a template name not in the registry: failed with the reason, never sent, even inside his window", async () => {
    inbounds = [{ phone: "447700900001", receivedAt: new Date(NOW.getTime() - 3600_000) }];
    rows = [row({ templateName: "mt_made_up" })];
    await run();
    expect(stub.requests).toHaveLength(0);
    expect(outcomes()).toEqual([["j1", { outcome: "failed", reason: 'template "mt_made_up" is not in the registry', errorCode: null }]]);
  });

  it("templateParams that do not parse as CloudTemplateParams (Meta's raw components included): failed, never sent", async () => {
    for (const templateParams of [[{ type: "body", parameters: [{ type: "text", text: "x" }] }], { body: ["only one"], buttons: [] }, null]) {
      vi.clearAllMocks();
      stub.reset();
      rows = [row({ templateParams })];
      await run();
      expect(stub.requests).toHaveLength(0);
      expect(outcomes()[0][1]).toEqual({ outcome: "failed", reason: expect.stringMatching(/^templateParams do not parse as CloudTemplateParams: /), errorCode: null });
    }
  });

  it("a code whose template does not parse is failed, not handed to the club number", async () => {
    rows = [row({ id: "c", purpose: "otp", templateName: "mt_code", templateLang: "en_GB", templateParams: { body: [], buttons: [] } })];
    await run();
    expect(stub.requests).toHaveLength(0);
    expect(outcomes()[0][1]).toMatchObject({ outcome: "failed" });
  });

  it("no window and no template: failed, nothing sent", async () => {
    rows = [row({ templateName: null, templateLang: null, templateParams: null })];
    await run();
    expect(stub.requests).toHaveLength(0);
    expect(outcomes()).toEqual([["j1", { outcome: "failed", reason: expect.stringContaining("no template"), errorCode: null }]]);
  });

  it("Meta says the window closed after all (131047): resent once as its template", async () => {
    inbounds = [{ phone: "447700900001", receivedAt: new Date(NOW.getTime() - 3600_000) }];
    stub.answerNext({ httpStatus: 400, error: { code: 131047, message: "Re-engagement message" } });
    await run();
    expect(stub.requests.map((r) => (r.body as { type: string }).type)).toEqual(["text", "template"]);
    expect(outcomes()[0][1]).toMatchObject({ outcome: "sent" });
  });

  it("131047 with no template to fall back on: failed with the code", async () => {
    inbounds = [{ phone: "447700900001", receivedAt: new Date(NOW.getTime() - 3600_000) }];
    rows = [row({ templateName: null, templateLang: null, templateParams: null })];
    stub.answerNext({ httpStatus: 400, error: { code: 131047 } });
    await run();
    expect(stub.requests).toHaveLength(1);
    expect(outcomes()[0][1]).toMatchObject({ outcome: "failed", errorCode: 131047 });
  });
});

describe("failure and retry (plan 5.5)", () => {
  it("130429: back in the queue after the backoff, the retry counted, Meta's code kept", async () => {
    stub.answerNext({ httpStatus: 429, error: { code: 130429, message: "rate" } });
    const report = await run();
    expect(outcomes()[0][1]).toEqual({
      outcome: "requeue",
      sendAfter: new Date(NOW.getTime() + CLOUD_RETRY_BASE_MS),
      note: expect.stringMatching(/^cloud retry 1: Meta 130429/),
      errorCode: 130429,
    });
    expect(report.retried).toBe(1);
  });

  it("the fourth 130429 in a row: failed", async () => {
    rows = [row({ failReason: cloudRetryNote(3, "Meta 130429") })];
    stub.answerNext({ httpStatus: 429, error: { code: 130429 } });
    await run();
    expect(outcomes()[0][1]).toMatchObject({ outcome: "failed", errorCode: 130429 });
  });

  it("no answer in time: unconfirmed with the send time, never retried", async () => {
    stub.answerNext({ delayMs: 300 });
    await run({}, { timeoutMs: 30 });
    expect(outcomes()[0][1]).toEqual({ outcome: "unconfirmed", reason: expect.any(String), sentAt: NOW, errorCode: null });
  });

  it("132015: failed, and the template is flagged paused", async () => {
    stub.answerNext({ httpStatus: 400, error: { code: 132015, message: "paused" } });
    const report = await run();
    expect(outcomes()[0][1]).toMatchObject({ outcome: "failed", errorCode: 132015 });
    expect(dbMock.cloudTemplateStatus.upsert).toHaveBeenCalledWith({
      where: { name_language: { name: "mt_pool_offer", language: "en_GB" } },
      create: { name: "mt_pool_offer", language: "en_GB", status: "PAUSED", reason: expect.any(String) },
      update: { status: "PAUSED", reason: expect.any(String) },
    });
    expect(report.flaggedTemplates).toEqual(["mt_pool_offer:en_GB"]);
  });

  it("131050: failed, and the marketing stop is reported for the opt-out wiring", async () => {
    stub.answerNext({ httpStatus: 400, error: { code: 131050 } });
    const report = await run();
    expect(outcomes()[0][1]).toMatchObject({ outcome: "failed", errorCode: 131050 });
    expect(report.stopMarketing).toEqual(["447700900001"]);
  });

  it("a paused or unapproved template is not used: the job is held", async () => {
    templateStatuses = [{ name: "mt_pool_offer", language: "en_GB", status: "PAUSED" }];
    await run();
    expect(stub.requests).toHaveLength(0);
    expect(outcomes()[0][1]).toMatchObject({ outcome: "requeue", sendAfter: new Date(NOW.getTime() + CLOUD_HOLD_MS), note: expect.stringMatching(/^cloud hold: /) });
  });

  it("an approved template is used", async () => {
    templateStatuses = [{ name: "mt_pool_offer", language: "en_GB", status: "APPROVED" }];
    await run();
    expect(stub.requests).toHaveLength(1);
  });

  it("one job's broken write does not stop the others", async () => {
    rows = [row({ id: "a", phone: "447700900001" }), row({ id: "b", phone: "447700900002" })];
    pj.recordPlatformJobOutcome.mockRejectedValueOnce(new Error("db down")).mockResolvedValue({ updated: true });
    await run();
    expect(outcomes().map((o) => o[0])).toEqual(["a", "b"]);
  });
});

describe("codes fall back to the club number, and only codes (plan section 6, item 5)", () => {
  const code = (over: Partial<Row> = {}) => row({ id: "c", purpose: "otp", text: "123456 is your code", templateName: null, templateLang: null, templateParams: null, ...over });

  it("a code the official number cannot send is handed to the club number", async () => {
    rows = [code({ templateName: "mt_code", templateLang: "en_GB", templateParams: CODE })];
    stub.answerNext({ httpStatus: 400, error: { code: 131026, message: "undeliverable" } });
    const report = await run();
    expect(outcomes()[0]).toEqual(["c", { outcome: "handover", channel: "baileys", note: expect.stringContaining("Meta 131026"), errorCode: 131026 }]);
    expect(report.handedOver).toBe(1);
  });

  it("a code with no template and no window goes to the club number too", async () => {
    rows = [code()];
    await run();
    expect(outcomes()[0][1]).toMatchObject({ outcome: "handover", channel: "baileys" });
  });

  it("an expired code is not handed over: failed", async () => {
    rows = [code({ createdAt: new Date(NOW.getTime() - 11 * 60_000) })];
    await run();
    expect(outcomes()[0][1]).toMatchObject({ outcome: "failed" });
  });

  it("an unconfirmed code is never handed over: it may have landed", async () => {
    rows = [code({ templateName: "mt_code", templateLang: "en_GB", templateParams: CODE })];
    stub.answerNext({ delayMs: 300 });
    await run({}, { timeoutMs: 30 });
    expect(outcomes()[0][1]).toMatchObject({ outcome: "unconfirmed" });
  });

  it("a pool offer is never handed over", async () => {
    stub.answerNext({ httpStatus: 400, error: { code: 131026 } });
    await run();
    expect(outcomes()[0][1]).toMatchObject({ outcome: "failed" });
  });
});

describe("the daily unique cap", () => {
  it("at the cap, a pool offer to a new person is held and a code still goes", async () => {
    recentSends = [{ phone: "447700900999", sentAt: new Date(NOW.getTime() - 3600_000) }];
    rows = [
      row({ id: "offer", phone: "447700900001" }),
      row({ id: "code", phone: "447700900002", purpose: "otp", templateName: "mt_code", templateLang: "en_GB", templateParams: CODE }),
    ];
    const report = await run({ CLOUD_DAILY_UNIQUE_CAP: "1" });
    expect(stub.requests.map((r) => (r.body as { to: string }).to)).toEqual(["447700900002"]);
    expect(Object.fromEntries(outcomes().map(([id, o]) => [id, (o as { outcome: string }).outcome]))).toEqual({ code: "sent", offer: "requeue" });
    expect(report.held).toBe(1);
  });

  it("counts the official number's sends of the last 24 hours, and his messages to it", async () => {
    await run();
    const sendsQuery = dbMock.platformJob.findMany.mock.calls.find((c) => !c[0].where.id)![0];
    expect(sendsQuery.where).toMatchObject({ channel: "cloud", status: { in: ["sent", "unconfirmed"] }, sentAt: { gt: new Date(NOW.getTime() - 24 * 3600_000) } });
    expect(dbMock.waInbound.findMany.mock.calls[0][0].where).toMatchObject({ channel: "cloud", receivedAt: { gt: new Date(NOW.getTime() - 48 * 3600_000) } });
  });
});

describe("runCloudDispatchSweep: the per-minute sweep", () => {
  it("master off: no pool switch read, no pool sweep, no claim, no request", async () => {
    const poolEnv = vi.fn();
    const report = await runCloudDispatchSweep({ now: NOW, env: env({ CLOUD_API_ENABLED: undefined }), poolEnv });
    expect(report.enabled).toBe(false);
    expect(poolEnv).not.toHaveBeenCalled();
    expect(sweeps.runPlatformPoolSweeps).not.toHaveBeenCalled();
    expect(pj.claimDuePlatformJobs).not.toHaveBeenCalled();
    expect(stub.requests).toHaveLength(0);
  });

  it("master on: the Pi's pool sweeps first, then the dispatch, with one resolved switch", async () => {
    const order: string[] = [];
    sweeps.runPlatformPoolSweeps.mockImplementation(async () => void order.push("sweeps"));
    pj.claimDuePlatformJobs.mockImplementation(async () => (order.push("claim"), []));
    const poolEnv = vi.fn(async () => ({ FROM_REQUEST: "1" }));
    await runCloudDispatchSweep({ now: NOW, env: env(), poolEnv });
    expect(order).toEqual(["sweeps", "claim"]);
    expect(poolEnv).toHaveBeenCalledTimes(1);
    expect(sweeps.runPlatformPoolSweeps).toHaveBeenCalledWith(NOW, { FROM_REQUEST: "1" }, "cloud-dispatch");
    expect(pj.claimDuePlatformJobs.mock.calls[0][0].env).toEqual({ FROM_REQUEST: "1" });
    expect(switchEnv.resolvePoolEnv).not.toHaveBeenCalled();
  });
});

// Review of #556, S4: a code already stored for the official number when it
// turns out not to be configured (a token removed, a deploy without it)
// must not wait for a dispatcher that will never claim it. While it is
// alive it is handed to the club number, with the same compare-and-set
// claim and the same outcome writer; an expired one is failed. Nothing
// else is touched: strangers never fall back.
describe("the official number not configured: codes already queued for it are handed over (review of #556, S4)", () => {
  const unconfigured = { WA_CLOUD_ACCESS_TOKEN: undefined };
  type Stranded = { id: string; phone: string; purpose: string; createdAt: Date; failReason: null; text: string };
  let stranded: Stranded[];
  const code = (id: string, ageMs: number): Stranded => ({ id, phone: "447700900001", purpose: "otp", createdAt: new Date(NOW.getTime() - ageMs), failReason: null, text: "code" });

  beforeEach(() => {
    stranded = [];
    dbMock.platformJob.findMany.mockImplementation(async () => stranded);
    dbMock.platformJob.updateMany.mockResolvedValue({ count: 1 });
  });
  const updateMany = () => dbMock.platformJob.updateMany;

  it("reads only queued codes on the official number", async () => {
    await run(unconfigured);
    expect(dbMock.platformJob.findMany.mock.calls[0][0].where).toEqual({ channel: "cloud", status: "queued", kind: "dm", purpose: "otp" });
  });

  it("a live code: claimed with a compare-and-set, then handed to the club number by the outcome writer", async () => {
    stranded = [code("c1", 60_000)];
    const report = await run(unconfigured);
    expect(updateMany()).toHaveBeenCalledWith({ where: { id: "c1", status: "queued", channel: "cloud" }, data: { status: "claimed", claimedAt: NOW } });
    expect(outcomes()).toEqual([["c1", { outcome: "handover", channel: "baileys", note: expect.stringContaining("not configured"), errorCode: null }]]);
    expect(pj.recordPlatformJobOutcome.mock.calls[0][3]).toEqual({ channel: "cloud" });
    expect(report.handedOver).toBe(1);
    expect(stub.requests).toHaveLength(0);
  });

  it("an expired code is failed, never handed over", async () => {
    stranded = [code("old", 11 * 60_000)];
    const report = await run(unconfigured);
    expect(outcomes()[0][1]).toMatchObject({ outcome: "failed" });
    expect(report.failed).toBe(1);
  });

  it("a code someone else claimed first is left alone", async () => {
    stranded = [code("c1", 60_000)];
    updateMany().mockResolvedValue({ count: 0 });
    await run(unconfigured);
    expect(pj.recordPlatformJobOutcome).not.toHaveBeenCalled();
  });
});

describe("the dispatcher's outcomes name its channel (review of #556, S1)", () => {
  it("every outcome is written only while the job is still the official number's", async () => {
    await run();
    expect(pj.recordPlatformJobOutcome).toHaveBeenCalled();
    for (const c of pj.recordPlatformJobOutcome.mock.calls) expect(c[3]).toEqual({ channel: "cloud" });
  });
});
