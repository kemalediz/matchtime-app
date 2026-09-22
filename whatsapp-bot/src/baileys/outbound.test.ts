/**
 * What the Baileys driver hands to `sock.sendMessage`, proved against
 * Baileys' OWN message generator rather than against our idea of it.
 *
 * `generateWAMessageContent` and `generateWAMessage` are the functions
 * `sendMessage` calls to turn our content object into the protobuf that
 * goes on the wire. They are pure apart from the hooks we pass in (the
 * link-preview fetcher, the media uploader), so running them here proves
 * the wire shape with no socket, no network and no WhatsApp account.
 *
 * Why that matters here specifically: HomeTenant, the only Baileys
 * precedent we have, has never sent a mention, a reaction or a poll. For
 * those three this file is the only evidence before Phase 5.
 */
import { describe, it, expect, vi } from "vitest";
import { generateWAMessage, generateWAMessageContent, proto, type WAMessage } from "baileys";
import {
  completeOwnKey,
  mentionContent,
  mentionJids,
  pollContent,
  reactionContent,
  textContent,
} from "./outbound.js";

/** The generator options a text, poll or reaction needs, with the two hooks spied. */
function genOptions() {
  return {
    getUrlInfo: vi.fn(async () => undefined),
    upload: vi.fn(async () => {
      throw new Error("no test may upload media");
    }),
  };
}

const MAGIC = "Your ratings link: https://matchtime.app/r/Ab3dE";

describe("textContent (§2.6: never fetch the links we send)", () => {
  it("sets linkPreview to null, present, not undefined", () => {
    const c = textContent("hi");
    expect(c).toEqual({ text: "hi", linkPreview: null });
    expect("linkPreview" in c).toBe(true);
  });

  it("stops Baileys fetching the URL in a magic link", async () => {
    const opts = genOptions();
    await generateWAMessageContent(textContent(MAGIC), opts as never);
    expect(opts.getUrlInfo).not.toHaveBeenCalled();
  });

  it("control: a bare { text } WOULD have fetched it, so the test above can fail", async () => {
    // Without this, the test above would also pass if Baileys had simply
    // stopped generating previews, and we would learn nothing.
    const opts = genOptions();
    await generateWAMessageContent({ text: MAGIC }, opts as never);
    expect(opts.getUrlInfo).toHaveBeenCalledTimes(1);
  });
});

describe("mentions", () => {
  it("turns bare phones into Baileys person JIDs, not whatsapp-web.js ones", () => {
    expect(mentionJids(["447700900123", "447700900124"])).toEqual([
      "447700900123@s.whatsapp.net",
      "447700900124@s.whatsapp.net",
    ]);
  });

  it("tolerates a + or spacing, and drops an entry with no phone in it", () => {
    // A JID with no digits is a mention of nobody; WhatsApp would drop it
    // at best. Better never to send it.
    expect(mentionJids(["+44 7700 900123", "", "abc", "0"])).toEqual([
      "447700900123@s.whatsapp.net",
    ]);
  });

  it("puts the JIDs on the message, with previews still off", () => {
    expect(mentionContent("@447700900123 you're in", ["447700900123"])).toEqual({
      text: "@447700900123 you're in",
      linkPreview: null,
      mentions: ["447700900123@s.whatsapp.net"],
    });
  });

  it("sends no mentions field at all when there is nobody to mention", () => {
    // Mirrors the whatsapp-web.js driver, which passed no options object
    // rather than { mentions: [] }.
    const c = mentionContent("hello", []);
    expect(c).toEqual({ text: "hello", linkPreview: null });
    expect("mentions" in c).toBe(false);
  });

  it("reaches the wire as contextInfo.mentionedJid on an extendedTextMessage", async () => {
    const m = await generateWAMessageContent(
      mentionContent("@447700900123 @447700900124 bench spot open", [
        "447700900123",
        "447700900124",
      ]),
      genOptions() as never,
    );
    // A plain `conversation` has nowhere to put a mention, so a mention
    // that came out as one would tag nobody.
    expect(m.conversation).toBeFalsy();
    expect(m.extendedTextMessage?.text).toBe("@447700900123 @447700900124 bench spot open");
    expect(m.extendedTextMessage?.contextInfo?.mentionedJid).toEqual([
      "447700900123@s.whatsapp.net",
      "447700900124@s.whatsapp.net",
    ]);
  });
});

