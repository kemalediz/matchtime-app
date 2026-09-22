/**
 * A Baileys message key, as the whatsapp-web.js id string, and back.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 * Every `waMessageId` in the production database is a whatsapp-web.js
 * string (`message-id.ts` documents the format):
 *
 *     ${fromMe}_${remote}_${id}                  a DM, or our own group post
 *     ${fromMe}_${remote}_${id}_${participant}   someone's group message
 *
 * `SentNotification`, `BenchSlotOffer` and `AnalyzedMessage` all hold them,
 * and the server joins reactions to them by EXACT string match
 * (`src/app/api/whatsapp/reaction/route.ts`). Meanwhile Baileys wants the
 * whole `WAMessageKey` to send a reaction, and the server only ever hands
 * the bot the string. A Baileys key is the same four fields, so the two
 * directions below keep every stored id valid across the cutover: no
 * database migration, no server change, and reactions on pre-cutover
 * messages keep working. Plan §2.5.
 *
 * ── The two spelling rules ──────────────────────────────────────────
 *   1. A person is `@c.us` in the string and `@s.whatsapp.net` in the key.
 *      Groups (`@g.us`), LIDs (`@lid`, `@hosted.lid`) and `@hosted` are
 *      spelled the same by both libraries and pass through untouched.
 *   2. No device or agent suffix in the string. whatsapp-web.js never
 *      wrote one into a message id, and a message key names a user, not
 *      one of their devices. Baileys normalises its own keys the same way
 *      before emitting them (`process-message.js`, `jidNormalizedUser`).
 *
 * ── Exactly where it is, and is not, reversible ─────────────────────
 * On CANONICAL keys (no device or agent suffix, an id without '@') the map
 * is a bijection: `parseKey(serializeKey(k))` equals `k`, and
 * `serializeKey(parseKey(s))` equals `s` byte for byte for every string
 * `parseKey` accepts. `key.test.ts` checks both directions over 5000
 * generated cases each, ids with underscores included.
 *
 * It is NOT reversible in three named places:
 *
 *   - a device or agent suffix is dropped on the way out (rule 2), so it
 *     cannot come back. It never carried meaning in an id;
 *   - an id containing '@' is refused, because `X_AB_C@lid` could then be
 *     read two ways. WhatsApp ids are hex or alphanumeric and never carry
 *     one; an underscore in an id is fine and is tested;
 *   - the SAME PERSON as a phone JID and as a LID are two different
 *     strings, and no pure function can join them. This is the partial
 *     break §2.5 predicted, and it is a question of state (the LID-to-phone
 *     mapping), not syntax. It bites only when one side of a join saw a
 *     participant as a phone and the other as a LID; see `completeOwnKey`
 *     in `outbound.ts` for the half of it this phase can close.
 *
 * Pure and Baileys-free, like `jid.ts`, so it can be reasoned about and
 * tested without the library.
 */
import { parseJid } from "./jid.js";

/** The four fields both libraries agree a message key has. */
export interface KeyLike {
  remoteJid?: string | null;
  fromMe?: boolean | null;
  id?: string | null;
  participant?: string | null;
}

/** A key read back out of a string: always complete, participant optional. */
export interface ParsedKey {
  remoteJid: string;
  fromMe: boolean;
  id: string;
  participant?: string;
}

/** A canonical JID: `user@server`, with no device, no agent, no underscore. */
const CANONICAL_JID = /^[^@_:\s]+@[a-z]+(\.[a-z]+)*$/;

/**
 * `x@s.whatsapp.net` or `x:3@c.us` to `x@c.us`; other servers as they are,
 * minus any device suffix. Null for anything that is not a canonical JID.
 *
 * Exported because it is the spelling EVERYTHING above the seam compares
 * against: `index.ts` and `smart-analysis.ts` were written for
 * whatsapp-web.js and test `.endsWith("@c.us")`, and the bot's own ids,
 * mentions and senders must be written by the same rule the stored ids
 * are, or a comparison that worked yesterday quietly stops matching.
 */
