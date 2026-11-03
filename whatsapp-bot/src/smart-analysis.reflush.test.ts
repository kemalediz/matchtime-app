/**
 * A TAGGED MESSAGE THAT ARRIVES DURING A FLUSH IS NOT LEFT FOR THE NEXT TICK
 * (Vets MNF, 2026-11-03). Shane's "@Match Time what happens if 14 don't
 * confirm?" arrived while the 09:10 tick's flush of three INs was still
 * running. Its immediate flush hit the one-flush-per-group guard and
 * returned, so it waited ten minutes for the next tick, with 21 more
 * messages piled on top. Now the running flush, when it ends, flushes again
 * at once for a tag that came in meanwhile.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InboundMessage } from "./driver.js";
import { makeWwebjsDriver, type WwebjsClientLike } from "./drivers/wwebjs.js";

const postAnalyzeFull = vi.fn();
vi.mock("./api.js", () => ({
  postAnalyzeFull: (...args: unknown[]) => postAnalyzeFull(...args),
}));

const { enqueueForAnalysis, _test_flushNow, _test_reset } = await import("./smart-analysis.js");

const asClient = (c: unknown) => makeWwebjsDriver(c as unknown as WwebjsClientLike);
const asMessage = (m: unknown) => m as unknown as InboundMessage;

const GROUP = "120363000000009200@g.us";
const BOT_WID = "447700900999@c.us";

function client() {
  return {
    info: { wid: { _serialized: BOT_WID } },
    getContactById: async (jid: string) => (jid === BOT_WID ? { pushname: "Match Time", isMe: true } : { pushname: "", isMe: false }),
    getChatById: async () => ({ sendMessage: vi.fn(async () => ({})) }),
    sendMessage: vi.fn(async () => ({ id: { _serialized: "sent" } })),
  };
}

let seq = 0;
function message(body: string, mentionedIds: string[] = []) {
  seq += 1;
  return {
    from: GROUP,
    author: "447700900001@c.us",
    body,
    timestamp: 1_757_000_000 + seq,
    id: { _serialized: `false_g_${seq}` },
    mentionedIds,
    _data: { body, notifyName: "Shane" },
    getContact: async () => ({ pushname: "Shane", isMe: false }),
  };
}

const bodiesOf = (call: number) =>
  (postAnalyzeFull.mock.calls[call][0] as { messages: Array<{ body: string }> }).messages.map((m) => m.body);

beforeEach(() => {
  postAnalyzeFull.mockReset();
  _test_reset();
});

describe("a tag during a running flush", () => {
  it("is flushed as soon as the running flush ends, not at the next tick", async () => {
    const driver = asClient(client());
    let release!: () => void;
    postAnalyzeFull.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ results: [], nextKickoffMs: null }))),
    );
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });

    await enqueueForAnalysis(driver, asMessage(message("IN")));
    const tick = _test_flushNow(GROUP); // the 10-minute tick, still running
    await vi.waitFor(() => expect(postAnalyzeFull).toHaveBeenCalledTimes(1));

    await enqueueForAnalysis(driver, asMessage(message(`@447700900999 what happens if 14 don't confirm?`, [BOT_WID])));
    expect(postAnalyzeFull).toHaveBeenCalledTimes(1); // the guard held it

    release();
    await tick;
    await vi.waitFor(() => expect(postAnalyzeFull).toHaveBeenCalledTimes(2));
    expect(bodiesOf(0)).toEqual(["IN"]);
    expect(bodiesOf(1)).toEqual(["@Match Time what happens if 14 don't confirm?"]);
  });

  it("an untagged message during a running flush still waits for the next tick", async () => {
    const driver = asClient(client());
    let release!: () => void;
    postAnalyzeFull.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ results: [], nextKickoffMs: null }))),
    );
    postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });

    await enqueueForAnalysis(driver, asMessage(message("IN")));
    const tick = _test_flushNow(GROUP);
    await vi.waitFor(() => expect(postAnalyzeFull).toHaveBeenCalledTimes(1));
    await enqueueForAnalysis(driver, asMessage(message("lol")));
    release();
    await tick;
    await new Promise((r) => setTimeout(r, 20));
    expect(postAnalyzeFull).toHaveBeenCalledTimes(1);
  });
});
