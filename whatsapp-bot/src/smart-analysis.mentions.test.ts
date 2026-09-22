/**
 * End-to-end on the Pi: what actually reaches `/api/whatsapp/analyze`
 * when a message @-mentions people.
 *
 * `mentions.ts` pins the pure rule; this pins the WIRING — that
 * `enqueueForAnalysis` → `enrichInbound` → `flushGroup` carries the raw
 * tokens, the structured `mentionNames`, and `botMentioned` all the way
 * to the POST body, including when the injected layer is throwing.
 *
 * The two messages below are the real ones from the live Sutton FC group
 * on 2026-09-07/08. Under the old code the first arrived as
 * "@DÇ  is out due to unforeseen issue at work" and the second as
 * "@割::::.̸̢̤̋̃̓̉͗̏̾̃̌̚͘̕.̵͆͂ and @Najib out"; both drops were lost.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InboundMessage } from "./driver.js";
import { makeWwebjsDriver, type WwebjsClientLike } from "./drivers/wwebjs.js";

const postAnalyzeFull = vi.fn();

vi.mock("./api.js", () => ({
  postAnalyzeFull: (...args: unknown[]) => postAnalyzeFull(...args),
}));

const { enqueueForAnalysis, _test_flushNow, _test_reset } = await import("./smart-analysis.js");

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

const GROUP = "120363000000009100@g.us";
const OWNER = "447700900001@c.us";
const BOT_WID = "447700900999@c.us";
const BOT_LID = "111222333444555@lid";

const SHAHROKH_LID = "158055467598020@lid";
const DAVID_LID = "233452997767322@lid";
const NAJIB_CUS = "447700900321@c.us";

const DAVID_PUSHNAME = "割::::.̸̢̤̋̃̓̉͗̏̾̃̌̚͘̕.̵͆͂";

/** Contacts as the live WhatsApp Web build reports them. */
const CONTACTS: Record<string, Record<string, unknown>> = {
  [SHAHROKH_LID]: { pushname: "DÇ", isMe: false },
  [DAVID_LID]: { pushname: DAVID_PUSHNAME, isMe: false },
  [NAJIB_CUS]: { pushname: "Najib", isMe: false },
  [BOT_LID]: { pushname: "Match Time", isMe: true },
};

function client() {
  return {
    info: { wid: { _serialized: BOT_WID } },
    getContactById: async (jid: string) => CONTACTS[jid] ?? { pushname: "", isMe: false },
    getChatById: async () => ({ sendMessage: vi.fn(async () => ({})) }),
    sendMessage: vi.fn(async () => ({ id: { _serialized: "sent" } })),
  };
}

/** A client whose contact lookups all die, as on the broken build. */
function brokenContactsClient() {
  return {
    info: { wid: { _serialized: BOT_WID } },
    getContactById: async () => {
      throw new Error("r");
    },
    getChatById: async () => ({ sendMessage: vi.fn(async () => ({})) }),
    sendMessage: vi.fn(async () => ({ id: { _serialized: "sent" } })),
  };
}

let seq = 0;
function message(body: string, mentionedIds: string[]) {
  seq += 1;
  return {
    from: GROUP,
    author: OWNER,
    body,
    timestamp: 1_757_000_000 + seq,
    id: { _serialized: `false_g_${seq}` },
    mentionedIds,
    _data: { body, notifyName: "Kemal Ediz" },
    getContact: async () => ({ pushname: "Kemal Ediz", isMe: false }),
  };
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

describe("@-mentions on the wire to /api/whatsapp/analyze", () => {
  it("REGRESSION (Shahrokh, 2026-09-07): the pushname never reaches the body", async () => {
    await enqueueForAnalysis(
      asClient(client()),
      asMessage(
        message(`@158055467598020 is out due to unforeseen issue at work`, [SHAHROKH_LID]),
      ),
    );
    await _test_flushNow(GROUP);

    const m = posted();
    expect(m.body).toBe("@158055467598020 is out due to unforeseen issue at work");
    expect(m.body).not.toContain("DÇ");
    expect(m.mentions).toEqual([SHAHROKH_LID]);
    expect(m.mentionNames).toEqual([{ jid: SHAHROKH_LID, name: "DÇ" }]);
    expect(m.botMentioned).toBe(false);
  });

  it("REGRESSION (David, 2026-09-08): several mentions, none of them named here", async () => {
    await enqueueForAnalysis(
      asClient(client()),
      asMessage(message(`@233452997767322 and @447700900321 out`, [DAVID_LID, NAJIB_CUS])),
    );
    await _test_flushNow(GROUP);

    const m = posted();
    expect(m.body).toBe("@233452997767322 and @447700900321 out");
    expect(m.body).not.toContain("割");
    expect(m.mentionNames).toEqual([
      { jid: DAVID_LID, name: "割::::.." }, // the UserAlias key for David
      { jid: NAJIB_CUS, name: "Najib" },
    ]);
    expect(m.botMentioned).toBe(false);
  });

  it("still rewrites the BOT's own mention to @Match Time, and still sets botMentioned", async () => {
    await enqueueForAnalysis(
      asClient(client()),
      asMessage(
        message(`@111222333444555 put me and @233452997767322 in the same team`, [
          BOT_LID,
          DAVID_LID,
        ]),
      ),
    );
    await _test_flushNow(GROUP);

    const m = posted();
    // Load-bearing: lib/interaction-contract.ts's text fallback matches on
    // exactly this, and it is the second signal behind botMentioned.
    expect(m.body).toBe("@Match Time put me and @233452997767322 in the same team");
    expect(m.botMentioned).toBe(true);
    // The bot is not a player and never becomes a mention candidate.
    expect(m.mentionNames).toEqual([{ jid: DAVID_LID, name: "割::::.." }]);
  });

  it("botMentioned survives a contact lookup that throws (JID match)", async () => {
    await enqueueForAnalysis(
      asClient({ ...brokenContactsClient(), info: { wid: { _serialized: BOT_LID } } }),
      asMessage(message(`@111222333444555 how many so far?`, [BOT_LID])),
    );
    await _test_flushNow(GROUP);

    const m = posted();
    expect(m.botMentioned).toBe(true);
    expect(m.body).toBe("@Match Time how many so far?");
  });

  it("degrades honestly when contacts cannot be read: raw tokens, no names", async () => {
    await enqueueForAnalysis(
      asClient(brokenContactsClient()),
      asMessage(message(`@233452997767322 and @447700900321 out`, [DAVID_LID, NAJIB_CUS])),
    );
    await _test_flushNow(GROUP);

    const m = posted();
    expect(m.body).toBe("@233452997767322 and @447700900321 out");
    expect(m.mentionNames).toBeUndefined();
    expect(m.mentions).toEqual([DAVID_LID, NAJIB_CUS]);
  });

  it("sends no mentionNames key at all for an ordinary message", async () => {
    await enqueueForAnalysis(asClient(client()), asMessage(message("im in", [])));
    await _test_flushNow(GROUP);

    const m = posted();
    expect(m.mentionNames).toBeUndefined();
    expect(m.mentions).toBeUndefined();
  });
});
