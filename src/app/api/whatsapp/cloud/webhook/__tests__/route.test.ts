/**
 * /api/whatsapp/cloud/webhook (WhatsApp Cloud API plan, PR C5; the path is
 * fixed by section 2 step 12). The route is a thin adapter: the GET
 * handshake, the raw body and its signature into `acceptCloudWebhook`, the
 * answer straight back and the work in `after()`.
 *
 * Proven here with CLOUD_API_ENABLED unset: the handshake works (Kemal
 * registers the webhook before any flow is on) and a signed POST is 200
 * and does nothing else. With it on: 200 at once, the work only after the
 * response, into the one DM pipeline with channel cloud.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signWebhook, statusWebhookPayload } from "../../../../../../../e2e/stubs/cloud-api";

const later = vi.hoisted(() => ({ tasks: [] as Array<() => unknown> }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => void later.tasks.push(fn),
}));
const dbMock = vi.hoisted(() => ({
  waInbound: { createMany: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  platformJob: { findFirst: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const pipeline = vi.hoisted(() => ({ handleInboundDm: vi.fn() }));
vi.mock("@/lib/inbound-dm", () => pipeline);
vi.mock("@/lib/pool/dispatch", () => ({ onPoolOfferJobSent: vi.fn(), onPoolOfferJobFailed: vi.fn() }));
const templates = vi.hoisted(() => ({ applyTemplateStatusPayload: vi.fn() }));
vi.mock("@/lib/cloud-api/template-status", () => templates);

import { GET, POST } from "../route";

const URL_BASE = "https://matchtime.ai/api/whatsapp/cloud/webhook";
const VERIFY = "kemal-made-this-up-and-kept-it";
const SECRET = "app-secret";
const NUMBER_ID = "106540352242922";

const get = (q: Record<string, string>) => GET(new Request(`${URL_BASE}?${new URLSearchParams(q)}`));
function post(payload: unknown, signature?: string | null) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const sig = signature === undefined ? signWebhook(raw, SECRET) : signature;
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  return POST(new Request(URL_BASE, { method: "POST", headers, body: raw }));
}
const TEXT = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "waba",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "447700900000", phone_number_id: NUMBER_ID },
            contacts: [{ profile: { name: "Emre" }, wa_id: "905321112233" }],
            messages: [{ from: "905321112233", id: "wamid.TR1", timestamp: "1762516770", type: "text", text: { body: "Perşembe oynayabilir miyim?" } }],
          },
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  later.tasks.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("WA_CLOUD_VERIFY_TOKEN", VERIFY);
  vi.stubEnv("WA_CLOUD_APP_SECRET", SECRET);
  vi.stubEnv("WA_CLOUD_PHONE_NUMBER_ID", NUMBER_ID);
  vi.stubEnv("CLOUD_API_ENABLED", "");
  dbMock.waInbound.createMany.mockResolvedValue({ count: 1 });
  dbMock.waInbound.updateMany.mockResolvedValue({ count: 1 });
  dbMock.platformJob.findFirst.mockResolvedValue(null);
  pipeline.handleInboundDm.mockResolvedValue(Response.json({ ok: true, handled: "dm-qa" }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const untouched = () => {
  for (const t of Object.values(dbMock)) for (const fn of Object.values(t)) expect(fn).not.toHaveBeenCalled();
  expect(pipeline.handleInboundDm).not.toHaveBeenCalled();
  expect(templates.applyTemplateStatusPayload).not.toHaveBeenCalled();
  expect(later.tasks).toHaveLength(0);
};

describe("GET: Meta's handshake", () => {
  it("answers 200 with the challenge, as plain text, with CLOUD_API_ENABLED unset", async () => {
    const res = await get({ "hub.mode": "subscribe", "hub.verify_token": VERIFY, "hub.challenge": "1158201444" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1158201444");
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    untouched();
  });

  it("403 for a wrong token, a wrong mode, or no token configured", async () => {
    expect((await get({ "hub.mode": "subscribe", "hub.verify_token": "guess", "hub.challenge": "1" })).status).toBe(403);
    expect((await get({ "hub.mode": "unsubscribe", "hub.verify_token": VERIFY, "hub.challenge": "1" })).status).toBe(403);
    vi.stubEnv("WA_CLOUD_VERIFY_TOKEN", "");
    const res = await get({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("1");
  });
});

describe("POST with CLOUD_API_ENABLED unset", () => {
  it("a signed POST verifies and returns 200, and does nothing else: no DB write, no pipeline, nothing after the response", async () => {
    const res = await post(TEXT);
    expect(res.status).toBe(200);
    const status = await post(statusWebhookPayload({ phoneNumberId: NUMBER_ID, wamid: "wamid.A", recipient: "447700900001", status: "read" }));
    expect(status.status).toBe(200);
    untouched();
  });

  it("an unsigned or wrongly signed POST is still 401", async () => {
    expect((await post(TEXT, null)).status).toBe(401);
    expect((await post(TEXT, signWebhook("{}", SECRET))).status).toBe(401);
    untouched();
  });
});

describe("POST with CLOUD_API_ENABLED on", () => {
  beforeEach(() => vi.stubEnv("CLOUD_API_ENABLED", "1"));

  it("401 on a bad signature, and nothing is scheduled", async () => {
    expect((await post(TEXT, "sha256=" + "0".repeat(64))).status).toBe(401);
    untouched();
  });

  it("checks the signature over the raw bytes (a Turkish body), answers 200 at once, and runs the pipeline only after the response", async () => {
    const res = await post(TEXT);
    expect(res.status).toBe(200);
    expect(dbMock.waInbound.createMany).toHaveBeenCalledTimes(1);
    expect(pipeline.handleInboundDm).not.toHaveBeenCalled();
    expect(later.tasks).toHaveLength(1);
    await later.tasks[0]();
    expect(pipeline.handleInboundDm).toHaveBeenCalledTimes(1);
    const [dm, ctx] = pipeline.handleInboundDm.mock.calls[0];
    expect(dm).toMatchObject({ phone: "905321112233", body: "Perşembe oynayabilir miyim?", waMessageId: "wamid.TR1", authorName: "Emre" });
    expect(ctx.channel).toBe("cloud");
    expect(ctx.request).toBeInstanceOf(Request);
  });

  it("Meta's duplicate of the same message is answered 200 and never processed twice", async () => {
    await post(TEXT);
    await later.tasks[0]();
    // The second delivery: the row exists (nothing new written) and its
    // claim is lost.
    dbMock.waInbound.createMany.mockResolvedValueOnce({ count: 0 });
    dbMock.waInbound.updateMany.mockResolvedValueOnce({ count: 0 });
    const again = await post(TEXT);
    expect(again.status).toBe(200);
    await later.tasks[1]();
    expect(pipeline.handleInboundDm).toHaveBeenCalledTimes(1);
  });

  it("a status webhook from the Cloud API stub settles its job after the response", async () => {
    dbMock.platformJob.findFirst.mockResolvedValueOnce({ id: "job1", status: "sent", waMessageId: "wamid.A", sentAt: new Date(), deliveredAt: null, readAt: null });
    dbMock.platformJob.updateMany.mockResolvedValueOnce({ count: 1 });
    const res = await post(statusWebhookPayload({ phoneNumberId: NUMBER_ID, wamid: "wamid.A", recipient: "447700900001", status: "delivered", bizOpaqueCallbackData: "job1" }));
    expect(res.status).toBe(200);
    expect(dbMock.platformJob.findFirst).not.toHaveBeenCalled();
    await later.tasks[0]();
    expect(dbMock.platformJob.updateMany.mock.calls[0][0].data).toHaveProperty("deliveredAt");
  });

  it("a work that throws is caught after the response", async () => {
    dbMock.waInbound.updateMany.mockRejectedValueOnce(new Error("db"));
    await post(TEXT);
    await expect(Promise.resolve(later.tasks[0]())).resolves.toBeUndefined();
  });
});
