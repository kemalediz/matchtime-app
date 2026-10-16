/**
 * A WHATSAPP REPLY IN AN ADMIN GROUP (2026-10-16): the Pi forwards what it
 * quotes, so the server's safe-YES rule can tell a YES to MatchTime's
 * question from a YES to another organiser.
 *
 *   Baileys contextInfo -> MappedInbound.quoted -> the view's _data names
 *   -> readQuoted -> readGroupMessageForServer's quoted fields
 */
import { describe, it, expect } from "vitest";
import { proto } from "baileys";
import type { WAMessage } from "baileys";
import { mapInboundMessage } from "./baileys/inbound.js";
import { buildInboundView } from "./baileys/inbound-view.js";
import { jidDigits, readQuoted } from "./wa-read.js";
import { readGroupMessageForServer } from "./smart-analysis.js";
import type { InboundMessage, WaDriver } from "./driver.js";

const HQ = "120363777000000001@g.us";
const BOT = "447700900999@s.whatsapp.net";

function wa(message: Record<string, unknown>): WAMessage {
  return {
    key: { remoteJid: HQ, fromMe: false, id: "3EB0YES", participant: "447700900123@s.whatsapp.net" },
    message: proto.Message.fromObject(message),
    messageTimestamp: 1760600000,
    pushName: "Raihan",
  } as WAMessage;
}

const reply = (participant: string, quoted: Record<string, unknown>) =>
  wa({ extendedTextMessage: { text: "YES", contextInfo: { stanzaId: "3EB0TEAMS", participant, quotedMessage: quoted } } });

describe("mapInboundMessage reads what a reply quotes", () => {
  it("the quoted id, its sender and its text", () => {
    const m = mapInboundMessage(reply(BOT, { conversation: "📝 Proposed teams" }));
    expect(m?.quoted).toEqual({ id: "3EB0TEAMS", participant: BOT, text: "📝 Proposed teams" });
  });

  it("an extended text or a media caption", () => {
    expect(mapInboundMessage(reply(BOT, { extendedTextMessage: { text: "Reply YES to apply." } }))?.quoted?.text).toBe("Reply YES to apply.");
    expect(mapInboundMessage(reply(BOT, { imageMessage: { caption: "Ready to post" } }))?.quoted?.text).toBe("Ready to post");
  });

  it("not a reply: no quoted field at all", () => {
    expect(mapInboundMessage(wa({ conversation: "YES" }))?.quoted).toBeUndefined();
    expect(mapInboundMessage(wa({ extendedTextMessage: { text: "@x in", contextInfo: { mentionedJid: ["1@s.whatsapp.net"] } } }))?.quoted).toBeUndefined();
  });
});

describe("the view carries it in whatsapp-web.js's names, and readQuoted reads it", () => {
  it("round trip", () => {
    const raw = reply(BOT, { conversation: "📝 Proposed teams" });
    const view = buildInboundView(raw, mapInboundMessage(raw)!, { upsertType: "notify", senderPhone: "447700900123" });
    expect(readQuoted(view)).toEqual({ id: "3EB0TEAMS", participant: BOT, text: "📝 Proposed teams" });
  });

  it("not a reply: null; a booby-trapped object: null, never a throw", () => {
    const raw = wa({ conversation: "YES" });
    expect(readQuoted(buildInboundView(raw, mapInboundMessage(raw)!, { upsertType: "notify", senderPhone: null }))).toBeNull();
    const trap = {
      get _data(): never {
        throw new Error("r");
      },
    };
    expect(readQuoted(trap)).toBeNull();
  });

  it("jidDigits strips the server and the device", () => {
    expect(jidDigits("447700900999:12@s.whatsapp.net")).toBe("447700900999");
    expect(jidDigits("158055467598020@lid")).toBe("158055467598020");
    expect(jidDigits(null)).toBe("");
  });
});

describe("readGroupMessageForServer forwards the quoted fields", () => {
  function driver(selfIds: Array<string | undefined>): WaDriver {
    return {
      selfIdentities: () => selfIds,
      contactOf: async () => null,
    } as unknown as WaDriver;
  }
  const viewOf = (raw: WAMessage) => buildInboundView(raw, mapInboundMessage(raw)!, { upsertType: "notify", senderPhone: "447700900123" }) as unknown as InboundMessage;

  it("a reply to MatchTime's own message, by phone or by LID", async () => {
    const out = await readGroupMessageForServer(driver(["447700900999@c.us", "158055467598020@lid"]), viewOf(reply("158055467598020@lid", { conversation: "📝 Proposed teams" })));
    expect(out).toMatchObject({ text: "YES", quotedMessageId: "3EB0TEAMS", quotedText: "📝 Proposed teams", quotedFromMatchTime: true });
  });

  it("a reply to another organiser", async () => {
    const out = await readGroupMessageForServer(driver([BOT]), viewOf(reply("447700900555@s.whatsapp.net", { conversation: "shall we start at 8?" })));
    expect(out).toMatchObject({ quotedText: "shall we start at 8?", quotedFromMatchTime: false });
  });

  it("the driver cannot say who it is: not MatchTime's (the server still matches the text)", async () => {
    const d = {
      selfIdentities: () => {
        throw new Error("r");
      },
      contactOf: async () => null,
    } as unknown as WaDriver;
    expect(await readGroupMessageForServer(d, viewOf(reply(BOT, { conversation: "x" })))).toMatchObject({ quotedFromMatchTime: false });
  });

  it("not a reply: no quoted fields", async () => {
    const out = await readGroupMessageForServer(driver([BOT]), viewOf(wa({ conversation: "YES" })));
    expect(out).not.toHaveProperty("quotedMessageId");
    expect(out).not.toHaveProperty("quotedFromMatchTime");
  });
});