describe("pollContent", () => {
  it("maps allowMultipleAnswers the way whatsapp-web.js did: any number is 0, one is 1", () => {
    // whatsapp-web.js 1.34.7, Injected/Utils.js:
    //   pollSelectableOptionsCount: allowMultipleAnswers ? 0 : 1
    expect(pollContent("MoM?", ["A", "B"], true)).toEqual({
      poll: { name: "MoM?", values: ["A", "B"], selectableCount: 0 },
    });
    expect(pollContent("MoM?", ["A", "B"], false)).toEqual({
      poll: { name: "MoM?", values: ["A", "B"], selectableCount: 1 },
    });
  });

  it("reaches the wire as a poll with a message secret, which vote decryption will need", async () => {
    const single = await generateWAMessageContent(
      pollContent("Man of the match?", ["Sam", "Alex", "Jo"], false),
      genOptions() as never,
    );
    // Baileys sends a single-choice poll as V3.
    expect(single.pollCreationMessageV3?.name).toBe("Man of the match?");
    expect(single.pollCreationMessageV3?.selectableOptionsCount).toBe(1);
    expect(single.pollCreationMessageV3?.options?.map((o) => o.optionName)).toEqual([
      "Sam",
      "Alex",
      "Jo",
    ]);
    expect(single.messageContextInfo?.messageSecret?.length).toBe(32);

    const multi = await generateWAMessageContent(
      pollContent("Which days?", ["Tue", "Thu"], true),
      genOptions() as never,
    );
    expect(multi.pollCreationMessage?.selectableOptionsCount).toBe(0);
  });
});

describe("reactionContent", () => {
  const target = {
    remoteJid: "120363000@g.us",
    fromMe: false,
    id: "3EB0ABC",
    participant: "447700900123@s.whatsapp.net",
  };

  it("carries the emoji and the WHOLE target key", () => {
    expect(reactionContent(target, "👍")).toEqual({ react: { text: "👍", key: target } });
  });

  it("reaches the wire as a reactionMessage keyed on the target, participant included", async () => {
    // In a group the participant is what tells WhatsApp WHOSE message
    // 3EB0ABC is. A reaction without it names no message at all.
    const m = await generateWAMessageContent(reactionContent(target, "👍"), genOptions() as never);
    expect(m.reactionMessage?.text).toBe("👍");
    expect(m.reactionMessage?.key).toEqual(proto.MessageKey.fromObject(target));
    expect(m.reactionMessage?.key?.participant).toBe("447700900123@s.whatsapp.net");
  });
});

describe("a quoted reply, through Baileys' own generator", () => {
  it("records the quoted message's id and sender in contextInfo", async () => {
    const inbound = {
      key: {
        remoteJid: "120363000@g.us",
        fromMe: false,
        id: "3EB0IN",
        participant: "447700900123@s.whatsapp.net",
      },
      message: proto.Message.fromObject({ conversation: "can I bring a mate?" }),
      messageTimestamp: 1758100000,
    } as unknown as WAMessage;
    const out = await generateWAMessage("120363000@g.us", textContent("Yes, he's on the bench"), {
      ...genOptions(),
      userJid: "447700900001@s.whatsapp.net",
      quoted: inbound,
    } as never);
    const ctx = out.message?.extendedTextMessage?.contextInfo;
    expect(ctx?.stanzaId).toBe("3EB0IN");
    expect(ctx?.participant).toBe("447700900123@s.whatsapp.net");
    expect(ctx?.quotedMessage?.conversation).toBe("can I bring a mate?");
  });
});

describe("completeOwnKey: the participant Baileys leaves off our own group posts", () => {
  // whatsapp-web.js 1.34.7 puts OUR JID in `participant` on every group
  // message it sends (Injected/Utils.js sendMessage), and Baileys puts the
  // participant the reactor's phone sent onto an inbound reaction's target
  // key (process-message.js normaliseKey). Baileys' own sent key has no
  // participant (Utils/messages.js: "TODO: Add support for LIDs"). Stored
  // as-is, a bench offer sent after cutover would be `true_G_ID` while a
  // reaction to it arrives as `true_G_ID_<us>`, and the exact-match join
  // in reaction/route.ts would never fire.
  const sentGroupKey = { remoteJid: "120363000@g.us", fromMe: true, id: "3EB0OUT" };

  it("adds our bare JID as participant on a group message we sent", () => {
    expect(completeOwnKey(sentGroupKey, "447700900001:12@s.whatsapp.net")).toEqual({
      ...sentGroupKey,
      participant: "447700900001@s.whatsapp.net",
    });
  });

  it("uses the LID when that is the form we are told the group uses", () => {
    expect(completeOwnKey(sentGroupKey, "158055467598020:3@lid")).toEqual({
      ...sentGroupKey,
      participant: "158055467598020@lid",
    });
  });

  it("leaves a DM alone: whatsapp-web.js never gave a DM a participant", () => {
    const dm = { remoteJid: "447700900123@s.whatsapp.net", fromMe: true, id: "3EB0OUT" };
    expect(completeOwnKey(dm, "447700900001@s.whatsapp.net")).toEqual(dm);
  });

  it("leaves someone else's message, and a key that already has a participant, alone", () => {
    const theirs = { ...sentGroupKey, fromMe: false };
    expect(completeOwnKey(theirs, "447700900001@s.whatsapp.net")).toEqual(theirs);
    const already = { ...sentGroupKey, participant: "99@lid" };
    expect(completeOwnKey(already, "447700900001@s.whatsapp.net")).toEqual(already);
  });

  it("leaves the key alone, rather than guessing, when we do not know who we are", () => {
    expect(completeOwnKey(sentGroupKey, undefined)).toEqual(sentGroupKey);
    expect(completeOwnKey(sentGroupKey, "")).toEqual(sentGroupKey);
  });
});
