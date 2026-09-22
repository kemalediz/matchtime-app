/**
 * A Baileys `WAMessage`, as the message object the bot above the seam has
 * always read.
 *
 * `index.ts`, `smart-analysis.ts` and `message-id.ts` were written against
 * whatsapp-web.js and read `from`, `author`, `fromMe`, `type`, `body`,
 * `_data.body`, `_data.notifyName`, `hasMedia`, `timestamp`,
 * `mentionedIds` and `id._serialized`, all through the total helpers in
 * `wa-read.ts`. Phase 2 deliberately left the message opaque, so the
 * driver's job is to hand up something those helpers read correctly.
 * Every test here reads the view back through the REAL helpers, not by
 * poking at fields, so a passing test means the bot sees what we meant.
 *
 * Fixtures are built with `proto.Message.fromObject` (plan §4.2b), so a
 * field-name typo fails here instead of on the Pi.
 */
import { describe, it, expect } from "vitest";
import Long from "long";
import { proto, type WAMessage } from "baileys";
import { readInboundHeadline, safeRead } from "../wa-read.js";
import { resolveWaMessageId } from "../message-id.js";
import { mapInboundMessage } from "./inbound.js";
import { BAILEYS_RAW, buildInboundView, rawOf } from "./inbound-view.js";

const GROUP = "120363000000000000@g.us";

function wa(
  message: Record<string, unknown>,
  key: Partial<proto.IMessageKey> = {},
  extra: Partial<WAMessage> = {},
): WAMessage {
  return {
    key: { remoteJid: GROUP, fromMe: false, id: "3EB0C0FFEE", participant: "447700900123@s.whatsapp.net", ...key },
    message: proto.Message.fromObject(message),
    messageTimestamp: 1758100000,
    pushName: "Sam",
    ...extra,
  } as WAMessage;
}

function view(raw: WAMessage, opts: { senderPhone?: string | null; upsertType?: string } = {}) {
  const mapped = mapInboundMessage(raw);
  if (!mapped) throw new Error("fixture did not map");
  return buildInboundView(raw, mapped, {
    upsertType: opts.upsertType ?? "notify",
    senderPhone: opts.senderPhone === undefined ? "447700900123" : opts.senderPhone,
  });
}

describe("the headline index.ts branches on", () => {
  it("reads a group text exactly as a whatsapp-web.js message would read", () => {
    const v = view(wa({ conversation: "in" }));
    expect(readInboundHeadline(v)).toEqual({
      from: GROUP,
      fromMe: false,
      type: "chat",
      body: "in",
      hasMedia: false,
      timestampSec: 1758100000,
      notifyName: "Sam",
    });
  });

  it("reads a DM's chat in the @c.us spelling index.ts takes a phone out of", () => {
    const v = view(wa({ conversation: "yes" }, { remoteJid: "447700900123@s.whatsapp.net", participant: undefined }));
    expect(readInboundHeadline(v).from).toBe("447700900123@c.us");
    expect(safeRead(v, "author")).toBeUndefined();
  });

  it("keeps a LID DM's chat as the LID: the phone comes from contactOf, as it always did", () => {
    const v = view(wa({ conversation: "yes" }, { remoteJid: "158055467598020@lid", participant: undefined }));
    expect(readInboundHeadline(v).from).toBe("158055467598020@lid");
  });

  it("normalises a protobuf Long timestamp (plan §2.11)", () => {
    const v = view(wa({ conversation: "in" }, {}, { messageTimestamp: Long.fromNumber(1758100001) as never }));
    expect(readInboundHeadline(v).timestampSec).toBe(1758100001);
  });

  it("leaves a missing timestamp missing, so the reader falls back to now rather than to 1970", () => {
    const v = view(wa({ conversation: "in" }, {}, { messageTimestamp: undefined }));
    expect(safeRead(v, "timestamp")).toBeUndefined();
  });

  it("classifies a voice note with the whatsapp-web.js type the DM nudge switches on", () => {
    const v = view(
      wa({ audioMessage: { ptt: true, mimetype: "audio/ogg" } }, { remoteJid: "447700900123@s.whatsapp.net", participant: undefined }),
    );
    const head = readInboundHeadline(v);
    expect(head.type).toBe("ptt");
    expect(head.hasMedia).toBe(true);
    expect(head.body).toBe("");
  });

  it("says fromMe for our own message, which index.ts then skips", () => {
    const v = view(wa({ conversation: "Teams are out" }, { fromMe: true, participant: undefined }));
    expect(readInboundHeadline(v).fromMe).toBe(true);
  });
});

