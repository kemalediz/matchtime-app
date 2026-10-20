/**
 * A WHATSAPP REPLY IN A PLAYERS' GROUP (2026-10-16, FNF): a player replied
 * to MatchTime's own "the bench is open" post with "Bench? We do bench
 * now?" and MatchTime stayed silent, because it was not tagged. A reply to
 * MatchTime's own message is addressed to it, like a tag.
 *
 * The Pi's half: `enqueueForAnalysis` forwards what the reply quotes to
 * /api/whatsapp/analyze with the SAME reader the admin group uses
 * (`quotedFields` in smart-analysis.ts, PR #283), and a reply to MatchTime
 * flushes at once, like a tag, rather than waiting for the 10-minute tick.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { proto } from "baileys";
import type { WAMessage } from "baileys";
import { mapInboundMessage } from "./baileys/inbound.js";
import { buildInboundView } from "./baileys/inbound-view.js";
import type { InboundMessage, WaDriver } from "./driver.js";

const postAnalyzeFull = vi.fn();
const ackInstruction = vi.fn();

vi.mock("./api.js", () => ({
  postAnalyzeFull: (...args: unknown[]) => postAnalyzeFull(...args),
  ackInstruction: (...args: unknown[]) => ackInstruction(...args),
}));

const { enqueueForAnalysis, _test_flushNow, _test_reset } = await import("./smart-analysis.js");

const GROUP = "120363000000009200@g.us";
const BOT = "447700900999@s.whatsapp.net";
const BOT_LID = "158055467598020@lid";
const PLAYER = "447700900555@s.whatsapp.net";
const BENCH_POST = "Football 9-a-side is full at 18 of 18, but the bench is open. Say IN to go on the bench.";

let seq = 0;
function wa(message: Record<string, unknown>): WAMessage {
  seq += 1;
  return {
    key: { remoteJid: GROUP, fromMe: false, id: `3EB0Q${seq}`, participant: "447700900123@s.whatsapp.net" },
    message: proto.Message.fromObject(message),
    messageTimestamp: 1760600000 + seq,
    pushName: "Raihan",
  } as WAMessage;
}

const reply = (text: string, participant: string, quoted: string) =>
  wa({ extendedTextMessage: { text, contextInfo: { stanzaId: "3EB0BENCH", participant, quotedMessage: { conversation: quoted } } } });

const viewOf = (raw: WAMessage) =>
  buildInboundView(raw, mapInboundMessage(raw)!, { upsertType: "notify", senderPhone: "447700900123" }) as unknown as InboundMessage;

const driver = {
  selfIdentities: () => ["447700900999@c.us", BOT_LID],
  contactOf: async () => null,
} as unknown as WaDriver;

function posted(): Record<string, unknown> {
  expect(postAnalyzeFull).toHaveBeenCalledTimes(1);
  return (postAnalyzeFull.mock.calls[0][0] as { messages: Array<Record<string, unknown>> }).messages[0];
}

beforeEach(() => {
  postAnalyzeFull.mockReset();
  postAnalyzeFull.mockResolvedValue({ results: [], nextKickoffMs: null });
  _test_reset();
});

describe("a players' group reply on the wire to /api/whatsapp/analyze", () => {
  it("a reply to MatchTime's own post carries its text and says it was MatchTime's, and flushes at once", async () => {
    await enqueueForAnalysis(driver, viewOf(reply("Bench? We do bench now?", BOT_LID, BENCH_POST)));
    // No `_test_flushNow`: the reply is addressed to MatchTime, so it goes now.
    const m = posted();
    expect(m).toMatchObject({ body: "Bench? We do bench now?", quotedBody: BENCH_POST, quotedFromMatchTime: true });
  });

  it("a reply carries the quoted message's id too (cross-club ask, S0): a reply to an ask finds the ask by it", async () => {
    await enqueueForAnalysis(driver, viewOf(reply("IN", BOT_LID, BENCH_POST)));
    expect(posted()).toMatchObject({ quotedMessageId: "3EB0BENCH", quotedFromMatchTime: true });
  });

  it("matched on the phone form of the bot's id as well as the LID", async () => {
    await enqueueForAnalysis(driver, viewOf(reply("IN", BOT, BENCH_POST)));
    expect(posted()).toMatchObject({ body: "IN", quotedFromMatchTime: true });
  });

  it("a reply to another player carries the text, is not MatchTime's, and waits for the batch", async () => {
    await enqueueForAnalysis(driver, viewOf(reply("haha same", PLAYER, "who's bringing the bibs?")));
    expect(postAnalyzeFull).not.toHaveBeenCalled();
    await _test_flushNow(GROUP);
    expect(posted()).toMatchObject({ quotedBody: "who's bringing the bibs?", quotedFromMatchTime: false });
  });

  it("a reply to another player names its author for the server (slice S4): their phone and WhatsApp name", async () => {
    const named = { ...driver, getContact: async () => ({ pushname: "Ali K", number: "447700900555" }) } as unknown as WaDriver;
    await enqueueForAnalysis(named, viewOf(reply("same", PLAYER, "IN")));
    await _test_flushNow(GROUP);
    expect(posted()).toMatchObject({ quotedBody: "IN", quotedFromMatchTime: false, quotedAuthorName: "Ali K", quotedAuthorPhone: "447700900555" });
  });

  it("the author's phone comes from the JID when the contact lookup fails", async () => {
    await enqueueForAnalysis(driver, viewOf(reply("same", PLAYER, "IN")));
    await _test_flushNow(GROUP);
    const m = posted();
    expect(m).toMatchObject({ quotedAuthorPhone: "447700900555" });
    expect(m).not.toHaveProperty("quotedAuthorName");
  });

  it("a reply to MatchTime names no author", async () => {
    await enqueueForAnalysis(driver, viewOf(reply("IN", BOT_LID, BENCH_POST)));
    const m = posted();
    expect(m).not.toHaveProperty("quotedAuthorName");
    expect(m).not.toHaveProperty("quotedAuthorPhone");
  });

  it("a LID author the Pi has no phone for forwards no phone (the server cannot resolve them, so they stay 'not identified')", async () => {
    const lidDriver = { ...driver, getContact: async () => ({ pushname: "Ali Khan" }) } as unknown as WaDriver;
    await enqueueForAnalysis(lidDriver, viewOf(reply("same", "158055467500001@lid", "IN")));
    await _test_flushNow(GROUP);
    const m = posted();
    expect(m).not.toHaveProperty("quotedAuthorPhone");
    // The name rides along unverified; the server never shows it.
    expect(m).toMatchObject({ quotedAuthorName: "Ali Khan", quotedFromMatchTime: false });
  });

  it("not a reply: no quoted fields at all", async () => {
    await enqueueForAnalysis(driver, viewOf(wa({ conversation: "in" })));
    await _test_flushNow(GROUP);
    const m = posted();
    expect(m).not.toHaveProperty("quotedBody");
    expect(m).not.toHaveProperty("quotedFromMatchTime");
    expect(m).not.toHaveProperty("quotedMessageId");
    expect(m).not.toHaveProperty("quotedAuthorPhone");
  });
});

describe("the Pi says it forwards quoted ids (review M3)", () => {
  it("its capability header carries quoted-id beside admin-group", async () => {
    const api = await vi.importActual<typeof import("./api.js")>("./api.js");
    expect(api.PI_CAPS.split(",")).toEqual(expect.arrayContaining(["admin-group", "quoted-id"]));
  });
});

describe("MatchTime's in-group reply is acked when the server claimed it (slice S4 review)", () => {
  it("the reply is sent, then acked with its key and the sent id", async () => {
    ackInstruction.mockReset();
    postAnalyzeFull.mockImplementation(async (p: { messages: Array<{ waMessageId: string }> }) => ({
      results: [{ waMessageId: p.messages[0].waMessageId, handledBy: "llm", intent: "q", react: null, reply: "That match is already recorded.", replyKey: "greply:org-1:x" }],
      nextKickoffMs: null,
    }));
    const sending = { ...driver, sendText: vi.fn(async () => ({ id: { _serialized: `true_${GROUP}_3EB0REPLY` } })) } as unknown as WaDriver;
    await enqueueForAnalysis(sending, viewOf(wa({ conversation: "@Match Time what was the score?" })));
    await _test_flushNow(GROUP);
    expect(ackInstruction).toHaveBeenCalledWith({ key: "greply:org-1:x", kind: "group-reply", waMessageId: `true_${GROUP}_3EB0REPLY` });
  });

  it("a reply the server did not claim is not acked", async () => {
    ackInstruction.mockReset();
    postAnalyzeFull.mockImplementation(async (p: { messages: Array<{ waMessageId: string }> }) => ({
      results: [{ waMessageId: p.messages[0].waMessageId, handledBy: "llm", intent: "q", react: null, reply: "hi" }],
      nextKickoffMs: null,
    }));
    const sending = { ...driver, sendText: vi.fn(async () => ({})) } as unknown as WaDriver;
    await enqueueForAnalysis(sending, viewOf(wa({ conversation: "@Match Time hi" })));
    await _test_flushNow(GROUP);
    expect(ackInstruction).not.toHaveBeenCalled();
  });
});

