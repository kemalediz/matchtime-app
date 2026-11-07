/**
 * THE CLOUD WEBHOOK, THE I/O HALF (WhatsApp Cloud API plan, PR C5,
 * sections 5.2 to 5.4). `acceptCloudWebhook` checks the signature, reads
 * the flag, records every message once in `WaInbound` and hands back the
 * work for `after()`; that work puts each text into THE ONE DM PIPELINE
 * (`handleInboundDm`, channel cloud), applies statuses to the matching
 * cloud PlatformJob, hands template updates to C6 and logs Meta's
 * marketing stop for C8. `sweepCloudInbound` runs a recorded message the
 * work never started.
 *
 * db, the pipeline, the pool's hooks and C6's writer are mocked; the
 * parser, the status rules and the signature are real. Payloads come
 * from the Cloud API stub's helpers and Meta's own examples.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signWebhook, statusWebhookPayload } from "../../../../e2e/stubs/cloud-api";

const dbMock = vi.hoisted(() => ({
  waInbound: { createMany: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  platformJob: { findFirst: vi.fn(), updateMany: vi.fn() },
  poolProfile: { updateMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const pipeline = vi.hoisted(() => ({ handleInboundDm: vi.fn() }));
vi.mock("@/lib/inbound-dm", () => pipeline);
const pool = vi.hoisted(() => ({ onPoolOfferJobSent: vi.fn(), onPoolOfferJobFailed: vi.fn() }));
vi.mock("@/lib/pool/dispatch", () => pool);
const templates = vi.hoisted(() => ({ applyTemplateStatusPayload: vi.fn() }));
vi.mock("@/lib/cloud-api/template-status", () => templates);

import {
  INBOUND_MAX_ATTEMPTS,
  INBOUND_RETRY_AFTER_MS,
  INBOUND_SWEEP_AFTER_MS,
  acceptCloudWebhook,
  databaseUnavailable,
  sweepCloudInbound,
} from "../webhook";

const SECRET = "app-secret";
const OUR_NUMBER_ID = "106540352242922";
const ON = { CLOUD_API_ENABLED: "1", WA_CLOUD_APP_SECRET: SECRET, WA_CLOUD_PHONE_NUMBER_ID: OUR_NUMBER_ID };
const OFF = { WA_CLOUD_APP_SECRET: SECRET, WA_CLOUD_PHONE_NUMBER_ID: OUR_NUMBER_ID };
const NOW = new Date("2026-11-07T12:00:00Z");
/** The claim's stamp: `result` while a run holds the row. */
const CLAIMED_NOW = `processing since ${NOW.toISOString()}`;
/** An error as Prisma throws it, with its code. */
function prismaError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: "PrismaClientKnownRequestError", code });
}
const TEXT_BODY = "Can I still play on Thursday?";
const request = new Request("https://matchtime.ai/api/whatsapp/cloud/webhook", { method: "POST" });

function messagesPayload(value: Record<string, unknown>, phoneNumberId = OUR_NUMBER_ID): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "waba", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "447700900000", phone_number_id: phoneNumberId }, ...value } }] }],
  };
}
const textMsg = (over: Record<string, unknown> = {}) => ({ from: "447700900001", id: "wamid.T1", timestamp: String(NOW.getTime() / 1000 - 30), type: "text", text: { body: TEXT_BODY }, ...over });
const TEXT_PAYLOAD = messagesPayload({ contacts: [{ profile: { name: "Sam" }, wa_id: "447700900001" }], messages: [textMsg()] });

async function accept(payload: unknown, env: Record<string, string> = ON, signature?: string | null) {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  return acceptCloudWebhook({ rawBody: raw, signature: signature === undefined ? signWebhook(raw.toString("utf8"), SECRET) : signature, request, env, now: () => NOW });
}

let logs: string[];
beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  for (const k of ["log", "warn", "error"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  dbMock.waInbound.createMany.mockResolvedValue({ count: 1 });
  dbMock.waInbound.updateMany.mockResolvedValue({ count: 1 });
  dbMock.waInbound.findMany.mockResolvedValue([]);
  dbMock.platformJob.findFirst.mockResolvedValue(null);
  dbMock.platformJob.updateMany.mockResolvedValue({ count: 1 });
  pipeline.handleInboundDm.mockResolvedValue(Response.json({ ok: true, handled: "dm-qa" }));
  templates.applyTemplateStatusPayload.mockResolvedValue({ written: 1, failed: 0, upcoming: 0 });
});
afterEach(() => {
  vi.restoreAllMocks();
  // Never the text he wrote, never a secret, in any log line.
  for (const line of logs) {
    expect(line).not.toContain(TEXT_BODY);
    expect(line).not.toContain(SECRET);
  }
});