export function legacyJid(jid: string | null | undefined): string | null {
  return toLegacyJid(jid);
}

function toLegacyJid(jid: string | null | undefined): string | null {
  const p = parseJid(jid);
  if (!p || !p.user || !p.server) return null;
  const server = p.server === "s.whatsapp.net" ? "c.us" : p.server;
  const out = `${p.user}@${server}`;
  return CANONICAL_JID.test(out) ? out : null;
}

/** `x@c.us` to `x@s.whatsapp.net`; other servers as they are. */
function toWireJid(legacy: string): string {
  return legacy.endsWith("@c.us") ? `${legacy.slice(0, -"@c.us".length)}@s.whatsapp.net` : legacy;
}

/** A JID segment as it may appear in a stored string. */
function isStoredJid(s: string): boolean {
  // `@s.whatsapp.net` is refused: whatsapp-web.js never wrote it, and
  // accepting it would make `serializeKey(parseKey(s))` differ from `s`.
  return CANONICAL_JID.test(s) && !s.endsWith("@s.whatsapp.net");
}

/**
 * The whatsapp-web.js id string for a message key, or null when the key
 * is incomplete.
 *
 * Null rather than a best effort, the same rule `message-id.ts` follows: a
 * wrong id is worse than none, because the server dedupes and joins on it.
 * `remoteJidAlt` and `participantAlt` are deliberately ignored; the id has
 * always been keyed on the primary addressing.
 */
export function serializeKey(key: KeyLike | null | undefined): string | null {
  if (!key) return null;
  const id = typeof key.id === "string" ? key.id : "";
  if (!id || id.includes("@")) return null;
  const remote = toLegacyJid(key.remoteJid);
  if (!remote) return null;
  const fromMe = key.fromMe === true ? "true" : "false";
  if (!key.participant) return `${fromMe}_${remote}_${id}`;
  const participant = toLegacyJid(key.participant);
  if (!participant) return null;
  return `${fromMe}_${remote}_${id}_${participant}`;
}

/**
 * The Baileys key for a stored whatsapp-web.js id string, or null.
 *
 * Null for anything that is not one: a `synthetic:` id (ours, never
 * WhatsApp's), an empty string, a truncated id. Never throws, whatever it
 * is handed.
 */
export function parseKey(serialized: unknown): ParsedKey | null {
  if (typeof serialized !== "string") return null;

  const firstSep = serialized.indexOf("_");
  if (firstSep < 0) return null;
  const fromMeText = serialized.slice(0, firstSep);
  if (fromMeText !== "true" && fromMeText !== "false") return null;

  // The remote runs to the first '_' after its '@'. A canonical JID has no
  // '_' of its own, so that separator is unambiguous.
  const afterFromMe = serialized.slice(firstSep + 1);
  const at = afterFromMe.indexOf("@");
  if (at < 0) return null;
  const remoteEnd = afterFromMe.indexOf("_", at);
  if (remoteEnd < 0) return null;
  const remote = afterFromMe.slice(0, remoteEnd);
  if (!isStoredJid(remote)) return null;

  // What is left is `id` or `id_participant`. A participant is a JID and
  // an id never contains '@', so the last '_'-separated segment is the
  // participant exactly when it contains '@'. That lets the id itself
  // contain underscores.
  const rest = afterFromMe.slice(remoteEnd + 1);
  if (!rest) return null;
  let id = rest;
  let participant: string | undefined;
  const lastSep = rest.lastIndexOf("_");
  if (lastSep >= 0 && rest.slice(lastSep + 1).includes("@")) {
    id = rest.slice(0, lastSep);
    participant = rest.slice(lastSep + 1);
    if (!isStoredJid(participant)) return null;
  }
  if (!id || id.includes("@")) return null;

  const key: ParsedKey = { remoteJid: toWireJid(remote), fromMe: fromMeText === "true", id };
  if (participant) key.participant = toWireJid(participant);
  return key;
}
