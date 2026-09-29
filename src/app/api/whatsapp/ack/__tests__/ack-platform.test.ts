/**
 * The due-posts BRIDGE's half of /api/whatsapp/ack (self-join slice 3).
 *
 * A Pi built before slice 3 does not poll /platform-jobs. Until it is
 * redeployed, due-posts also hands it platform DMs (sign-up codes), keyed
 * `platform-<id>`, and that Pi acks them here like any DM. These acks go
 * to the PlatformJob row, not to SentNotification:
 *
 *   ack with a waMessageId   sent
 *   ack without one          unconfirmed (that build acks a FAILED DM the
 *                            same way, so "sent" would be a lie)
 *   release                  back to queued (the Pi's DM pacing)
 *
 * Every other key is handled exactly as before.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "test-wa-key";

const dbMock = vi.hoisted(() => ({
  sentNotification: { upsert: vi.fn(), deleteMany: vi.fn() },
  botJob: { update: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

const libMock = vi.hoisted(() => ({ recordPlatformJobOutcome: vi.fn() }));
vi.mock("@/lib/platform-jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform-jobs")>()),
  recordPlatformJobOutcome: (...a: unknown[]) => libMock.recordPlatformJobOutcome(...a),
}));

import { POST } from "../route";

const ENV = process.env.WHATSAPP_API_KEY;

function ack(body: unknown) {
  return POST(
    new Request("http://x/api/whatsapp/ack", {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHATSAPP_API_KEY = KEY;
  libMock.recordPlatformJobOutcome.mockResolvedValue({ updated: true });
  dbMock.sentNotification.upsert.mockResolvedValue({});
  dbMock.sentNotification.deleteMany.mockResolvedValue({ count: 1 });
  dbMock.botJob.update.mockResolvedValue({});
});
afterAll(() => {
  process.env.WHATSAPP_API_KEY = ENV;
});

describe("platform keys through the legacy ack", () => {
  it("an ack with a message id marks the platform job sent, and writes no SentNotification", async () => {
    const res = await ack({ key: "platform-pj1", kind: "dm", waMessageId: "wa1" });
    expect(res.status).toBe(200);
    expect(libMock.recordPlatformJobOutcome).toHaveBeenCalledWith("pj1", { outcome: "sent", waMessageId: "wa1" });
    expect(dbMock.sentNotification.upsert).not.toHaveBeenCalled();
  });

  it("an ack WITHOUT a message id is unconfirmed, not sent", async () => {
    await ack({ key: "platform-pj1", kind: "dm" });
    expect(libMock.recordPlatformJobOutcome).toHaveBeenCalledWith("pj1", {
      outcome: "unconfirmed",
      reason: expect.stringMatching(/without a message id/i),
    });
  });

  it("a release puts the job back in the queue", async () => {
    const res = await ack({ key: "platform-pj1", release: true });
    expect(await res.json()).toEqual({ ok: true, released: true });
    expect(libMock.recordPlatformJobOutcome).toHaveBeenCalledWith("pj1", { outcome: "release" });
    expect(dbMock.sentNotification.deleteMany).not.toHaveBeenCalled();
  });
});

describe("every other key is untouched", () => {
  it("a botjob ack still upserts SentNotification and stamps BotJob.sentAt", async () => {
    await ack({ key: "botjob-b1", kind: "dm", waMessageId: "wa1" });
    expect(dbMock.sentNotification.upsert).toHaveBeenCalled();
    expect(dbMock.botJob.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "b1" } }),
    );
    expect(libMock.recordPlatformJobOutcome).not.toHaveBeenCalled();
  });

  it("a release of a normal key still deletes the unsent claim row", async () => {
    await ack({ key: "m1:rate-dm:u1", release: true });
    expect(dbMock.sentNotification.deleteMany).toHaveBeenCalledWith({
      where: { key: "m1:rate-dm:u1", waMessageId: null },
    });
    expect(libMock.recordPlatformJobOutcome).not.toHaveBeenCalled();
  });
});