const nothingTouched = () => {
  for (const t of [dbMock.waInbound, dbMock.platformJob, dbMock.poolProfile]) for (const fn of Object.values(t)) expect(fn).not.toHaveBeenCalled();
  expect(pipeline.handleInboundDm).not.toHaveBeenCalled();
  expect(templates.applyTemplateStatusPayload).not.toHaveBeenCalled();
};

describe("acceptCloudWebhook: the signature comes first", () => {
  it("a missing, malformed or wrong signature is 401 and nothing is read or written, flag on or off", async () => {
    for (const env of [ON, OFF]) {
      for (const sig of [null, "", "sha256=abc", signWebhook("{}", SECRET), signWebhook(JSON.stringify(TEXT_PAYLOAD), "wrong-secret")]) {
        const r = await accept(TEXT_PAYLOAD, env, sig);
        expect(r.status).toBe(401);
        expect(r.work).toBeNull();
      }
    }
    nothingTouched();
  });

  it("no app secret configured: 401 for everything", async () => {
    const r = await accept(TEXT_PAYLOAD, { CLOUD_API_ENABLED: "1" }, signWebhook(JSON.stringify(TEXT_PAYLOAD), ""));
    expect(r.status).toBe(401);
    nothingTouched();
  });
});

describe("acceptCloudWebhook: CLOUD_API_ENABLED off", () => {
  it("a signed POST is 200 and does nothing else: no DB write, no pipeline, no work", async () => {
    const r = await accept(TEXT_PAYLOAD, OFF);
    expect(r.status).toBe(200);
    expect(r.work).toBeNull();
    const statusPost = await accept(statusWebhookPayload({ phoneNumberId: OUR_NUMBER_ID, wamid: "wamid.A", recipient: "447700900001", status: "delivered" }), OFF);
    expect(statusPost.status).toBe(200);
    expect(statusPost.work).toBeNull();
    nothingTouched();
  });
});

