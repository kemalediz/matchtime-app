/**
 * A WHATSAPP SWIPE-REPLY IN A DM (quoted-reply context, slice S1,
 * 2026-10-20). A player may have several MatchTime DMs and swipe-reply to
 * an earlier one; the quoted one is the thing they are answering.
 *
 * The groups already forward what a reply quotes; DMs did not. Now the DM
 * door reads it with the SAME reader (`readQuotedFields`, wa-read.ts, which
 * now also owns `quotedFromBot`) and `postDmReply` carries it to
 * /api/whatsapp/dm-reply. An older server ignores the extra fields.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { proto } from "baileys";
import type { WAMessage } from "baileys";
import { mapInboundMessage } from "./baileys/inbound.js";
import { buildInboundView } from "./baileys/inbound-view.js";
import { quotedFromBot, readQuotedFields } from "./wa-read.js";
import { postDmReply } from "./api.js";

const fetchMock = vi.fn();

const BOT_LID = "158055467598020@lid";
const self = { selfIdentities: () => ["447700900999@c.us", BOT_LID] };
const ALI_CHAT = "447700900123@s.whatsapp.net";
const PAY_CHASE = "Hi Ali, you owe £6 for Tuesday. Pay here: https://mt.example/p/x";

function dm(message: Record<string, unknown>): WAMessage {
  return {
    key: { remoteJid: ALI_CHAT, fromMe: false, id: "3EB0DM1" },
    message: proto.Message.fromObject(message),
    messageTimestamp: 1760900000,
    pushName: "Ali",
  } as WAMessage;
}

const viewOf = (raw: WAMessage) =>
  buildInboundView(raw, mapInboundMessage(raw)!, { upsertType: "notify", senderPhone: "447700900123" });

const swipe = (text: string, participant: string | undefined, quoted: string) =>
  dm({
    extendedTextMessage: {
      text,
      contextInfo: { stanzaId: "3EB0PAY", ...(participant ? { participant } : {}), quotedMessage: { conversation: quoted } },
    },
  });

describe("readQuotedFields on a DM", () => {
  it("a swipe-reply to MatchTime's DM: its id, its text, and that it was MatchTime's", () => {
    expect(readQuotedFields(self, viewOf(swipe("done", BOT_LID, PAY_CHASE)))).toEqual({
      quotedMessageId: "3EB0PAY",
      quotedText: PAY_CHASE,
      quotedFromMatchTime: true,
    });
  });

  it("a reply quoting the player's own message is not MatchTime's", () => {
    expect(readQuotedFields(self, viewOf(swipe("this", ALI_CHAT, "my earlier message")))).toMatchObject({
      quotedMessageId: "3EB0PAY",
      quotedFromMatchTime: false,
    });
  });

  it("a plain DM (no swipe) carries no quote fields at all", () => {
    expect(readQuotedFields(self, viewOf(dm({ conversation: "done" })))).toEqual({});
  });

  it("caps the quoted text at 2000", () => {
    const got = readQuotedFields(self, viewOf(swipe("ok", BOT_LID, "x".repeat(2500))));
    expect(got.quotedText).toHaveLength(2000);
  });
});

describe("quotedFromBot", () => {
  it("matches every form of the bot's own id, on digits", () => {
    expect(quotedFromBot(self, "447700900999@s.whatsapp.net")).toBe(true);
    expect(quotedFromBot(self, "447700900999:5@s.whatsapp.net")).toBe(true);
    expect(quotedFromBot(self, BOT_LID)).toBe(true);
    expect(quotedFromBot(self, ALI_CHAT)).toBe(false);
    expect(quotedFromBot(self, null)).toBe(false);
  });

  it("is false when the driver cannot say", () => {
    expect(quotedFromBot({ selfIdentities: () => { throw new Error("not connected"); } }, BOT_LID)).toBe(false);
  });
});

describe("postDmReply carries the quote", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards quotedMessageId, quotedText and quotedFromMatchTime beside today's fields", async () => {
    await postDmReply({
      phone: "447700900123",
      body: "done",
      waMessageId: "true_x_3EB0DM1",
      ...readQuotedFields(self, viewOf(swipe("done", BOT_LID, PAY_CHASE))),
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/whatsapp\/dm-reply$/);
    expect(JSON.parse(String(init.body))).toEqual({
      phone: "447700900123",
      body: "done",
      waMessageId: "true_x_3EB0DM1",
      quotedMessageId: "3EB0PAY",
      quotedText: PAY_CHASE,
      quotedFromMatchTime: true,
    });
  });

  it("a DM that is not a reply posts exactly today's body", async () => {
    await postDmReply({ phone: "447700900123", body: "done", waMessageId: "w1", ...readQuotedFields(self, viewOf(dm({ conversation: "done" }))) });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      phone: "447700900123",
      body: "done",
      waMessageId: "w1",
    });
  });
});

describe("the DM door uses the shared reader (index.ts, source text: importing it builds a client)", () => {
  const SRC = path.dirname(fileURLToPath(import.meta.url));
  const index = readFileSync(path.join(SRC, "index.ts"), "utf8");
  const smart = readFileSync(path.join(SRC, "smart-analysis.ts"), "utf8");

  it("the live DM forward spreads readQuotedFields(driver, msg)", () => {
    const call = index.slice(index.indexOf("await postDmReply({\n            phone,\n            authorName,\n            body: text,\n            waMessageId: resolveWaMessageId"));
    expect(call.length).toBeGreaterThan(0);
    expect(call.slice(0, 400)).toContain("...readQuotedFields(driver, msg)");
  });

  it("the groups read through the same function; there is no second copy of quotedFromBot", () => {
    expect(smart).toContain("readQuotedFields(");
    expect(smart).not.toMatch(/function quotedFromBot\b/);
  });
});