describe("the id, which the server dedupes and joins reactions on", () => {
  it("is the whatsapp-web.js string, read as a REAL id rather than a synthetic one", () => {
    const v = view(wa({ conversation: "in" }));
    expect(resolveWaMessageId(v)).toEqual({
      waMessageId: `false_${GROUP}_3EB0C0FFEE_447700900123@c.us`,
      synthetic: false,
      source: "serialized",
    });
  });

  it("keeps a LID participant as addressed: the id names the key, not the person", () => {
    const v = view(wa({ conversation: "in" }, { participant: "158055467598020@lid" }));
    expect(resolveWaMessageId(v).waMessageId).toBe(`false_${GROUP}_3EB0C0FFEE_158055467598020@lid`);
  });

  it("falls back to the deterministic synthetic id only if the key cannot be serialised", () => {
    const v = view(wa({ conversation: "in" }, { id: "bad@id" }));
    const got = resolveWaMessageId(v);
    expect(got.synthetic).toBe(true);
    // And deterministic, so a replay dedupes.
    expect(resolveWaMessageId(view(wa({ conversation: "in" }, { id: "bad@id" })))).toEqual(got);
  });
});

describe("the sender, which is how attendance finds a player", () => {
  it("gives a phone-addressed author in the @c.us form phoneFromAuthor reads", () => {
    expect(safeRead(view(wa({ conversation: "in" })), "author")).toBe("447700900123@c.us");
  });

  it("gives a LID author its RESOLVED phone, so the server gets a phone and not just a name", () => {
    // Plan §2.7: the envelope's participantAlt or the local store found the
    // number. Handing up the LID here would throw that away and leave the
    // server to fuzzy-match a pushname.
    const v = view(wa({ conversation: "in" }, { participant: "158055467598020@lid" }), {
      senderPhone: "447700900123",
    });
    expect(safeRead(v, "author")).toBe("447700900123@c.us");
  });

  it("keeps an unresolved LID author as the LID, never a guess from its digits", () => {
    const v = view(wa({ conversation: "in" }, { participant: "158055467598020@lid" }), { senderPhone: null });
    expect(safeRead(v, "author")).toBe("158055467598020@lid");
  });
});

describe("mentions", () => {
  it("hands up mentioned JIDs in the spelling the server's onboarding parser reads", () => {
    const v = view(
      wa({
        extendedTextMessage: {
          text: "@447700900999 @158055467598020 you're in",
          contextInfo: { mentionedJid: ["447700900999@s.whatsapp.net", "158055467598020@lid"] },
        },
      }),
    );
    expect(v.mentionedIds).toEqual(["447700900999@c.us", "158055467598020@lid"]);
  });

  it("is an empty list, not undefined, on an ordinary message", () => {
    expect(view(wa({ conversation: "in" })).mentionedIds).toEqual([]);
  });
});

describe("the raw message travels with the view", () => {
  it("is recoverable for replyTo, which must quote the whole WAMessage", () => {
    const raw = wa({ conversation: "in" });
    const v = view(raw);
    expect(rawOf(v)).toBe(raw);
    expect(v[BAILEYS_RAW]).toBe(raw);
  });

  it("treats a bare WAMessage as its own raw, and anything else as nothing", () => {
    const raw = wa({ conversation: "in" });
    expect(rawOf(raw)).toBe(raw);
    expect(rawOf({})).toBeNull();
    expect(rawOf(null)).toBeNull();
  });

  it("does not leak the raw message into a JSON log line", () => {
    const v = view(wa({ conversation: "in" }));
    // Symbol-keyed, so a stringified view carries none of the protobuf.
    expect(JSON.stringify(v)).not.toMatch(/messageTimestamp|conversation/);
  });

  it("records the upsert type, which Phase 5's offline-replay measurement reads", () => {
    expect(view(wa({ conversation: "in" }), { upsertType: "append" }).baileys.upsertType).toBe("append");
  });
});