describe("acceptCloudWebhook: a message is recorded once, before the 200", () => {
  it("writes the WaInbound row (channel cloud, wamid, phone, Meta's time) with the pipeline's input, skipping duplicates", async () => {
    const r = await accept(TEXT_PAYLOAD);
    expect(r.status).toBe(200);
    expect(dbMock.waInbound.createMany).toHaveBeenCalledTimes(1);
    const arg = dbMock.waInbound.createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toEqual([
      {
        channel: "cloud",
        wamid: "wamid.T1",
        phone: "447700900001",
        waUserId: null,
        receivedAt: new Date(NOW.getTime() - 30_000),
        payload: { phone: "447700900001", body: TEXT_BODY, waMessageId: "wamid.T1", authorName: "Sam", timestamp: String(NOW.getTime() / 1000 - 30) },
      },
    ]);
    // Nothing processed before the response: that is the work's job.
    expect(pipeline.handleInboundDm).not.toHaveBeenCalled();
    expect(r.work).toBeTypeOf("function");
  });

  it("a message with no text is recorded already processed (it still opens his window)", async () => {
    await accept(messagesPayload({ messages: [{ from: "447700900001", id: "wamid.R1", timestamp: "1762516770", type: "reaction", reaction: { message_id: "wamid.X", emoji: "👍" } }] }));
    expect(dbMock.waInbound.createMany.mock.calls[0][0].data).toEqual([
      { channel: "cloud", wamid: "wamid.R1", phone: "447700900001", waUserId: null, receivedAt: new Date(1762516770 * 1000), payload: { type: "reaction" }, processedAt: NOW, result: "no text: reaction" },
    ]);
  });

  it("Meta's time in the future, or missing, is now", async () => {
    await accept(messagesPayload({ messages: [textMsg({ timestamp: String(NOW.getTime() / 1000 + 3600) })] }));
    expect(dbMock.waInbound.createMany.mock.calls[0][0].data[0].receivedAt).toEqual(NOW);
  });

  it("a username with no phone is recorded by his user id", async () => {
    await accept(messagesPayload({ contacts: [{ profile: { name: "Sheena" }, user_id: "US.134" }], messages: [{ from_user_id: "US.134", id: "wamid.U1", timestamp: "1762516770", type: "text", text: { body: "hi" } }] }));
    expect(dbMock.waInbound.createMany.mock.calls[0][0].data[0]).toMatchObject({ phone: null, waUserId: "US.134" });
  });

  it("a message to another of the app's numbers (Meta's test number) is not ours: not recorded", async () => {
    const r = await accept(messagesPayload({ messages: [textMsg()] }, "999"));
    expect(r.status).toBe(200);
    expect(dbMock.waInbound.createMany).not.toHaveBeenCalled();
    await r.work?.();
    expect(pipeline.handleInboundDm).not.toHaveBeenCalled();
  });

  it("the database unavailable is a 500, so Meta sends it again (the wamid makes that safe)", async () => {
    dbMock.waInbound.createMany.mockRejectedValueOnce(prismaError("P1001", "Can't reach database server"));
    const r = await accept(TEXT_PAYLOAD);
    expect(r.status).toBe(500);
    expect(r.work).toBeNull();
  });

  it("one row the database will not take does not sink the others: written one by one, that one logged by wamid and skipped (review of #554, item 1)", async () => {
    const three = messagesPayload({ messages: [textMsg(), textMsg({ id: "wamid.T2" }), textMsg({ id: "wamid.T3" })] });
    dbMock.waInbound.createMany
      .mockRejectedValueOnce(prismaError("P2010", "invalid input syntax"))
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(prismaError("P2010", "invalid input syntax"))
      .mockResolvedValueOnce({ count: 1 });
    const r = await accept(three);
    expect(r.status).toBe(200);
    const perRow = dbMock.waInbound.createMany.mock.calls.slice(1).map((c) => c[0]);
    expect(perRow.map((a) => [a.data.map((d: { wamid: string }) => d.wamid), a.skipDuplicates])).toEqual([
      [["wamid.T1"], true],
      [["wamid.T2"], true],
      [["wamid.T3"], true],
    ]);
    expect(logs.some((l) => l.includes("wamid.T2") && l.includes("not recorded"))).toBe(true);
    // Only what was written is run.
    await r.work!();
    expect(pipeline.handleInboundDm.mock.calls.map((c) => c[0].waMessageId)).toEqual(["wamid.T1", "wamid.T3"]);
  });

  it("the database going away part way through the one-by-one writes is still a 500", async () => {
    dbMock.waInbound.createMany.mockRejectedValueOnce(prismaError("P2010", "bad row")).mockRejectedValueOnce(prismaError("P1017", "Server has closed the connection."));
    const r = await accept(TEXT_PAYLOAD);
    expect(r.status).toBe(500);
  });

  it("a signed body that is not JSON is 200 and nothing (sending it again would not help)", async () => {
    const raw = Buffer.from("not json");
    const r = await acceptCloudWebhook({ rawBody: raw, signature: signWebhook("not json", SECRET), request, env: ON, now: () => NOW });
    expect(r.status).toBe(200);
    expect(r.work).toBeNull();
    nothingTouched();
  });
});

