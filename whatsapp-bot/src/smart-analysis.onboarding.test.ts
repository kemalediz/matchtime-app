/**
 * The flush side of self-setup (2026-09-17). Three things the readiness
 * review found missing, each pinned here against the real enqueue →
 * flush pipeline with a mocked API:
 *
 *   1. a group that is mid-setup is flushed the moment a message
 *      arrives, tagged or not (a plain "YES" used to sit in the buffer
 *      forever);
 *   2. the 10-minute timer flushes a group that started being monitored
 *      AFTER the timer was started (the list is read fresh every tick,
 *      and anything buffered is flushed regardless);
 *   3. an analyze response that says the setup completed stops the
 *      immediate flushes for that group and asks for an org refresh.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { InboundMessage } from "./driver.js";
import { makeWwebjsDriver, type WwebjsClientLike } from "./drivers/wwebjs.js";

const postAnalyzeFull = vi.fn();
vi.mock("./api.js", () => ({
  postAnalyzeFull: (...args: unknown[]) => postAnalyzeFull(...args),
  postHeartbeat: vi.fn(async () => undefined),
}));

const {
  enqueueForAnalysis,
  immediateFlushReason,
  startBatchFlushTimer,
  stopBatchFlushTimer,
  _test_reset,
} = await import("./smart-analysis.js");
const handlers = await import("./handlers.js");
const orgRefresh = await import("./org-refresh.js");

/**
 * `asClient` now wraps the fake in the REAL whatsapp-web.js driver
 * (Phase 2, MDs/baileys-migration-plan-2026-09-21.md). The fakes and every
 * assertion below are unchanged: the driver is a pass-through, so a test
 * that watched `client.sendMessage` still watches `client.sendMessage`.
 * That is the point: these tests are the proof the refactor changed no
 * behaviour, and they only prove it while they run through the seam.
 */
const asClient = (c: unknown) => makeWwebjsDriver(c as unknown as WwebjsClientLike);
const asMessage = (m: unknown) => m as unknown as InboundMessage;
const GID = "120363000000000042@g.us";

function msg(id: string, body: string) {
  return {
    from: GID,
    author: "447700900001@c.us",
    body,
    timestamp: 1_758_000_000,
    mentionedIds: [],
    _data: { body, notifyName: "Erdal" },
    id: { _serialized: id },
    getContact: async () => ({ pushname: "Erdal", name: "Erdal", isMe: false }),
  };
}

function client() {
  return {
    info: { wid: { _serialized: "447525334985@c.us" } },
    getContactById: async () => ({ pushname: "Erdal", name: "Erdal", isMe: false }),
    getChatById: async () => {
      throw new Error("r");
    },
    sendMessage: vi.fn(async () => ({ id: { _serialized: "sent" } })),
  };
}

beforeEach(() => {
  postAnalyzeFull.mockReset();
  postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
  _test_reset();
  handlers.setMonitoredGroups([]);
  handlers.setOnboardingGroups([]);
  orgRefresh._test_resetOrgRefresh();
});

afterEach(() => {
  stopBatchFlushTimer();
  vi.useRealTimers();
});

describe("immediateFlushReason: onboarding", () => {
  it("a mid-setup group flushes at once, below a mention and above urgency", () => {
    const base = { botMentioned: false, bufferLen: 1, maxBufferLen: Infinity, kickoffMs: null, nowMs: 0, urgencyWindowMs: 3_600_000 };
    expect(immediateFlushReason({ ...base, onboarding: true })).toBe("onboarding");
    expect(immediateFlushReason({ ...base, onboarding: true, botMentioned: true })).toBe("mention");
    expect(immediateFlushReason({ ...base, onboarding: true, kickoffMs: 1000 })).toBe("onboarding");
    expect(immediateFlushReason({ ...base, onboarding: false })).toBeNull();
    expect(immediateFlushReason(base)).toBeNull(); // the flag is optional and defaults off
  });
});

