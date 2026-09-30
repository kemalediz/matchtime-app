/**
 * The wiring for LID mentions (2026-09-30, MT Test): the phone the driver
 * knows travels to /api/whatsapp/analyze, and a LID it does not know
 * costs ONE roster re-read before the message is forwarded.
 *
 * `mentions.lid-phone.test.ts` pins the pure rule; this pins that
 * `enrichInbound` actually asks for the re-read, re-reads the contact
 * afterwards, and still forwards what it has when the re-read did not
 * help.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InboundMessage, WaDriver } from "./driver.js";
import { makeWwebjsDriver, type WwebjsClientLike } from "./drivers/wwebjs.js";

const postAnalyzeFull = vi.fn();

vi.mock("./api.js", () => ({
  postAnalyzeFull: (...args: unknown[]) => postAnalyzeFull(...args),
}));

const { enqueueForAnalysis, _test_flushNow, _test_reset } = await import("./smart-analysis.js");

const GROUP = "120363408471622062@g.us";
const OWNER = "447525334985@c.us";
const BOT_WID = "447700900999@c.us";
const DAVID_LID = "252012071493723@lid";
const HILAL_LID = "46179639369730@lid";

function baseClient() {
  return {
    info: { wid: { _serialized: BOT_WID } },
    getContactById: async () => ({ pushname: "", isMe: false }),
    getChatById: async () => ({ sendMessage: vi.fn(async () => ({})) }),
    sendMessage: vi.fn(async () => ({ id: { _serialized: "sent" } })),
  };
}

/**
 * A driver whose contact store learns David's phone only when the
 * group's roster is re-read, as the Baileys driver does after a fresh
 * `groupMetadata` seeds the LID-to-phone pairs.
 */
function driverWithRefresh(opts: { refreshTeaches: boolean; refreshResult?: boolean }) {
  const base = makeWwebjsDriver(baseClient() as unknown as WwebjsClientLike);
  const known = new Map<string, string>();
  const refreshGroupRoster = vi.fn(async (_groupId: string) => {
    if (opts.refreshTeaches) known.set(DAVID_LID, "447881432810");
    return opts.refreshResult ?? true;
  });
  const driver: WaDriver = {
    ...base,
    getContact: async (jid: string) => ({ isMe: false, number: known.get(jid) }),
    refreshGroupRoster,
  };
  return { driver, refreshGroupRoster };
}

let seq = 0;
function message(body: string, mentionedIds: string[]) {
  seq += 1;
  return {
    from: GROUP,
    author: OWNER,
    body,
    timestamp: 1_759_000_000 + seq,
    id: { _serialized: `false_g_lid_${seq}` },
    mentionedIds,
    _data: { body, notifyName: "Kemal Ediz" },
    getContact: async () => ({ pushname: "Kemal Ediz", isMe: false }),
  } as unknown as InboundMessage;
}

function posted() {
  expect(postAnalyzeFull).toHaveBeenCalledTimes(1);
  const body = postAnalyzeFull.mock.calls[0][0] as { messages: Array<Record<string, unknown>> };
  return body.messages[0];
}

beforeEach(() => {
  postAnalyzeFull.mockReset();
  postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
  _test_reset();
});

describe("a LID mention the Pi cannot tie to a phone", () => {
  it("re-reads the group's roster once, then forwards the phone it learned", async () => {
    const { driver, refreshGroupRoster } = driverWithRefresh({ refreshTeaches: true });
    await enqueueForAnalysis(driver, message("@252012071493723 is IN", [DAVID_LID]));
    await _test_flushNow(GROUP);

    expect(refreshGroupRoster).toHaveBeenCalledTimes(1);
    expect(refreshGroupRoster).toHaveBeenCalledWith(GROUP);
    const m = posted();
    expect(m.body).toBe("@252012071493723 is IN");
    expect(m.mentions).toEqual([DAVID_LID]);
    expect(m.mentionNames).toEqual([{ jid: DAVID_LID, phone: "447881432810" }]);
  });

  it("still forwards the message, raw, when the re-read taught nothing", async () => {
    const { driver, refreshGroupRoster } = driverWithRefresh({ refreshTeaches: false });
    await enqueueForAnalysis(driver, message("@46179639369730 is IN", [HILAL_LID]));
    await _test_flushNow(GROUP);

    expect(refreshGroupRoster).toHaveBeenCalledTimes(1);
    const m = posted();
    expect(m.body).toBe("@46179639369730 is IN");
    expect(m.mentions).toEqual([HILAL_LID]);
    expect(m.mentionNames).toBeUndefined();
  });

  it("a refused re-read (rate limit) is not retried per contact", async () => {
    const { driver, refreshGroupRoster } = driverWithRefresh({ refreshTeaches: true, refreshResult: false });
    await enqueueForAnalysis(driver, message("@252012071493723 and @46179639369730 IN", [DAVID_LID, HILAL_LID]));
    await _test_flushNow(GROUP);
    expect(refreshGroupRoster).toHaveBeenCalledTimes(1);
    // The refusal means no fresh read happened, so nothing new is asked.
    expect(posted().mentionNames).toBeUndefined();
  });

  it("no re-read when every LID mention already has a phone", async () => {
    const { driver, refreshGroupRoster } = driverWithRefresh({ refreshTeaches: true });
    await driver.refreshGroupRoster!(GROUP); // David's pair is now known
    refreshGroupRoster.mockClear();
    await enqueueForAnalysis(driver, message("@252012071493723 is IN", [DAVID_LID]));
    await _test_flushNow(GROUP);
    expect(refreshGroupRoster).not.toHaveBeenCalled();
    expect(posted().mentionNames).toEqual([{ jid: DAVID_LID, phone: "447881432810" }]);
  });

  it("a driver without refreshGroupRoster (whatsapp-web.js) forwards what it has", async () => {
    const base = makeWwebjsDriver(baseClient() as unknown as WwebjsClientLike);
    await enqueueForAnalysis(base, message("@46179639369730 is IN", [HILAL_LID]));
    await _test_flushNow(GROUP);
    expect(posted().body).toBe("@46179639369730 is IN");
  });

  it("a throwing re-read never costs the message", async () => {
    const { driver } = driverWithRefresh({ refreshTeaches: false });
    driver.refreshGroupRoster = async () => {
      throw new Error("groupMetadata timed out");
    };
    await enqueueForAnalysis(driver, message("@46179639369730 is IN", [HILAL_LID]));
    await _test_flushNow(GROUP);
    expect(posted().body).toBe("@46179639369730 is IN");
  });
});
