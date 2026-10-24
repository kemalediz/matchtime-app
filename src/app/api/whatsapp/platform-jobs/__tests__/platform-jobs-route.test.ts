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

const inviteMock = vi.hoisted(() => ({ onInviteCodeReported: vi.fn(), sweepClubInvitations: vi.fn() }));
vi.mock("@/lib/pool/club-invitation", () => ({
  onInviteCodeReported: (...a: unknown[]) => inviteMock.onInviteCodeReported(...a),
  sweepClubInvitations: (...a: unknown[]) => inviteMock.sweepClubInvitations(...a),
}));

const versionMock = vi.hoisted(() => ({ loadClubSetVersion: vi.fn() }));
vi.mock("@/lib/club-set-version", () => ({ loadClubSetVersion: () => versionMock.loadClubSetVersion() }));

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
  versionMock.loadClubSetVersion.mockResolvedValue("0123456789abcdef");
  delete process.env.SELF_JOIN_ENABLED;
});

// 2026-10-13: the one request the Pi makes every tick also tells it
// whether the clubs it should serve, monitor or silence have changed.
describe("GET: the club set version", () => {
  const get = () => GET(new Request("http://x/api/whatsapp/platform-jobs", { headers: { "x-api-key": KEY } }));

  it("rides on the poll, beside the jobs, which are exactly what they were", async () => {
    const body = await (await get()).json();
    expect(body.clubSetVersion).toBe("0123456789abcdef");
    expect(body.jobs).toEqual([
      { id: "pj1", kind: "dm", phone: "447700900123", text: "code", purpose: "otp" },
      { id: "pj2", kind: "leave-group", groupId: "g1" },
    ]);
    expect(Object.keys(body).sort()).toEqual(["clubSetVersion", "jobs"]);
  });

  it("is on a poll with no jobs too: that is the usual poll", async () => {
    libMock.claimDuePlatformJobs.mockResolvedValue([]);
    expect(await (await get()).json()).toEqual({ jobs: [], clubSetVersion: "0123456789abcdef" });
  });

  it("NEVER costs the poll its jobs: they are already claimed, so a version that cannot be read is simply left out", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    versionMock.loadClubSetVersion.mockRejectedValue(new Error("database hiccup"));
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs).toHaveLength(2);
    expect("clubSetVersion" in body).toBe(false);
    err.mockRestore();
  });

  // PR #250 review, fix 1. The stamp used to be read AFTER the claim. A
  // read that stalled (not threw) until the function was killed took the
  // claimed jobs with it: a sign-up code lives ten minutes and nothing
  // reclaims a claimed job.
  it("the stamp is read BEFORE the jobs are claimed, so nothing claimed can be waiting on it", async () => {
    const order: string[] = [];
    versionMock.loadClubSetVersion.mockImplementation(async () => {
      order.push("version");
      return "0123456789abcdef";
    });
    libMock.claimDuePlatformJobs.mockImplementation(async () => {
      order.push("claim");
      return [];
    });
    await get();
    expect(order).toEqual(["version", "claim"]);
  });

  it("a stamp read that NEVER resolves: the claimed jobs still reach the Pi, promptly, without the field", async () => {
    vi.useFakeTimers();
    try {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      versionMock.loadClubSetVersion.mockImplementation(() => new Promise<string>(() => {}));
      const pending = get();
      await vi.advanceTimersByTimeAsync(1_500);
      const res = await pending;
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobs).toHaveLength(2);
      expect("clubSetVersion" in body).toBe(false);
      // Claimed only once the wait for the stamp was over.
      expect(libMock.claimDuePlatformJobs).toHaveBeenCalledTimes(1);
      err.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stamp that arrives inside the wait is sent as usual, with no delay to speak of", async () => {
    vi.useFakeTimers();
    try {
      versionMock.loadClubSetVersion.mockImplementation(
        () => new Promise<string>((resolve) => setTimeout(() => resolve("0123456789abcdef"), 200)),
      );
      const pending = get();
      await vi.advanceTimersByTimeAsync(200);
      expect((await (await pending).json()).clubSetVersion).toBe("0123456789abcdef");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a wrong key gets neither jobs nor a version", async () => {
    const res = await GET(new Request("http://x/api/whatsapp/platform-jobs", { headers: { "x-api-key": "nope" } }));
    expect(res.status).toBe(401);
    expect(versionMock.loadClubSetVersion).not.toHaveBeenCalled();
  });
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
      // 2026-10-13: one field more, which an older Pi does not read.
      clubSetVersion: "0123456789abcdef",
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
    expect(libMock.recordPlatformJobOutcome).toHaveBeenCalledWith("pj1", { outcome: "sent", waMessageId: "wa1" }, expect.any(Date));
  });

  it("records a failure with its reason, and never as sent", async () => {
    await post({ id: "pj1", outcome: "failed", error: "not on WhatsApp" });
    expect(libMock.recordPlatformJobOutcome).toHaveBeenCalledWith("pj1", {
      outcome: "failed",
      reason: "not on WhatsApp",
    }, expect.any(Date));
  });

  it("a failure with no reason still records a reason", async () => {
    await post({ id: "pj1", outcome: "failed" });
    expect(libMock.recordPlatformJobOutcome).toHaveBeenCalledWith("pj1", {
      outcome: "failed",
      reason: expect.stringMatching(/no reason/i),
    }, expect.any(Date));
  });

  it("releases a paced DM", async () => {
    await post({ id: "pj1", outcome: "release" });
    expect(libMock.recordPlatformJobOutcome).toHaveBeenCalledWith("pj1", { outcome: "release" }, expect.any(Date));
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

describe("POST: the group invite code (pool L8)", () => {
  it("passes the code with the sent outcome and hands it to the invitations flow once the job moved", async () => {
    const res = await post({ id: "pj9", outcome: "sent", inviteCode: "Fh3kQ9zLmP2xW7vB1nR4tY" });
    expect(res.status).toBe(200);
    expect(libMock.recordPlatformJobOutcome).toHaveBeenCalledWith("pj9", { outcome: "sent", inviteCode: "Fh3kQ9zLmP2xW7vB1nR4tY" }, expect.any(Date));
    expect(inviteMock.onInviteCodeReported).toHaveBeenCalledWith("pj9", { outcome: "sent", inviteCode: "Fh3kQ9zLmP2xW7vB1nR4tY" }, expect.any(Date));
  });

  it("a replayed report (nothing moved) and a release are not handed on", async () => {
    libMock.recordPlatformJobOutcome.mockResolvedValueOnce({ updated: false });
    await post({ id: "pj9", outcome: "sent", inviteCode: "Fh3kQ9zLmP2xW7vB1nR4tY" });
    await post({ id: "pj9", outcome: "release" });
    expect(inviteMock.onInviteCodeReported).not.toHaveBeenCalled();
  });

  it("the poll runs the invitations sweep, and its failure never costs the poll its jobs", async () => {
    inviteMock.sweepClubInvitations.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(new Request("http://x/api/whatsapp/platform-jobs", { headers: { "x-api-key": KEY } }));
    expect(res.status).toBe(200);
    expect(inviteMock.sweepClubInvitations).toHaveBeenCalled();
    expect(((await res.json()) as { jobs: unknown[] }).jobs).toHaveLength(2);
  });
});
