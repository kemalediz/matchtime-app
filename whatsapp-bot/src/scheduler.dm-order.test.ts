/**
 * The Pi sends DMs in the SERVER'S order (FNF, 2026-10-16).
 *
 * Conversational replies go first only because the server puts them first
 * in the due-posts list (src/lib/dm-reply-priority.ts). That works only if
 * this side never reorders: on each tick the FIRST DM in the list takes the
 * one-a-minute slot (`DM_GAP_MS`) and every later DM is released, in list
 * order, to come back on the next poll. Group posts are not paced. Pinned
 * here so a future "smarter" Pi cannot quietly undo the server's order or
 * change the pacing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WaDriver } from "./driver.js";

const getDuePosts = vi.fn();
const ackInstruction = vi.fn(async () => undefined);
const releaseInstruction = vi.fn(async (_key: string) => undefined);

vi.mock("./api.js", () => ({
  getDuePosts: (...a: unknown[]) => getDuePosts(...a),
  ackInstruction: (...a: unknown[]) => ackInstruction(...(a as [])),
  releaseInstruction: (key: string) => releaseInstruction(key),
  getPlatformJobs: async () => null,
  reportPlatformJob: async () => undefined,
}));

const { initScheduler, stopScheduler } = await import("./scheduler.js");

const GID = "447525334985-1607872139@g.us";
const ORGS = [{ groupId: GID, orgName: "FNF" }];

function fakeDriver() {
  const sent: Array<[string, string]> = [];
  const driver = {
    name: "fake",
    sendText: async () => ({ id: { _serialized: "g" } }),
    sendTextWithMentions: async (_g: string, text: string) => {
      sent.push(["group", text]);
      return { id: { _serialized: "g" } };
    },
    sendDirectText: async (phone: string) => {
      sent.push(["dm", phone]);
      return { id: { _serialized: "d" } };
    },
    sendPoll: async () => ({ id: { _serialized: "p" } }),
    sendReaction: async () => ({ ok: true as const }),
  } as unknown as WaDriver;
  return { driver, sent };
}

const dm = (key: string, phone: string) => ({ kind: "dm", key, phone, text: key });

// The DM slot's clock is module state: each test starts ten minutes after
// the last one, so the previous test's DM never holds this one's.
let clock = Date.parse("2026-10-16T21:39:00.000Z");
beforeEach(() => {
  vi.useFakeTimers();
  clock += 10 * 60_000;
  vi.setSystemTime(clock);
  getDuePosts.mockReset();
  ackInstruction.mockClear();
  releaseInstruction.mockClear();
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
});

describe("DM order and pacing on the Pi", () => {
  it("sends the FIRST DM it is handed, releases the rest in order, posts groups regardless", async () => {
    const { driver, sent } = fakeDriver();
    getDuePosts.mockResolvedValue({
      instructions: [
        { kind: "group-message", key: "g1", text: "Squad is up" },
        dm("botjob-reply", "447700555555"),
        dm("botjob-pay0", "447700900000"),
        dm("botjob-pay1", "447700900001"),
      ],
    });
    initScheduler(driver, ORGS);
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toEqual([
      ["group", "Squad is up"],
      ["dm", "447700555555"],
    ]);
    expect(releaseInstruction.mock.calls.map((c) => c[0])).toEqual(["botjob-pay0", "botjob-pay1"]);
  });

  it("one DM a minute: the next DM goes only once the minute has passed", async () => {
    const { driver, sent } = fakeDriver();
    getDuePosts.mockResolvedValue({ instructions: [dm("a", "447700000001"), dm("b", "447700000002")] });
    initScheduler(driver, ORGS);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter(([k]) => k === "dm")).toHaveLength(1);

    // The server re-emits the released one; within the minute it is held again.
    getDuePosts.mockResolvedValue({ instructions: [dm("b", "447700000002")] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent.filter(([k]) => k === "dm")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(sent.filter(([k]) => k === "dm").map(([, p]) => p)).toEqual(["447700000001", "447700000002"]);
  });
});