describe("the work: every text into the ONE DM pipeline, once", () => {
  it("claims the row (attempts 0 to 1), calls handleInboundDm with channel cloud, and records what it did", async () => {
    const r = await accept(TEXT_PAYLOAD);
    await r.work!();
    expect(dbMock.waInbound.updateMany.mock.calls[0][0]).toEqual({
      where: { channel: "cloud", wamid: "wamid.T1", processedAt: null, attempts: 0 },
      data: { attempts: 1, result: CLAIMED_NOW },
    });
    expect(pipeline.handleInboundDm).toHaveBeenCalledTimes(1);
    expect(pipeline.handleInboundDm).toHaveBeenCalledWith(
      { phone: "447700900001", body: TEXT_BODY, waMessageId: "wamid.T1", authorName: "Sam", timestamp: String(NOW.getTime() / 1000 - 30) },
      { channel: "cloud", request },
    );
    // Only the run that holds the claim may close it.
    expect(dbMock.waInbound.updateMany.mock.calls[1][0]).toEqual({
      where: { channel: "cloud", wamid: "wamid.T1", processedAt: null, result: CLAIMED_NOW },
      data: { processedAt: NOW, result: "200 dm-qa" },
    });
  });

  it("a final write that fails is tried once more", async () => {
    dbMock.waInbound.updateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce({ count: 1 });
    const r = await accept(TEXT_PAYLOAD);
    await r.work!();
    const closes = dbMock.waInbound.updateMany.mock.calls.map((c) => c[0]).filter((a) => a.data.processedAt);
    expect(closes).toHaveLength(2);
  });

  it("a duplicate (Meta's retry, or the sweep got there first) is never processed twice", async () => {
    dbMock.waInbound.updateMany.mockResolvedValueOnce({ count: 0 });
    const r = await accept(TEXT_PAYLOAD);
    await r.work!();
    expect(pipeline.handleInboundDm).not.toHaveBeenCalled();
  });

  it("a button reply goes in as its text; a reaction does not go in at all", async () => {
    const r = await accept(
      messagesPayload({
        messages: [
          { context: { from: "447700900000", id: "wamid.OFFER" }, from: "447700900001", id: "wamid.B1", timestamp: "1762516770", type: "button", button: { payload: "p", text: "Stop game offers" } },
          { from: "447700900001", id: "wamid.R1", timestamp: "1762516770", type: "reaction", reaction: { message_id: "wamid.X", emoji: "👍" } },
        ],
      }),
    );
    await r.work!();
    expect(pipeline.handleInboundDm).toHaveBeenCalledTimes(1);
    expect(pipeline.handleInboundDm.mock.calls[0][0]).toMatchObject({ body: "Stop game offers", waMessageId: "wamid.B1", quotedMessageId: "wamid.OFFER", quotedFromMatchTime: true });
  });

  it("a pipeline that throws is recorded as an error and not retried (at most once, as the Pi's DMs); the next message still runs", async () => {
    pipeline.handleInboundDm.mockRejectedValueOnce(new TypeError("boom"));
    const r = await accept(messagesPayload({ messages: [textMsg(), textMsg({ id: "wamid.T2" })] }));
    await expect(r.work!()).resolves.toBeDefined();
    expect(pipeline.handleInboundDm).toHaveBeenCalledTimes(2);
    const marks = dbMock.waInbound.updateMany.mock.calls.map((c) => c[0]).filter((a) => a.data.processedAt);
    expect(marks.map((a) => [a.where.wamid, a.data.result])).toEqual([
      ["wamid.T1", "error: TypeError"],
      ["wamid.T2", "200 dm-qa"],
    ]);
  });

  it("a claim the database refuses leaves the row unstarted for the sweep, and the rest of the POST still runs", async () => {
    dbMock.waInbound.updateMany.mockRejectedValueOnce(new Error("db"));
    const r = await accept(messagesPayload({ messages: [textMsg(), textMsg({ id: "wamid.T2" })] }));
    const report = await r.work!();
    expect(pipeline.handleInboundDm).toHaveBeenCalledTimes(1);
    expect(pipeline.handleInboundDm.mock.calls[0][0].waMessageId).toBe("wamid.T2");
    expect(report.processed).toBe(1);
  });

  it("the result keeps only the pipeline's own short labels, never free text", async () => {
    pipeline.handleInboundDm.mockResolvedValueOnce(Response.json({ ok: true, handled: "has spaces, maybe words" }));
    const r = await accept(TEXT_PAYLOAD);
    await r.work!();
    expect(dbMock.waInbound.updateMany.mock.calls[1][0].data.result).toBe("200");
  });
});

