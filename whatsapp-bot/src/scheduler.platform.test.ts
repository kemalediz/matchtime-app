/**
 * The scheduler tick runs the PLATFORM CHANNEL first (self-join slice 3).
 *
 *   - It runs with ZERO clubs. Sign-up codes must go out when every club's
 *     bot is switched off; that is the bug the platform channel fixes (a
 *     sign-up code used to borrow the first bot-enabled club).
 *   - It runs BEFORE the clubs, so a sign-up code (someone is staring at a
 *     "check WhatsApp" screen) gets the minute's DM slot ahead of a
 *     reminder.
 *   - It shares the ONE DM slot with the clubs: a platform DM and a club DM
 *     in the same tick means the club DM is held and released, exactly as
 *     two club DMs would be.
 *   - A server too old to answer (null) changes nothing for the clubs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WaDriver } from "./driver.js";

const order: string[] = [];
const getDuePosts = vi.fn();
const ackInstruction = vi.fn(async () => undefined);
const releaseInstruction = vi.fn(async (key: string) => {
  order.push(`release:${key}`);
});
const getPlatformJobs = vi.fn();
const reportPlatformJob = vi.fn(async (r: { id: string; outcome: string }) => {
  order.push(`report:${r.id}:${r.outcome}`);
});

vi.mock("./api.js", () => ({
  getDuePosts: (...a: unknown[]) => getDuePosts(...a),
  ackInstruction: (...a: unknown[]) => ackInstruction(...a),
  releaseInstruction: (...a: unknown[]) => releaseInstruction(...(a as [string])),
  getPlatformJobs: (...a: unknown[]) => getPlatformJobs(...a),
  reportPlatformJob: (...a: unknown[]) => reportPlatformJob(...(a as [{ id: string; outcome: string }])),
}));

const { initScheduler, stopScheduler } = await import("./scheduler.js");

const GID = "447525334985-1607872139@g.us";

function fakeDriver() {
  const driver = {
    name: "fake",
    sendDirectText: vi.fn(async (phone: string) => {
      order.push(`dm:${phone}`);
      return { id: { _serialized: `sent-${phone}` } };
    }),
    sendTextWithMentions: vi.fn(async () => ({ id: { _serialized: "g" } })),
    leaveGroup: vi.fn(async (g: string) => {
      order.push(`leave:${g}`);
    }),
  } as unknown as WaDriver;
  return driver;
}

// The DM slot is module state that outlives a test; move the clock an
// hour on per test so every test starts with the slot open.
let hour = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T09:00:00Z").getTime() + ++hour * 3_600_000);
  order.length = 0;
  getDuePosts.mockReset();
  getPlatformJobs.mockReset();
  ackInstruction.mockClear();
  releaseInstruction.mockClear();
  reportPlatformJob.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the platform channel in the scheduler tick", () => {
  it("sends a sign-up code with NO clubs at all", async () => {
    getPlatformJobs.mockResolvedValue([{ id: "pj1", kind: "dm", phone: "447700900123", text: "code", purpose: "otp" }]);
    initScheduler(fakeDriver(), []);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["dm:447700900123", "report:pj1:sent"]);
    expect(getDuePosts).not.toHaveBeenCalled();
  });

  it("runs before the clubs, and the club DM in the same tick is held and released", async () => {
    getPlatformJobs.mockResolvedValue([{ id: "pj1", kind: "dm", phone: "447700900123", text: "code", purpose: "otp" }]);
    getDuePosts.mockResolvedValue({
      instructions: [{ kind: "dm", key: "m1:rate-dm:u1", phone: "447700900999", text: "rate the lads" }],
    });
    initScheduler(fakeDriver(), [{ groupId: GID, orgName: "Sutton Football Club" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["dm:447700900123", "report:pj1:sent", "release:m1:rate-dm:u1"]);
  });

  it("a club DM sent this minute holds the next tick's platform DM, which is released", async () => {
    getPlatformJobs.mockResolvedValueOnce([]);
    getDuePosts.mockResolvedValueOnce({
      instructions: [{ kind: "dm", key: "m1:rate-dm:u1", phone: "447700900999", text: "rate the lads" }],
    });
    initScheduler(fakeDriver(), [{ groupId: GID, orgName: "Sutton Football Club" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["dm:447700900999"]);

    getPlatformJobs.mockResolvedValueOnce([{ id: "pj2", kind: "dm", phone: "447700900123", text: "code" }]);
    getDuePosts.mockResolvedValue({ instructions: [] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(order).toEqual(["dm:447700900999", "report:pj2:release"]);
  });

  it("leaves a group in the same tick as a DM, because a leave is not a DM", async () => {
    getPlatformJobs.mockResolvedValue([
      { id: "pj1", kind: "dm", phone: "447700900123", text: "code" },
      { id: "pj2", kind: "leave-group", groupId: "120363900000000001@g.us" },
    ]);
    initScheduler(fakeDriver(), []);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([
      "dm:447700900123",
      "report:pj1:sent",
      "leave:120363900000000001@g.us",
      "report:pj2:sent",
    ]);
  });

  it("an older server (null) changes nothing for the clubs", async () => {
    getPlatformJobs.mockResolvedValue(null);
    getDuePosts.mockResolvedValue({
      instructions: [{ kind: "dm", key: "m1:rate-dm:u1", phone: "447700900999", text: "rate the lads" }],
    });
    initScheduler(fakeDriver(), [{ groupId: GID, orgName: "Sutton Football Club" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["dm:447700900999"]);
    expect(ackInstruction).toHaveBeenCalledTimes(1);
  });

  it("a platform poll that throws does not stop the clubs", async () => {
    getPlatformJobs.mockRejectedValue(new Error("boom"));
    getDuePosts.mockResolvedValue({ instructions: [] });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    initScheduler(fakeDriver(), [{ groupId: GID, orgName: "Sutton Football Club" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(getDuePosts).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
  });
});
