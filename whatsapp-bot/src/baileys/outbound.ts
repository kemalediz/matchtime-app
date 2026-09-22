/**
 * What the Baileys driver hands to `sock.sendMessage`. Pure, no Baileys
 * import: every builder returns a plain object, and `outbound.test.ts`
 * runs each one through Baileys' own `generateWAMessageContent` to prove
 * the wire shape.
 *
 * ── Link previews, off, always (plan §2.6) ──────────────────────────
 * Baileys generates a preview for the first URL in an outgoing text, and
 * generating one means the Pi FETCHES that URL before the message is sent.
 * MatchTime sends short magic links, which are credentials: a preview
 * would make us the first visitor to a player's private link, landing in
 * whatever one-time-use or analytics logic sits behind it. The optional
 * `link-preview-js` peer is not installed either, so leaving generation on
 * would also log `Cannot find package 'link-preview-js'` on every send
 * with a link.
 *
 * `null`, not `undefined`: Baileys only skips generation when the field is
 * PRESENT (`typeof urlInfo === 'undefined'` is its "please generate one",
 * `lib/Utils/messages.js`). Every text object in this file carries it, and
 * `drivers/baileys.source.test.ts` fails the build if one does not.
 *
 * ── Mentions ────────────────────────────────────────────────────────
 * whatsapp-web.js took `mentions: ["447...@c.us"]`. Baileys takes the same
 * list in its own spelling, `447...@s.whatsapp.net`, and puts it on the
 * message as `contextInfo.mentionedJid`. The text still carries the
 * visible `@447...` token; that is the caller's, as it always was.
 */
import { bareUser, isGroupJid, phoneFromJid, toUserJid } from "./jid.js";
import type { KeyLike } from "./key.js";

export interface TextContent {
  text: string;
  linkPreview: null;
}

export interface MentionTextContent extends TextContent {
  mentions: string[];
}

export interface PollContent {
  poll: { name: string; values: string[]; selectableCount: number };
}

export interface ReactionContent {
  react: { text: string; key: KeyLike };
}

/** A text message with link previews switched off. Every text goes through here. */
export function textContent(text: string): TextContent {
  return { text, linkPreview: null };
}

/**
 * Bare phones as Baileys person JIDs, dropping anything that is not one.
 *
 * A JID with no digits is a mention of nobody, and `0` is WhatsApp's own
 * PSA account, not a player. `phoneFromJid` already refuses both.
 */
export function mentionJids(phones: readonly string[]): string[] {
  const out: string[] = [];
  for (const phone of phones) {
    const jid = toUserJid(String(phone ?? ""));
    if (phoneFromJid(jid)) out.push(jid);
  }
  return out;
}

/**
 * A text that @-mentions the given phones, previews off.
 *
 * With nobody to mention it is a plain `textContent`, with no `mentions`
 * field at all: the whatsapp-web.js driver sent no options object in that
 * case, and `{ mentions: [] }` is not the same request.
 */
export function mentionContent(
  text: string,
  mentionPhones: readonly string[],
): TextContent | MentionTextContent {
  const mentions = mentionJids(mentionPhones);
  if (mentions.length === 0) return { text, linkPreview: null };
  return { text, linkPreview: null, mentions };
}

/**
 * A poll. `selectableCount` follows whatsapp-web.js exactly
 * (`Injected/Utils.js`: `allowMultipleAnswers ? 0 : 1`), where 0 means
 * "any number" and 1 is a single-choice poll. Baileys sends the single
 * choice form as `pollCreationMessageV3`, which is what a phone expects.
 */
export function pollContent(
  question: string,
  options: readonly string[],
  allowMultipleAnswers: boolean,
): PollContent {
  return {
    poll: { name: question, values: [...options], selectableCount: allowMultipleAnswers ? 0 : 1 },
  };
}

/**
 * A reaction on the message with `key`. `emoji: ""` removes one.
 *
 * The WHOLE key goes on the wire. In a group, `participant` is what tells
 * WhatsApp whose message the id belongs to; a reaction without it names no
 * message at all.
 */
export function reactionContent(key: KeyLike, emoji: string): ReactionContent {
  return { react: { text: emoji, key } };
}

/**
 * Our own group post's key, with OUR JID filled in as `participant`.
 *
 * ── Why ─────────────────────────────────────────────────────────────
 * The key Baileys returns from `sendMessage` has no participant, even in
 * a group (`lib/Utils/messages.js` puts the sender on the message info,
 * with the comment "TODO: Add support for LIDs"). But:
 *
 *   - whatsapp-web.js 1.34.7 puts our JID in `participant` on every group
 *     message it sends (`Injected/Utils.js` sendMessage), so every bench
 *     offer already in `BenchSlotOffer.waMessageId` has four parts; and
 *   - when a player reacts to one of our posts, Baileys hands us the
 *     target key with the participant the player's phone sent, which is
 *     us (`lib/Utils/process-message.js` normaliseKey).
 *
 * Stored as Baileys returns it, a bench offer sent after cutover would be
 * `true_G_ID` while the reaction to it serialises as `true_G_ID_<us>`. The
 * server joins them by exact string (`reaction/route.ts`), so every "yes"
 * to a bench offer would be ignored, silently. Filling in the participant
 * here keeps sent ids in the four-part form both sides agree on.
 *
 * `selfJid` is whichever form of our id the group uses: the phone JID in a
 * phone-addressed group, the LID in a LID-addressed one, matching what
 * whatsapp-web.js chose (`isLidAddressingMode ? lidUser : meUser`). The
 * caller decides; see the driver. Its device suffix is dropped. With no
 * `selfJid` the key is left alone rather than guessed at.
 *
 * DMs and other people's messages are never touched.
 */
export function completeOwnKey<K extends KeyLike>(key: K, selfJid: string | null | undefined): K {
  if (!key || key.fromMe !== true || key.participant) return key;
  if (!isGroupJid(key.remoteJid ?? undefined)) return key;
  const me = bareUser(selfJid);
  if (!me) return key;
  return { ...key, participant: me };
}