describe("the work: statuses settle the cloud job, idempotently", () => {
  const job = (over: Record<string, unknown> = {}) => ({ id: "job1", status: "sent", channel: "cloud", purpose: "pool-offer", createdAt: new Date(NOW.getTime() - 120_000), waMessageId: "wamid.A", sentAt: new Date(NOW.getTime() - 60_000), deliveredAt: null, readAt: null, ...over });
  const statusPost = (status: "sent" | "delivered" | "read" | "failed", extra: Record<string, unknown> = {}) =>
    accept(statusWebhookPayload({ phoneNumberId: OUR_NUMBER_ID, wamid: "wamid.A", recipient: "447700900001", status, timestamp: new Date(NOW.getTime() - 5_000), bizOpaqueCallbackData: "job1", ...extra }));

  it("finds the job on the official number by wamid, or by the job id we set when it has no wamid yet", async () => {
    const r = await statusPost("delivered");
    await r.work!();
    expect(dbMock.platformJob.findFirst.mock.calls[0][0].where).toEqual({ channel: "cloud", OR: [{ waMessageId: "wamid.A" }, { id: "job1", waMessageId: null }] });
  });

  it("delivered stamps deliveredAt with a compare-and-set on the status read; no pool hook", async () => {
    dbMock.platformJob.findFirst.mockResolvedValueOnce(job());
    const r = await statusPost("delivered");
    await r.work!();
    expect(dbMock.platformJob.updateMany).toHaveBeenCalledWith({ where: { id: "job1", status: "sent", channel: "cloud", deliveredAt: null }, data: { deliveredAt: new Date(NOW.getTime() - 5_000) } });
    expect(pool.onPoolOfferJobSent).not.toHaveBeenCalled();
    expect(pool.onPoolOfferJobFailed).not.toHaveBeenCalled();
  });

  it("the same delivered again writes nothing", async () => {
    dbMock.platformJob.findFirst.mockResolvedValueOnce(job({ deliveredAt: new Date() }));
    const r = await statusPost("delivered");
    await r.work!();
    expect(dbMock.platformJob.updateMany).not.toHaveBeenCalled();
  });

  it("an unconfirmed job settled by delivered: sent, and the pool's delivered hook runs", async () => {
    dbMock.platformJob.findFirst.mockResolvedValueOnce(job({ status: "unconfirmed", waMessageId: null }));
    const r = await statusPost("delivered");
    await r.work!();
    expect(dbMock.platformJob.updateMany.mock.calls[0][0]).toEqual({
      where: { id: "job1", status: "unconfirmed", channel: "cloud", waMessageId: null, deliveredAt: null },
      data: { status: "sent", waMessageId: "wamid.A", deliveredAt: new Date(NOW.getTime() - 5_000) },
    });
    expect(pool.onPoolOfferJobSent).toHaveBeenCalledWith("job1", NOW, new Date(NOW.getTime() - 60_000));
  });

  it("failed: the job fails with Meta's code, and the pool's failed hook runs", async () => {
    dbMock.platformJob.findFirst.mockResolvedValueOnce(job({ status: "unconfirmed", waMessageId: null }));
    const r = await statusPost("failed", { errors: [{ code: 131026, title: "Message undeliverable" }] });
    await r.work!();
    expect(dbMock.platformJob.updateMany.mock.calls[0][0].data).toMatchObject({ status: "failed", errorCode: 131026 });
    expect(pool.onPoolOfferJobFailed).toHaveBeenCalledWith("job1", NOW);
  });

  it("a lost compare-and-set (another delivery of the same status won) runs no hook", async () => {
    dbMock.platformJob.findFirst.mockResolvedValueOnce(job({ status: "unconfirmed", waMessageId: null }));
    dbMock.platformJob.updateMany.mockResolvedValueOnce({ count: 0 });
    const r = await statusPost("failed", { errors: [{ code: 131026 }] });
    await r.work!();
    expect(pool.onPoolOfferJobFailed).not.toHaveBeenCalled();
  });

  it("failed racing a delivered that landed first (review of #554, item 5): its compare-and-set needs delivered and read empty, so it loses, re-reads, and writes nothing", async () => {
    dbMock.platformJob.findFirst.mockResolvedValueOnce(job()).mockResolvedValueOnce(job({ deliveredAt: new Date(NOW.getTime() - 4_000) }));
    dbMock.platformJob.updateMany.mockResolvedValueOnce({ count: 0 });
    const r = await statusPost("failed", { errors: [{ code: 131026 }] });
    await r.work!();
    expect(dbMock.platformJob.updateMany).toHaveBeenCalledTimes(1);
    expect(dbMock.platformJob.updateMany.mock.calls[0][0].where).toEqual({ id: "job1", status: "sent", channel: "cloud", deliveredAt: null, readAt: null });
    expect(pool.onPoolOfferJobFailed).not.toHaveBeenCalled();
  });

  it("read racing a delivered that landed first: it re-reads and writes only readAt, never over delivered's time", async () => {
    const deliveredAt = new Date(NOW.getTime() - 4_000);
    dbMock.platformJob.findFirst.mockResolvedValueOnce(job()).mockResolvedValueOnce(job({ deliveredAt }));
    dbMock.platformJob.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    const r = await statusPost("read");
    await r.work!();
    expect(dbMock.platformJob.updateMany.mock.calls[1][0]).toEqual({ where: { id: "job1", status: "sent", channel: "cloud", readAt: null }, data: { readAt: new Date(NOW.getTime() - 5_000) } });
  });

  it("every compare-and-set names the official number's channel, so a job handed to the club number is never written again", async () => {
    dbMock.platformJob.findFirst.mockResolvedValueOnce(job());
    const r = await statusPost("delivered");
    await r.work!();
    expect(dbMock.platformJob.findFirst.mock.calls[0][0].select).toMatchObject({ channel: true, purpose: true, createdAt: true });
    expect(dbMock.platformJob.updateMany.mock.calls[0][0].where).toMatchObject({ channel: "cloud" });
  });

  it("a live code that fails after Meta accepted it is handed to the club number, no pool hook (review of #556, S1)", async () => {
    dbMock.platformJob.findFirst.mockResolvedValueOnce(job({ purpose: "otp" }));
    const r = await statusPost("failed", { errors: [{ code: 131026, title: "Message undeliverable" }] });
    await r.work!();
    expect(dbMock.platformJob.updateMany).toHaveBeenCalledTimes(1);
    expect(dbMock.platformJob.updateMany.mock.calls[0][0]).toEqual({
      where: { id: "job1", status: "sent", channel: "cloud", waMessageId: "wamid.A", deliveredAt: null, readAt: null },
      data: expect.objectContaining({ status: "queued", channel: "baileys", waMessageId: null, sentAt: null, errorCode: 131026 }),
    });
    expect(pool.onPoolOfferJobFailed).not.toHaveBeenCalled();
    expect(pool.onPoolOfferJobSent).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("job1") && l.includes("handed to the club number"))).toBe(true);
  });

  it("an expired code that fails is only failed (review of #556, S1)", async () => {
    dbMock.platformJob.findFirst.mockResolvedValueOnce(job({ purpose: "otp", createdAt: new Date(NOW.getTime() - 11 * 60_000) }));
    const r = await statusPost("failed", { errors: [{ code: 131026 }] });
    await r.work!();
    expect(dbMock.platformJob.updateMany.mock.calls[0][0].data).toMatchObject({ status: "failed", errorCode: 131026 });
    expect(dbMock.platformJob.updateMany.mock.calls[0][0].data).not.toHaveProperty("channel");
  });

  it("a status that keeps losing gives up after three tries", async () => {
    dbMock.platformJob.findFirst.mockResolvedValue(job());
    dbMock.platformJob.updateMany.mockResolvedValue({ count: 0 });
    const r = await statusPost("delivered");
    await r.work!();
    expect(dbMock.platformJob.updateMany).toHaveBeenCalledTimes(3);
  });

  it("a status for no job of ours writes nothing", async () => {
    const r = await statusPost("read");
    await r.work!();
    expect(dbMock.platformJob.updateMany).not.toHaveBeenCalled();
  });

  it("a status on another of the app's numbers is not looked up", async () => {
    const r = await accept(statusWebhookPayload({ phoneNumberId: "999", wamid: "wamid.A", recipient: "447700900001", status: "delivered" }));
    await r.work?.();
    expect(dbMock.platformJob.findFirst).not.toHaveBeenCalled();
  });

  it("a status write that throws does not stop the rest of the POST", async () => {
    dbMock.platformJob.findFirst.mockRejectedValueOnce(new Error("db")).mockResolvedValueOnce(job());
    const payload = messagesPayload({
      statuses: [
        { id: "wamid.Z", status: "delivered", timestamp: "1762516770", recipient_id: "447700900001" },
        { id: "wamid.A", status: "read", timestamp: "1762516770", recipient_id: "447700900001" },
      ],
    });
    const r = await accept(payload);
    await r.work!();
    expect(dbMock.platformJob.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("the work: template updates, Meta's marketing stop, the rest", () => {
  it("template status and category updates go to C6's writer with the whole payload", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ id: "waba", changes: [{ field: "message_template_status_update", value: { event: "APPROVED", message_template_id: 1, message_template_name: "mt_code", message_template_language: "en_GB", reason: "NONE" } }] }],
    };
    const r = await accept(payload);
    await r.work!();
    expect(templates.applyTemplateStatusPayload).toHaveBeenCalledWith(payload);
  });

  it("only our WhatsApp account's entries are used: Meta's test account's template, message and status are dropped (review of #554, item 3)", async () => {
    const env = { ...ON, WA_CLOUD_WABA_ID: "OUR_WABA" };
    const tpl = (id: string, event: string) => ({ id, changes: [{ field: "message_template_status_update", value: { event, message_template_name: "mt_code", message_template_language: "en_GB" } }] });
    const msgs = (id: string, wamid: string) => ({
      id,
      changes: [{ field: "messages", value: { metadata: { phone_number_id: OUR_NUMBER_ID }, messages: [textMsg({ id: wamid })], statuses: [{ id: "wamid.A", status: "delivered", timestamp: "1762516770" }] } }],
    });
    const payload = { object: "whatsapp_business_account", entry: [tpl("OUR_WABA", "APPROVED"), tpl("TEST_WABA", "REJECTED"), msgs("TEST_WABA", "wamid.THEIRS"), msgs("OUR_WABA", "wamid.OURS")] };
    const r = await accept(payload, env);
    expect(dbMock.waInbound.createMany.mock.calls[0][0].data.map((d: { wamid: string }) => d.wamid)).toEqual(["wamid.OURS"]);
    await r.work!();
    expect(templates.applyTemplateStatusPayload).toHaveBeenCalledWith({ object: "whatsapp_business_account", entry: [tpl("OUR_WABA", "APPROVED"), msgs("OUR_WABA", "wamid.OURS")] });
    expect(dbMock.platformJob.findFirst).toHaveBeenCalledTimes(1);
    expect(pipeline.handleInboundDm.mock.calls.map((c) => c[0].waMessageId)).toEqual(["wamid.OURS"]);
  });

  it("a POST that is only another account's is 200 and touches nothing", async () => {
    const r = await accept({ object: "whatsapp_business_account", entry: [{ id: "TEST_WABA", changes: [{ field: "messages", value: { messages: [textMsg()] } }] }] }, { ...ON, WA_CLOUD_WABA_ID: "OUR_WABA" });
    expect(r.status).toBe(200);
    await r.work?.();
    nothingTouched();
  });

  it("no template field: C6's writer is not called", async () => {
    const r = await accept(TEXT_PAYLOAD);
    await r.work!();
    expect(templates.applyTemplateStatusPayload).not.toHaveBeenCalled();
  });

  it("user_preferences (he stopped marketing) is logged for C8 with his number, and nothing is written", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba",
          changes: [
            {
              field: "user_preferences",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "447700900000", phone_number_id: OUR_NUMBER_ID },
                user_preferences: [{ wa_id: "447700900001", user_id: "GB.42", detail: "User requested to stop marketing messages", category: "marketing_messages", value: "stop", timestamp: 1762516770 }],
              },
            },
          ],
        },
      ],
    };
    const r = await accept(payload);
    const report = await r.work!();
    expect(report.preferences).toEqual([{ phone: "447700900001", waUserId: "GB.42", category: "marketing_messages", value: "stop", at: new Date(1762516770 * 1000) }]);
    expect(logs.some((l) => l.includes("user_preferences") && l.includes("447700900001") && l.includes("stop"))).toBe(true);
    expect(dbMock.poolProfile.updateMany).not.toHaveBeenCalled();
    expect(dbMock.waInbound.createMany).not.toHaveBeenCalled();
  });
});

