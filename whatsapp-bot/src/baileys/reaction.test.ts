/**
 * A Baileys `messages.reaction` event, as the payload `index.ts` reads.
 *
 * The server joins a reaction to what it sent by EXACT string match on
 * `waMessageId` (`src/app/api/whatsapp/reaction/route.ts`). So the only
 * question that matters here is: does the id we hand up equal, byte for
 * byte, the id the database stored when the bot sent the message?
 *
 * The trap Phase 3 named: DMs now arrive under `@lid`, and Baileys writes
 * the reacted-to key's `remoteJid` as the CHAT's id
 * (`process-message.js` `normaliseKey`: `msgKey.remoteJid =
 * message.key.remoteJid`). The bot sent that DM to the PHONE
 * (`sendDirectText`), and the database stored
 * `true_447...@c.us_<id>`. Serialised naively, the reaction reads
 * `true_158...@lid_<id>`, the join misses, and a recruit's 👍 vanishes
 * with nothing logged anywhere.
 *
 * The event fixtures below are shaped exactly as `process-message.js`
 * emits them: `key` is the target (already normalised to our
 * perspective), `reaction.key` is the reaction message's own envelope,
 * alts included.
 */
import { describe, it, expect, vi } from "vitest";
import { safePath, safeRead, asString } from "../wa-read.js";
import { mapReaction, type ReactionEvent } from "./reaction.js";

const ME_PN = "447700900001@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";
const PLAYER_PN = "447700900123@s.whatsapp.net";
const PLAYER_LID = "158055467598020@lid";

function deps(over: Partial<Parameters<typeof mapReaction>[1]> = {}) {
  return {
    ownJidFor: vi.fn((_chat: string) => ME_PN as string | undefined),
    phoneForLid: vi.fn(async (_lid: string) => null as string | null),
    ...over,
  };
}

/** What index.ts reads, read the way index.ts reads it. */
function asIndexSees(payload: unknown) {
  return {
    waMessageId: asString(safePath(payload, "msgId", "_serialized")),
    fromId: asString(safeRead(payload, "senderId")),
    emoji: asString(safeRead(payload, "reaction")),
  };
}

function dmReaction(opts: { chat: string; alt?: string; text?: string; targetId?: string }): ReactionEvent {
  return {
    key: { remoteJid: opts.chat, fromMe: true, id: opts.targetId ?? "3EB0OFFER" },
    reaction: {
      text: opts.text ?? "👍",
      key: {
        remoteJid: opts.chat,
        remoteJidAlt: opts.alt,
        fromMe: false,
        id: "3EB0REACT",
      },
    },
  };
}

describe("DM reactions resolve to the phone form the database stored", () => {
  it("leaves a phone-addressed DM exactly as serializeKey writes it", async () => {
    const got = await mapReaction(dmReaction({ chat: PLAYER_PN }), deps());
    expect(got.kind).toBe("forward");
    expect(asIndexSees(got.kind === "forward" && got.payload)).toEqual({
      waMessageId: "true_447700900123@c.us_3EB0OFFER",
      fromId: "447700900123@c.us",
      emoji: "👍",
    });
  });

  it("converts a LID-addressed DM to the phone form using the envelope's own alt", async () => {
    const d = deps();
    const got = await mapReaction(dmReaction({ chat: PLAYER_LID, alt: PLAYER_PN }), d);
    expect(got.kind === "forward" && asIndexSees(got.payload).waMessageId).toBe(
      "true_447700900123@c.us_3EB0OFFER",
    );
    // The envelope was enough: no store read.
    expect(d.phoneForLid).not.toHaveBeenCalled();
  });

  it("falls back to the harvested/local mapping when the envelope has no alt", async () => {
    const d = deps({
      phoneForLid: vi.fn(async (lid: string) => (lid === PLAYER_LID ? "447700900123" : null)),
    });
    const got = await mapReaction(dmReaction({ chat: PLAYER_LID }), d);
    expect(got.kind === "forward" && asIndexSees(got.payload)).toEqual({
      waMessageId: "true_447700900123@c.us_3EB0OFFER",
      fromId: "447700900123@c.us",
      emoji: "👍",
    });
  });

  it("when the LID cannot be mapped, hands up NO id, so index.ts records reaction-forwarding", async () => {
    // Never the LID-form id: it cannot match anything stored, so forwarding
    // it would be the silent miss this module exists to prevent. An empty
    // msgId with a real emoji and sender is exactly the condition index.ts
    // turns into `recordDegradedCapability("reaction-forwarding")` plus a
    // CRITICAL line, which reaches the server on the next heartbeat.
    const got = await mapReaction(dmReaction({ chat: PLAYER_LID }), deps());
    expect(got.kind).toBe("forward");
    if (got.kind !== "forward") return;
    const seen = asIndexSees(got.payload);
    expect(seen.waMessageId).toBe("");
    expect(seen.emoji).toBe("👍");
    expect(seen.fromId).toBe(PLAYER_LID);
    expect(got.unresolved).toEqual({
      reason: expect.stringMatching(/no phone number/),
      lid: PLAYER_LID,
      wouldHaveBeen: "true_158055467598020@lid_3EB0OFFER",
    });
  });

  it("does not count a removed reaction whose target cannot be mapped as a failure", async () => {
    // An empty emoji is a player taking their reaction back; index.ts
    // ignores it before it looks at the id, so it is not lost data.
    const got = await mapReaction(dmReaction({ chat: PLAYER_LID, text: "" }), deps());
    expect(got.kind === "forward" && got.unresolved).toBeFalsy();
    expect(got.kind === "forward" && asIndexSees(got.payload).emoji).toBe("");
  });

  it("survives a mapping lookup that throws, as an unresolved target", async () => {
    const d = deps({
      phoneForLid: vi.fn(async () => {
        throw new Error("store broken");
      }),
    });
    const got = await mapReaction(dmReaction({ chat: PLAYER_LID }), d);
    expect(got.kind === "forward" && got.unresolved?.reason).toMatch(/store broken/);
  });
});

