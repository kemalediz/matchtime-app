/**
 * WHICH MESSAGE A WHATSAPP REPLY QUOTES (cross-club ask, slice S0,
 * 2026-10-16). Plan: MDs/cross-club-player-ask-plan-2026-10-16.md, 3.6.
 *
 * A structured fact WhatsApp gives us, never a reading of words: the Pi
 * forwards the quoted message's id (`quotedMessageId`, its bare stanza id,
 * "3EB0...") beside PR #285's `quotedBody` and `quotedFromMatchTime`.
 * MatchTime's own posts are acknowledged with the SERIALISED key
 * (`serializeKey` on the Pi: "true_<group>_<id>" or
 * "<fromMe>_<group>_<id>_<participant>"), so the two are compared on the
 * stanza id. Group and user JIDs carry no underscore, so the split is exact.
 *
 * Pure.
 */

/** A reply's quote, as the engine reads it. */
export interface QuotedRef {
  /** The quoted message's bare WhatsApp id. */
  id: string;
  /** The Pi saw it was MatchTime's own message. */
  fromMatchTime: boolean;
}

/** The stanza id inside a serialised WhatsApp key, or the id itself. */
export function bareWhatsAppId(id: string | null | undefined): string | null {
  if (typeof id !== "string" || id.trim() === "") return null;
  const m = /^(?:true|false)_[^_]+_([^_]+)(?:_.+)?$/.exec(id.trim());
  return m ? m[1] : id.trim();
}

/** Do a reply's quoted id and a post's acknowledged id name one message? */
export function sameWhatsAppMessage(quotedId: string | null | undefined, postId: string | null | undefined): boolean {
  const a = bareWhatsAppId(quotedId);
  const b = bareWhatsAppId(postId);
  return a !== null && a === b;
}

/** The quote the analyze route carries on to the engine, or null. */
export function quotedRefOf(m: { quotedMessageId?: unknown; quotedFromMatchTime?: unknown }): QuotedRef | null {
  if (typeof m.quotedMessageId !== "string" || m.quotedMessageId.trim() === "") return null;
  return { id: m.quotedMessageId.trim(), fromMatchTime: m.quotedFromMatchTime === true };
}