describe("sweepCloudInbound: a recorded message the work never started", () => {
  const row = (over: Record<string, unknown> = {}) => ({ wamid: "wamid.T1", payload: { phone: "447700900001", body: TEXT_BODY, waMessageId: "wamid.T1" }, ...over });

  it("does nothing at all with CLOUD_API_ENABLED off", async () => {
    const out = await sweepCloudInbound({ request, now: NOW, env: OFF });
    expect(out).toEqual({ started: 0, retried: 0, abandoned: 0 });
    nothingTouched();
  });

  it("picks unstarted rows older than the grace period and runs them through the same pipeline, once", async () => {
    dbMock.waInbound.findMany.mockResolvedValueOnce([row()]);
    const out = await sweepCloudInbound({ request, now: NOW, env: ON });
    expect(dbMock.waInbound.findMany.mock.calls[0][0].where).toEqual({
      channel: "cloud",
      processedAt: null,
      attempts: 0,
      receivedAt: { lt: new Date(NOW.getTime() - INBOUND_SWEEP_AFTER_MS) },
    });
    expect(pipeline.handleInboundDm).toHaveBeenCalledWith(row().payload, { channel: "cloud", request });
    expect(out).toEqual({ started: 1, retried: 0, abandoned: 0 });
  });

  it("a row someone else claimed first is skipped", async () => {
    dbMock.waInbound.findMany.mockResolvedValueOnce([row()]);
    dbMock.waInbound.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await sweepCloudInbound({ request, now: NOW, env: ON })).toEqual({ started: 0, retried: 0, abandoned: 0 });
    expect(pipeline.handleInboundDm).not.toHaveBeenCalled();
  });

  it("a payload the pipeline cannot read is closed, not run", async () => {
    dbMock.waInbound.findMany.mockResolvedValueOnce([row({ payload: { phone: "447700900001" } })]);
    await sweepCloudInbound({ request, now: NOW, env: ON });
    expect(pipeline.handleInboundDm).not.toHaveBeenCalled();
    expect(dbMock.waInbound.updateMany.mock.calls.at(-1)![0].data).toEqual({ processedAt: NOW, result: "unreadable payload" });
  });
});

