/**
 * /api/whatsapp/platform-jobs: the Pi's door to the platform channel.
 *
 *   GET   claims up to a handful of due jobs and hands them over. Claiming
 *         is the dedupe (claim-on-dispatch, as due-posts): a second poller
 *         gets nothing for a job the first one holds.
 *   POST  the outcome of one job: sent | failed | release.
 *
 * The lib is mocked; its own tests pin the claim and the outcome writes.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "test-wa-key";

const libMock = vi.hoisted(() => ({
  claimDuePlatformJobs: vi.fn(),
  recordPlatformJobOutcome: vi.fn(),
}));
vi.mock("@/lib/platform-jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform-jobs")>()),
  claimDuePlatformJobs: (...a: unknown[]) => libMock.claimDuePlatformJobs(...a),
  recordPlatformJobOutcome: (...a: unknown[]) => libMock.recordPlatformJobOutcome(...a),
}));
vi.mock("@/lib/db", () => ({ db: {} }));
const groupAdd = vi.hoisted(() => ({ queueUnsolicitedAutoLeaves: vi.fn() }));
vi.mock("@/lib/group-add", () => ({
  queueUnsolicitedAutoLeaves: (...a: unknown[]) => groupAdd.queueUnsolicitedAutoLeaves(...a),
}));

import { GET, POST } from "../route";

const ENV = process.env.WHATSAPP_API_KEY;
const SELF_JOIN = process.env.SELF_JOIN_ENABLED;

function post(body: unknown, key = KEY) {
  return POST(
    new Request("http://x/api/whatsapp/platform-jobs", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHATSAPP_API_KEY = KEY;
  libMock.claimDuePlatformJobs.mockResolvedValue([
    { id: "pj1", kind: "dm", phone: "447700900123", text: "code", purpose: "otp" },
    { id: "pj2", kind: "leave-group", groupId: "g1" },
  ]);
  libMock.recordPlatformJobOutcome.mockResolvedValue({ updated: true });
  groupAdd.queueUnsolicitedAutoLeaves.mockResolvedValue({ queued: 0, markedLeft: 0 });
  delete process.env.SELF_JOIN_ENABLED;
});
afterAll(() => {
  process.env.WHATSAPP_API_KEY = ENV;
  if (SELF_JOIN === undefined) delete process.env.SELF_JOIN_ENABLED;
  else process.env.SELF_JOIN_ENABLED = SELF_JOIN;
});

describe("GET", () => {
  it("refuses without the API key", async () => {
    const res = await GET(new Request("http://x/api/whatsapp/platform-jobs", { headers: { "x-api-key": "nope" } }));
    expect(res.status).toBe(401);
    expect(libMock.claimDuePlatformJobs).not.toHaveBeenCalled();
  });

  it("returns the jobs it claimed", async () => {
    const res = await GET(new Request("http://x/api/whatsapp/platform-jobs", { headers: { "x-api-key": KEY } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      jobs: [
        { id: "pj1", kind: "dm", phone: "447700900123", text: "code", purpose: "otp" },
        { id: "pj2", kind: "leave-group", groupId: "g1" },
      ],
    });
    expect(libMock.claimDuePlatformJobs).toHaveBeenCalledTimes(1);
  });
});

describe("GET: the 48-hour auto-leave of unsolicited groups (self-join slice 6)", () => {
  const get = () => GET(new Request("http://x/api/whatsapp/platform-jobs", { headers: { "x-api-key": KEY } }));

  it("self-join off: never looked at", async () => {
    await get();
    expect(groupAdd.queueUnsolicitedAutoLeaves).not.toHaveBeenCalled();
  });

  it("self-join on: queued BEFORE the claim, so a due leave goes out on this very poll", async () => {
    process.env.SELF_JOIN_ENABLED = "1";
    const order: string[] = [];
    groupAdd.queueUnsolicitedAutoLeaves.mockImplementation(async () => {
      order.push("leaves");
      return { queued: 1, markedLeft: 0 };
    });
    libMock.claimDuePlatformJobs.mockImplementation(async () => {
      order.push("claim");
      return [];
    });
    await get();
    expect(order).toEqual(["leaves", "claim"]);
  });

  it("a failure there never costs the poll its jobs", async () => {
    process.env.SELF_JOIN_ENABLED = "1";
    groupAdd.queueUnsolicitedAutoLeaves.mockRejectedValue(new Error("db hiccup"));
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).jobs).toHaveLength(2);
  });
});

describe("POST (outcome)", () => {
  it("refuses without the API key", async () => {
    const res = await post({ id: "pj1", outcome: "sent" }, "nope");
    expect(res.status).toBe(401);
  });

  it("records a send with its message id", async () => {
    const res = await post({ id: "pj1", outcome: "sent", waMessageId: "wa1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: true });
    expect(libMock.recordPlatformJobOutcome).toHaveBeenCalledWith("pj1", { outcome: "sent", waMessageId: "wa1" });
  });

  it("records a failure with its reason, and never as sent", async () => {
    await post({ id: "pj1", outcome: "failed", error: "not on WhatsApp" });
    expect(libMock.recordPlatformJobOutcome).toHaveBeenCalledWith("pj1", {
      outcome: "failed",
      reason: "not on WhatsApp",
    });
  });

  it("a failure with no reason still records a reason", async () => {
    await post({ id: "pj1", outcome: "failed" });
    expect(libMock.recordPlatformJobOutcome).toHaveBeenCalledWith("pj1", {
      outcome: "failed",
      reason: expect.stringMatching(/no reason/i),
    });
  });

  it("releases a paced DM", async () => {
    await post({ id: "pj1", outcome: "release" });
    expect(libMock.recordPlatformJobOutcome).toHaveBeenCalledWith("pj1", { outcome: "release" });
  });

  it("rejects a bad body", async () => {
    for (const body of [{}, { id: "pj1" }, { id: "pj1", outcome: "maybe" }, { outcome: "sent" }]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(libMock.recordPlatformJobOutcome).not.toHaveBeenCalled();
  });

  it("does not accept 'unconfirmed' from a Pi: only the legacy bridge writes that", async () => {
    const res = await post({ id: "pj1", outcome: "unconfirmed" });
    expect(res.status).toBe(400);
  });
});
