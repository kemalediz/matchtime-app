import { describe, it, expect } from "vitest";
import { proto } from "baileys";
import type { WAMessage } from "baileys";
import { mapInboundMessage, toNumber } from "./inbound.js";

/**
 * Message shapes are built with Baileys' OWN protobuf classes
 * (`proto.Message.fromObject`) rather than hand-written objects, so a
 * field-name typo fails here instead of silently passing and then failing
 * on the Pi. It also gives us real protobuf `Long`s, which is the only
 * honest way to exercise `toNumber`.
 */
function wa(
  message: Record<string, unknown> | null,
  key: Partial<proto.IMessageKey> = {},
  extra: Partial<WAMessage> = {},
): WAMessage {
  return {
    key: {
      remoteJid: "120363000000000000@g.us",
      fromMe: false,
      id: "3EB0C0FFEE",
      participant: "447700900123@s.whatsapp.net",
      ...key,
    },
    message: message === null ? null : proto.Message.fromObject(message),
    messageTimestamp: 1758100000,
    pushName: "Sam",
    ...extra,
  } as WAMessage;
}

describe("toNumber", () => {
  it("unwraps a protobuf Long, which messageTimestamp and fileLength both are", () => {
    const m = proto.Message.fromObject({
      documentMessage: { mimetype: "application/pdf", fileLength: 6144 },
    });
    const len = m.documentMessage!.fileLength;
    // Guard the premise: if this stops being a Long the test is worthless.
    expect(typeof len === "number").toBe(false);
    expect(toNumber(len)).toBe(6144);
  });

  it("passes a plain number through and yields 0 for nothing", () => {
    expect(toNumber(17)).toBe(17);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber(null)).toBe(0);
  });
});

describe("mapInboundMessage: text", () => {
  it("reads a plain conversation", () => {
    const m = mapInboundMessage(wa({ conversation: "I'm in" }));
    expect(m).toMatchObject({ id: "3EB0C0FFEE", type: "chat", body: "I'm in", hasMedia: false });
  });

  it("reads an extendedTextMessage", () => {
    const m = mapInboundMessage(wa({ extendedTextMessage: { text: "out this week" } }));
    expect(m?.body).toBe("out this week");
  });

  it("unwraps an ephemeral message", () => {
    const m = mapInboundMessage(
      wa({ ephemeralMessage: { message: { extendedTextMessage: { text: "in" } } } }),
    );
    expect(m?.body).toBe("in");
  });

  it("unwraps a view-once message", () => {
    const m = mapInboundMessage(
      wa({ viewOnceMessageV2: { message: { extendedTextMessage: { text: "in" } } } }),
    );
    expect(m?.body).toBe("in");
  });

  it("trims, and drops a message that is only whitespace", () => {
    expect(mapInboundMessage(wa({ conversation: "   in  " }))?.body).toBe("in");
    expect(mapInboundMessage(wa({ conversation: "   " }))).toBeNull();
  });
});

describe("mapInboundMessage: identity and context", () => {
  it("carries the chat, the sender and the group flag for a group message", () => {
    const m = mapInboundMessage(wa({ conversation: "in" }));
    expect(m).toMatchObject({
      chatJid: "120363000000000000@g.us",
      senderJid: "447700900123@s.whatsapp.net",
      isGroup: true,
      fromMe: false,
    });
  });

  it("uses remoteJid as the sender in a DM, where there is no participant", () => {
    const m = mapInboundMessage(
      wa({ conversation: "yes" }, { remoteJid: "447700900123@s.whatsapp.net", participant: undefined }),
    );
    expect(m).toMatchObject({ senderJid: "447700900123@s.whatsapp.net", isGroup: false });
  });

  it("carries pushName, which is the identity that survives everything", () => {
    expect(mapInboundMessage(wa({ conversation: "in" }))?.pushName).toBe("Sam");
    expect(mapInboundMessage(wa({ conversation: "in" }, {}, { pushName: undefined }))?.pushName).toBeNull();
  });

  it("normalises messageTimestamp to seconds, Long or not", () => {
    expect(mapInboundMessage(wa({ conversation: "in" }))?.timestampSec).toBe(1758100000);
  });

  it("keeps the whole key, because a reaction cannot be sent without it", () => {
    const m = mapInboundMessage(wa({ conversation: "in" }));
    expect(m?.key).toMatchObject({
      remoteJid: "120363000000000000@g.us",
      fromMe: false,
      id: "3EB0C0FFEE",
      participant: "447700900123@s.whatsapp.net",
    });
  });
});