describe("sweepCloudInbound: a claimed message whose run died is retried once (review of #554, item 2)", () => {
  const OLD_CLAIM = `processing since ${new Date(NOW.getTime() - INBOUND_RETRY_AFTER_MS - 1_000).toISOString()}`;
  const YOUNG_CLAIM = `processing since ${new Date(NOW.getTime() - INBOUND_RETRY_AFTER_MS + 60_000).toISOString()}`;
  const stuck = (over: Record<string, unknown> = {}) => ({ wamid: "wamid.T1", attempts: 1, result: OLD_CLAIM, payload: { phone: "447700900001", body: TEXT_BODY, waMessageId: "wamid.T1" }, ...over });
  /** The first findMany is the unstarted rows, the second the stuck ones. */
  const withStuck = (...rows: unknown[]) => dbMock.waInbound.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(rows);

  it("the retry wait is comfortably above the routes' maximum run time, so the first run is dead by then", async () => {
    const webhook = await import("@/app/api/whatsapp/cloud/webhook/route");
    const cron = await import("@/app/api/cron/cloud-dispatch/route");
    for (const maxDuration of [webhook.maxDuration, cron.maxDuration]) {
      expect(maxDuration).toBeGreaterThan(0);
      expect(INBOUND_RETRY_AFTER_MS).toBeGreaterThanOrEqual(2 * maxDuration * 1000);
    }
    expect(INBOUND_MAX_ATTEMPTS).toBe(2);
  });

  it("looks for unprocessed rows still marked processing, with attempts left or used up", async () => {
    withStuck();
    await sweepCloudInbound({ request, now: NOW, env: ON });
    expect(dbMock.waInbound.findMany.mock.calls[1][0].where).toEqual({ channel: "cloud", processedAt: null, attempts: { gte: 1 }, result: { startsWith: "processing since " } });
  });

  it("re-claims a row claimed over the retry wait ago with the same compare-and-set (attempts 1 to 2, on the exact claim it read) and runs it once more", async () => {
    withStuck(stuck());
    const out = await sweepCloudInbound({ request, now: NOW, env: ON });
    expect(dbMock.waInbound.updateMany.mock.calls[0][0]).toEqual({
      where: { channel: "cloud", wamid: "wamid.T1", processedAt: null, attempts: 1, result: OLD_CLAIM },
      data: { attempts: 2, result: CLAIMED_NOW },
    });
    expect(pipeline.handleInboundDm).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ started: 0, retried: 1, abandoned: 0 });
  });

  it("a claim younger than the wait is left alone: its run may still be alive", async () => {
    withStuck(stuck({ result: YOUNG_CLAIM }));
    expect(await sweepCloudInbound({ request, now: NOW, env: ON })).toEqual({ started: 0, retried: 0, abandoned: 0 });
    expect(dbMock.waInbound.updateMany).not.toHaveBeenCalled();
    expect(pipeline.handleInboundDm).not.toHaveBeenCalled();
  });

  it("two sweeps at once: the one that loses the compare-and-set runs nothing", async () => {
    withStuck(stuck());
    dbMock.waInbound.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await sweepCloudInbound({ request, now: NOW, env: ON })).toEqual({ started: 0, retried: 0, abandoned: 0 });
    expect(pipeline.handleInboundDm).not.toHaveBeenCalled();
  });

  it("a row whose retry died too (attempts 2) is closed as failed, logged and counted, never run a third time", async () => {
    withStuck(stuck({ attempts: 2 }));
    const out = await sweepCloudInbound({ request, now: NOW, env: ON });
    expect(dbMock.waInbound.updateMany.mock.calls[0][0]).toEqual({
      where: { channel: "cloud", wamid: "wamid.T1", processedAt: null, attempts: 2, result: OLD_CLAIM },
      data: { processedAt: NOW, result: "failed: interrupted twice, not run again" },
    });
    expect(pipeline.handleInboundDm).not.toHaveBeenCalled();
    expect(out).toEqual({ started: 0, retried: 0, abandoned: 1 });
    expect(logs.some((l) => l.includes("wamid.T1") && l.includes("interrupted twice"))).toBe(true);
  });

  it("a claim stamp that does not parse is left alone", async () => {
    withStuck(stuck({ result: "processing since soon" }));
    expect(await sweepCloudInbound({ request, now: NOW, env: ON })).toEqual({ started: 0, retried: 0, abandoned: 0 });
    expect(dbMock.waInbound.updateMany).not.toHaveBeenCalled();
  });
});

describe("databaseUnavailable: only a database that cannot be reached is worth Meta's resend", () => {
  it("connection, timeout and pool errors are", () => {
    for (const c of ["P1001", "P1008", "P1017", "P2024", "P2037"]) expect(databaseUnavailable(prismaError(c, "x"))).toBe(true);
    expect(databaseUnavailable(Object.assign(new Error("init"), { name: "PrismaClientInitializationError" }))).toBe(true);
    expect(databaseUnavailable(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432")))).toBe(true);
  });

  it("a row the database refuses is not", () => {
    for (const c of ["P2000", "P2002", "P2007", "P2010", "P2011"]) expect(databaseUnavailable(prismaError(c, "x"))).toBe(false);
    expect(databaseUnavailable(new Error("unsupported Unicode escape sequence"))).toBe(false);
    expect(databaseUnavailable(null)).toBe(false);
  });
});