describe("a plain reply from a mid-setup group reaches the server without a tag or a tick", () => {
  it("YES is POSTed on enqueue", async () => {
    handlers.addOnboardingGroup(GID);
    await enqueueForAnalysis(asClient(client()), asMessage(msg("m1", "YES")));
    expect(postAnalyzeFull).toHaveBeenCalledTimes(1);
    expect(postAnalyzeFull.mock.calls[0][0]).toMatchObject({
      groupId: GID,
      messages: [expect.objectContaining({ waMessageId: "m1", body: "YES", botMentioned: false })],
    });
  });

  it("the same message in a live (non-setup) group waits for the tick", async () => {
    handlers.setMonitoredGroups([GID]);
    await enqueueForAnalysis(asClient(client()), asMessage(msg("m1", "YES")));
    expect(postAnalyzeFull).not.toHaveBeenCalled();
  });
});

describe("the timer flushes groups that appeared after it started", () => {
  it("a group not in the initial list is still flushed on the next tick because it has a buffer", async () => {
    vi.useFakeTimers();
    const c = asClient(client());
    let orgIds: string[] = ["existing@g.us"];
    startBatchFlushTimer(c, () => orgIds);
    // A live org enabled by script after `ready`: monitored (by the org
    // refresh) but not yet in the closure's list at enqueue time.
    handlers.setMonitoredGroups(["existing@g.us", GID]);
    await enqueueForAnalysis(c, asMessage(msg("m1", "in")));
    expect(postAnalyzeFull).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 10);
    const flushed = postAnalyzeFull.mock.calls.map((call) => (call[0] as { groupId: string }).groupId);
    expect(flushed).toContain(GID);

    // And a list that changes later is read fresh on the following tick.
    orgIds = ["existing@g.us", GID];
    postAnalyzeFull.mockClear();
    await enqueueForAnalysis(c, asMessage(msg("m2", "out")));
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 10);
    expect(postAnalyzeFull.mock.calls.map((call) => (call[0] as { groupId: string }).groupId)).toContain(GID);
  });
});

describe("the setup completing", () => {
  it("stops the immediate flushes for that group and asks for an org refresh", async () => {
    const refresher = vi.fn(async () => undefined);
    orgRefresh.setOrgRefresher(refresher);
    handlers.addOnboardingGroup(GID);
    postAnalyzeFull.mockResolvedValueOnce({
      results: [{ waMessageId: "m1", handledBy: "llm", intent: "onboarding", react: null, reply: "✅ Hazırız!" }],
      nextKickoffMs: null,
      onboarding: { stage: "completed", completed: true, language: "tr" },
    });
    const c = asClient(client());
    await enqueueForAnalysis(c, asMessage(msg("m1", "Cuma 21:30, Sim Arena, 7'ye 7")));
    expect(refresher).toHaveBeenCalledWith(expect.stringContaining("completed"));
    expect(handlers.isOnboardingGroup(GID)).toBe(false);
    expect(handlers.isMonitoredGroup(GID)).toBe(true); // still listening; the refresh decides its status

    // The next message is no longer flushed immediately.
    postAnalyzeFull.mockClear();
    await enqueueForAnalysis(c, asMessage(msg("m2", "varım")));
    expect(postAnalyzeFull).not.toHaveBeenCalled();
  });

  it("a mid-flow response keeps the group in setup mode", async () => {
    const refresher = vi.fn(async () => undefined);
    orgRefresh.setOrgRefresher(refresher);
    handlers.addOnboardingGroup(GID);
    postAnalyzeFull.mockResolvedValueOnce({
      results: [],
      nextKickoffMs: null,
      onboarding: { stage: "admins", completed: false, language: "tr" },
    });
    await enqueueForAnalysis(asClient(client()), asMessage(msg("m1", "evet")));
    expect(refresher).not.toHaveBeenCalled();
    expect(handlers.isOnboardingGroup(GID)).toBe(true);
  });
});