describe("mapInboundMessage: mentions", () => {
  it("reads mentionedJid off the contextInfo", () => {
    const m = mapInboundMessage(
      wa({
        extendedTextMessage: {
          text: "@447700900999 is replacing me",
          contextInfo: { mentionedJid: ["447700900999@s.whatsapp.net"] },
        },
      }),
    );
    expect(m?.mentionedJids).toEqual(["447700900999@s.whatsapp.net"]);
  });

  it("gives an empty list, not undefined, when nothing is mentioned", () => {
    expect(mapInboundMessage(wa({ conversation: "in" }))?.mentionedJids).toEqual([]);
  });
});

describe("mapInboundMessage: media", () => {
  it.each([
    ["imageMessage", { mimetype: "image/jpeg" }, "image"],
    ["videoMessage", { mimetype: "video/mp4" }, "video"],
    ["stickerMessage", { mimetype: "image/webp" }, "sticker"],
    ["documentMessage", { mimetype: "application/pdf", fileName: "x.pdf" }, "document"],
  ])("maps %s to the whatsapp-web.js type name %s", (field, node, expected) => {
    const m = mapInboundMessage(wa({ [field]: node }));
    expect(m).toMatchObject({ type: expected, hasMedia: true, body: "" });
  });

  it("distinguishes a voice note (ptt) from ordinary audio, as wwebjs did", () => {
    expect(mapInboundMessage(wa({ audioMessage: { mimetype: "audio/ogg", ptt: true } }))?.type).toBe("ptt");
    expect(mapInboundMessage(wa({ audioMessage: { mimetype: "audio/ogg" } }))?.type).toBe("audio");
  });

  it("keeps a caption as the body, from the wrapped documentWithCaption shape", () => {
    const m = mapInboundMessage(
      wa({
        documentWithCaptionMessage: {
          message: {
            documentMessage: { mimetype: "application/pdf", fileName: "team.pdf", caption: "line-up" },
          },
        },
      }),
    );
    expect(m).toMatchObject({ type: "document", body: "line-up", hasMedia: true });
  });
});

describe("mapInboundMessage: what it refuses", () => {
  it("returns null for a message that failed to decrypt (no content)", () => {
    expect(mapInboundMessage(wa(null))).toBeNull();
  });

  it("returns null for a message with no id, which nothing downstream can use", () => {
    expect(mapInboundMessage(wa({ conversation: "in" }, { id: undefined }))).toBeNull();
  });

  it("returns null for shapes this phase does not handle", () => {
    // Reactions arrive on their own event; protocol messages are edits and
    // deletes. Both are Phase 3+ work and must not be mistaken for text.
    expect(mapInboundMessage(wa({ reactionMessage: { text: "\u{1F44D}" } }))).toBeNull();
    expect(
      mapInboundMessage(wa({ protocolMessage: { type: 14, editedMessage: { conversation: "edited" } } })),
    ).toBeNull();
    expect(mapInboundMessage(wa({ pollCreationMessageV3: { name: "MoM", options: [] } }))).toBeNull();
  });

  it("never throws, whatever it is handed", () => {
    expect(() => mapInboundMessage(undefined as unknown as WAMessage)).not.toThrow();
    expect(mapInboundMessage(undefined as unknown as WAMessage)).toBeNull();
    expect(mapInboundMessage({} as WAMessage)).toBeNull();
  });
});
