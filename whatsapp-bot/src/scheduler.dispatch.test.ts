/**
 * What the scheduler asks the driver for, per instruction kind.
 *
 * Phase 2 (MDs/baileys-migration-plan-2026-09-21.md) took four
 * `client.sendMessage` calls out of `executeInstruction` and replaced them
 * with four driver methods. Three of them used to build a JID inline
 * (`${instr.phone}@c.us`, and `${p}@c.us` twice), and plan §2.4 says that
 * suffix changes under Baileys. Nothing pinned those call sites before, so
 * a mistake would have shown up as a DM to nobody on a match day rather
 * than as a red test.
 *
 * The ack contract is asserted alongside, because it is the part of this
 * file that is a PRODUCT decision rather than a library detail: delivery is
 * at-most-once by design, so a send whose result carries no id is acked
 * anyway (`send-result.ts`, and the 2026-07-19 duplicate flood it exists to
 * prevent).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WaDriver } from "./driver.js";

const getDuePosts = vi.fn();
const ackInstruction = vi.fn(async () => undefined);
const releaseInstruction = vi.fn(async () => undefined);

vi.mock("./api.js", () => ({
  getDuePosts: (...a: unknown[]) => getDuePosts(...a),
  ackInstruction: (...a: unknown[]) => ackInstruction(...a),
  releaseInstruction: (...a: unknown[]) => releaseInstruction(...a),
}));

const { initScheduler, stopScheduler } = await import("./scheduler.js");

const GID = "447525334985-1607872139@g.us";
const ORGS = [{ groupId: GID, orgName: "Sutton Football Club" }];

function fakeDriver() {
  const calls: Array<[string, ...unknown[]]> = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return { id: { _serialized: "sent-1" } };
    };
  const driver = {
    name: "fake",
    sendText: record("sendText"),
    sendTextWithMentions: record("sendTextWithMentions"),
    sendDirectText: record("sendDirectText"),
    sendPoll: record("sendPoll"),
    sendReaction: async (id: string, emoji: string) => {
      calls.push(["sendReaction", id, emoji]);
      return { ok: true as const };
    },
  } as unknown as WaDriver;
  return { driver, calls };
}

/** Run one scheduler tick with a single due instruction. */
async function dispatch(instruction: Record<string, unknown>) {
  const { driver, calls } = fakeDriver();
  getDuePosts.mockResolvedValue({ instructions: [instruction] });
  initScheduler(driver, ORGS);
  await vi.advanceTimersByTimeAsync(0);
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
  getDuePosts.mockReset();
  ackInstruction.mockClear();
  releaseInstruction.mockClear();
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
});

describe("executeInstruction speaks to the driver, never to a JID", () => {
  it("a plain group message sends text with no mentions", async () => {
    const calls = await dispatch({
      kind: "group-message",
      key: "k1",
      matchId: "m1",
      text: "Squad is up",
    });
    expect(calls).toEqual([["sendTextWithMentions", GID, "Squad is up", []]]);
  });

  it("a group message with mentions passes BARE PHONES, not ids", async () => {
    // The `@c.us` suffix lives in the driver now. Phones here.
    const calls = await dispatch({
      kind: "group-message",
      key: "k2",
      matchId: "m1",
      text: "@447700900001 you're in",
      mentions: ["447700900001"],
    });
    expect(calls).toEqual([
      ["sendTextWithMentions", GID, "@447700900001 you're in", ["447700900001"]],
    ]);
  });

  it("a DM passes the bare phone", async () => {
    const calls = await dispatch({
      kind: "dm",
      key: "k3",
      matchId: "m1",
      phone: "447700900002",
      text: "You're on the bench",
      targetUser: "u1",
    });
    expect(calls).toEqual([["sendDirectText", "447700900002", "You're on the bench"]]);
  });

  it("a bench prompt mentions the player by bare phone", async () => {
    const calls = await dispatch({
      kind: "bench-prompt",
      key: "k4",
      matchId: "m1",
      phone: "447700900003",
      userId: "u2",
      text: "@447700900003 a slot opened up",
    });
    expect(calls).toEqual([
      ["sendTextWithMentions", GID, "@447700900003 a slot opened up", ["447700900003"]],
    ]);
  });

  it("a poll passes its question, options and the multi flag", async () => {
    const calls = await dispatch({
      kind: "group-poll",
      key: "k5",
      matchId: "m1",
      question: "Man of the match?",
      options: ["Kemal", "Ayoub"],
      multi: true,
    });
    expect(calls).toEqual([["sendPoll", GID, "Man of the match?", ["Kemal", "Ayoub"], true]]);
  });

  it("a poll with no multi flag defaults to single-answer", async () => {
    const calls = await dispatch({
      kind: "group-poll",
      key: "k6",
      matchId: "m1",
      question: "Man of the match?",
      options: ["Kemal"],
    });
    expect(calls[0]?.[4]).toBe(false);
  });

  it("update-reaction goes through the driver's reaction path", async () => {
    const calls = await dispatch({
      kind: "update-reaction",
      key: "k7",
      waMessageId: "false_447525334985-1607872139@g.us_3B0B7E9",
      emoji: "🪑",
    });
    expect(calls).toEqual([
      ["sendReaction", "false_447525334985-1607872139@g.us_3B0B7E9", "🪑"],
    ]);
  });
});

describe("the ack contract survives the seam", () => {
  it("acks with the id the send result carried", async () => {
    await dispatch({ kind: "group-message", key: "k8", matchId: "m1", text: "hi" });
    expect(ackInstruction).toHaveBeenCalledWith(
      expect.objectContaining({ key: "k8", waMessageId: "sent-1" }),
    );
  });

  it("acks ANYWAY when the driver resolves to undefined", async () => {
    // At-most-once is the deliberate design: releasing a send that very
    // likely landed is how the 2026-07-19 duplicate flood happened.
    const driver = {
      name: "fake",
      sendTextWithMentions: async () => undefined,
    } as unknown as WaDriver;
    getDuePosts.mockResolvedValue({
      instructions: [{ kind: "group-message", key: "k9", matchId: "m1", text: "hi" }],
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      initScheduler(driver, ORGS);
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      err.mockRestore();
    }
    expect(ackInstruction).toHaveBeenCalledWith(
      expect.objectContaining({ key: "k9", waMessageId: undefined }),
    );
    expect(releaseInstruction).not.toHaveBeenCalled();
  });

  it("an unknown kind is released, not sent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const calls = await dispatch({ kind: "teleport", key: "k10" });
      expect(calls).toEqual([]);
    } finally {
      warn.mockRestore();
    }
    expect(releaseInstruction).toHaveBeenCalledWith("k10");
  });
});