describe("group reactions", () => {
  it("keeps a player's message key as addressed, participant and all", async () => {
    // Reacting to someone else's message: the id must equal the one the
    // inbound path stored, which is serializeKey of the same key.
    const evt: ReactionEvent = {
      key: { remoteJid: GROUP, fromMe: false, id: "3EB0IN", participant: PLAYER_LID },
      reaction: { text: "✅", key: { remoteJid: GROUP, fromMe: false, id: "R1", participant: PLAYER_PN } },
    };
    const got = await mapReaction(evt, deps());
    expect(got.kind === "forward" && asIndexSees(got.payload).waMessageId).toBe(
      `false_${GROUP}_3EB0IN_158055467598020@lid`,
    );
  });

  it("puts OUR id on a reaction to our own post by the same rule the send used", async () => {
    // The reactor's client writes our participant in ITS addressing (our
    // LID, in a LID group), and if it omits it Baileys fills in the
    // REACTOR. Either way the string would not match what `send()` stored
    // via completeOwnKey. So the participant is overwritten with ownJidFor,
    // the function the send path uses, and the two cannot disagree.
    const d = deps({ ownJidFor: vi.fn(() => "447700900001:12@s.whatsapp.net") });
    const evt: ReactionEvent = {
      key: { remoteJid: GROUP, fromMe: true, id: "3EB0BENCH", participant: "158000000000001@lid" },
      reaction: { text: "👍", key: { remoteJid: GROUP, fromMe: false, id: "R2", participant: PLAYER_PN } },
    };
    const got = await mapReaction(evt, d);
    expect(d.ownJidFor).toHaveBeenCalledWith(GROUP);
    expect(got.kind === "forward" && asIndexSees(got.payload).waMessageId).toBe(
      `true_${GROUP}_3EB0BENCH_447700900001@c.us`,
    );
  });

  it("resolves a LID reactor to a phone sender when the envelope carries one", async () => {
    const evt: ReactionEvent = {
      key: { remoteJid: GROUP, fromMe: true, id: "3EB0BENCH" },
      reaction: {
        text: "👎",
        key: {
          remoteJid: GROUP,
          fromMe: false,
          id: "R3",
          participant: PLAYER_LID,
          participantAlt: PLAYER_PN,
        },
      },
    };
    const got = await mapReaction(evt, deps());
    expect(got.kind === "forward" && asIndexSees(got.payload).fromId).toBe("447700900123@c.us");
  });

  it("keeps a LID reactor it cannot resolve as the LID, which index.ts forwards by name", async () => {
    const evt: ReactionEvent = {
      key: { remoteJid: GROUP, fromMe: true, id: "3EB0BENCH" },
      reaction: { text: "👎", key: { remoteJid: GROUP, fromMe: false, id: "R4", participant: PLAYER_LID } },
    };
    const got = await mapReaction(evt, deps());
    expect(got.kind === "forward" && asIndexSees(got.payload).fromId).toBe(PLAYER_LID);
    // The TARGET resolved fine, so this is not a lost reaction.
    expect(got.kind === "forward" && got.unresolved).toBeFalsy();
  });
});

describe("what is not a player's reaction", () => {
  it("does not forward the echo of the bot's OWN reaction", async () => {
    // Baileys emits our own sends back (emitOwnEvents defaults to true), so
    // every ✅ the flush places would otherwise be POSTed to the server as
    // if a player had reacted.
    const evt: ReactionEvent = {
      key: { remoteJid: GROUP, fromMe: false, id: "3EB0IN", participant: PLAYER_PN },
      reaction: { text: "✅", key: { remoteJid: GROUP, fromMe: true, id: "R5" } },
    };
    expect((await mapReaction(evt, deps())).kind).toBe("own");
  });

  it("never throws on a malformed event", async () => {
    for (const bad of [null, undefined, {}, { key: {} }, { reaction: {} }] as unknown[]) {
      const got = await mapReaction(bad as ReactionEvent, deps());
      expect(["forward", "own"]).toContain(got.kind);
    }
  });
});
