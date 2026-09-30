/**
 * @-MENTION HANDLING ON THE PI — pure, unit-tested, no page calls.
 *
 * ── THE DEFECT THIS REPLACES (measured, 2026-09-08) ──────────────────
 *
 * `enrichInbound` resolved every mentioned JID with
 * `client.getContactById(jid)` and pasted `pushname || name || shortName`
 * into the body the analyzer reads:
 *
 *     const name = c.pushname || c.name || c.shortName || null;
 *     body = body.replace(new RegExp(`@${digits}\\b`, "g"), `@${name}`);
 *
 * Two real messages from the live Sutton FC group, typed vs stored:
 *
 *   "@Shahrokh🐔 Sutton Football Club is out due to unforeseen issue at work"
 *   → "@DÇ  is out due to unforeseen issue at work"            (routed noise)
 *
 *   "@David David 67 and @~Najib out"
 *   → "@割::::.̸̢̤̋̃̓̉͗̏̾̃̌̚͘̕.̵͆͂ and @Najib out"      (David's drop lost)
 *
 * ⚠️ THE CONTACT LOOKUP WAS NOT BROKEN AND DID NOT RETURN THE WRONG
 * PERSON. `"割::::.̸̢̤̋̃̓̉͗̏̾̃̌̚͘̕.̵͆͂"` appears 13 times in this
 * org's `AnalyzedMessage.authorName` column — it is David's own pushname,
 * the same string the Pi reports when David himself speaks. WhatsApp
 * renders an @-mention to each READER from the READER's address book
 * ("David David 67" is what Kemal has him saved as); the bot only ever
 * sees the mentioned person's SELF-CHOSEN profile name. When the two
 * agree the substitution looks perfect ("@Mojib Jalali", "@Najib"); when
 * they do not, the analyzer is handed a name nobody in the club uses.
 *
 * That is why it was intermittent, and why "validate harder on the Pi"
 * cannot fix it: "DÇ" is a perfectly well-formed string. It is simply not
 * who MatchTime thinks Shahrokh is. The pushname is also **controlled by
 * the mentioned person**, so pasting it into the model's input is a text
 * an outsider writes into MatchTime's reasoning.
 *
 * ── THE RULE HERE ───────────────────────────────────────────────────
 *
 * The Pi rewrites EXACTLY ONE mention: the bot's own, to the literal
 * "@Match Time". That is the one name we do not have to trust anyone for
 * — only the Pi knows its own identity (which is why `botMentioned` is
 * computed here at all), and the text is a constant we choose.
 *
 * Every other mention keeps its raw "@<digits>" token, and the contact's
 * display name travels beside it as STRUCTURED, explicitly-untrusted data
 * (`mentionNames`). The server checks it against the org roster
 * (`src/lib/pipeline/mention-names.ts`) and substitutes the name
 * MatchTime knows the member by — or leaves the raw token.
 *
 * Leaving "@<digits>" is STRICTLY BETTER than inserting a wrong name:
 * `pipeline/identity.ts` refuses raw digits as a person, so the engine's
 * "I cannot identify this person" refusal fires on an honest unknown
 * rather than on fabricated text.
 *
 * The substitution is not deleted, only moved. Its original reason still
 * holds — the LLM cannot reason about opaque numeric ids, and Kemal's
 * "@158055467598020 is replacing @447xxx" was classified as noise for
 * exactly that reason. What changed is WHERE the name comes from.
 */

/**
 * The literal text a self-mention is rewritten to.
 *
 * Must keep matching `lib/interaction-contract.ts`'s text fallback
 * (`/@?\s*match\s*time\b/i`), which is the SECOND signal for "was the bot
 * tagged?" and exists precisely to survive a regression in the structured
 * `botMentioned` flag. Previously this text came from the bot contact's
 * own pushname; a constant cannot be renamed out from under us by a
 * WhatsApp profile edit.
 */
export const BOT_MENTION_TEXT = "@Match Time";

/** A mentioned JID plus whatever the contact lookup managed to say about it. */
export interface RawMentionContact {
  /** "<digits>@lid" or "<digits>@c.us", as it appears in `mentionedIds`. */
  jid: string;
  /** `Contact.isMe`; undefined when the contact could not be fetched. */
  isMe?: boolean;
  /** `pushname || name || shortName`. UNTRUSTED and possibly not a string. */
  name?: unknown;
  /**
   * The phone behind a LID mention, when the driver has been TOLD it
   * (the harvested directory or Baileys' local mapping store, both fed by
   * group metadata and message envelopes; never a directory lookup).
   * Possibly absent or the wrong type.
   */
  phone?: unknown;
}

/**
 * What the Pi knows about one mention, forwarded for the SERVER to verify.
 *
 * `name` is the contact's display name (untrusted, a lookup key only).
 * `phone` (2026-09-30) is the phone behind a LID mention, digits only.
 * A phone JID ("447…@c.us") never carries one: the JID already is the
 * phone, and the server reads it from there. At least one of the two is
 * always present; an entry with neither is not sent.
 *
 * Why the phone travels: under Baileys every mention is a LID, and the
 * server's exact key is the phone. On 2026-09-30 "@David is IN" reached
 * the server as "@252012071493723 is IN" with nothing beside it, so the
 * engine refused a member it knows by phone.
 */
export interface MentionName {
  jid: string;
  name?: string;
  phone?: string;
}

/** Shortest run of digits that can plausibly be a WhatsApp id. */
const MIN_MENTION_DIGITS = 5;

/** The digits WhatsApp writes into the body for a mention of `jid`. */
export function mentionDigits(jid: unknown): string {
  if (typeof jid !== "string") return "";
  return jid.replace(/@.*$/s, "").replace(/\D/g, "");
}

/**
 * Fold a contact display name into something usable as a LOOKUP KEY, or
 * null when there is nothing usable in it.
 *
 * This is deliberately NOT a trust check — no filter on this side can
 * tell "DÇ" (a real pushname belonging to the wrong-looking person) from
 * "Najib". It only stops obvious junk crossing the wire and keeps the key
 * comparable to what `lib/name-normalise.ts` stores in `UserAlias`.
 *
 *   - NFC first, so "Ç" and "ı" survive as single characters. This squad
 *     is Turkish, Azerbaijani and South Asian; dropping accents here
 *     would be a missed registration.
 *   - Combining marks are then stripped: "割::::.̸̢̤̋̃…" becomes
 *     "割::::..", which is EXACTLY the key the admin-curated
 *     `UserAlias["割::::.."] → David` row is stored under.
 *   - Emoji become spaces, so "Shahrokh🐔 Sutton Football Club" folds to
 *     a name the roster matcher can read.
 *   - A leading "~" (WhatsApp's marker for an unsaved contact) is dropped.
 *   - Digits-only is refused outright: a raw phone or lid is never a name
 *     (the 2026-06-12 incident where a bare number became a player name).
 */
export function sanitiseMentionName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .normalize("NFC")
    // Control, format and unassigned characters, then any combining mark
    // NFC could not compose away.
    .replace(/[\p{C}\p{M}]/gu, "")
    // Emoji and their modifiers → a space, so the words either side stay
    // separate words.
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}⃣]/gu, " ")
    .replace(/^[~\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 2 || cleaned.length > 64) return null;
  if (!/\p{L}/u.test(cleaned)) return null;
  // "447700900123", "+44 7700 900123", "158055467598020@lid" — never names.
  if (/^[+@]?[\d\s()+-]{5,}$/.test(cleaned)) return null;
  if (/^[\d\s()+-]{5,}@?(lid|c\.us|s\.whatsapp\.net)$/i.test(cleaned)) return null;
  return cleaned;
}

/** A phone number's digits, or undefined when the value is not one. */
export function sanitiseMentionPhone(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const digits = raw.replace(/\D/g, "");
  // E.164 allows up to 15 digits; nothing real is shorter than 7.
  if (digits.length < 7 || digits.length > 15) return undefined;
  if (/[\p{L}]/u.test(raw)) return undefined;
  return digits;
}

/** A LID JID, in any of the spellings the drivers hand up. */
function isLidMention(jid: string): boolean {
  return /@lid$/i.test(jid);
}

/**
 * The LID mentions nobody could tie to a phone: the ones worth ONE
 * re-read of the group's metadata before the message is forwarded
 * (`WaDriver.refreshGroupRoster`). The bot is never listed.
 */
export function lidMentionsWithoutPhone(
  contacts: RawMentionContact[],
  botIdentities: Array<string | null | undefined>,
): string[] {
  const botIds = botIdentitySet(botIdentities);
  const out: string[] = [];
  for (const c of Array.isArray(contacts) ? contacts : []) {
    if (!c || typeof c.jid !== "string" || !isLidMention(c.jid)) continue;
    if (contactIsBot(c, botIds)) continue;
    if (mentionDigits(c.jid).length < MIN_MENTION_DIGITS) continue;
    if (sanitiseMentionPhone(c.phone)) continue;
    out.push(c.jid);
  }
  return out;
}

/** Every non-empty identity string the bot might be known by. */
export function botIdentitySet(ids: Array<string | null | undefined>): Set<string> {
  return new Set((ids ?? []).filter((s): s is string => typeof s === "string" && s.length > 0));
}

/**
 * Is this mentioned contact the BOT ITSELF?
 *
 * `Contact.isMe` is the reliable signal — it is true for the bot's own
 * contact whatever JID form the mention used. The JID comparison is the
 * belt-and-braces path for when the contact could not be fetched at all.
 *
 * ONE implementation. `rewriteMentions` uses it for BOTH the structured
 * `botMentioned` flag and the "@Match Time" body rewrite, so the flag and
 * the text can never disagree about who the bot is. (It replaced
 * `smart-analysis.ts`'s `isSelfMention`, which was the same rule written
 * a second time.)
 */
export function contactIsBot(c: { jid: string; isMe?: boolean }, botIds: Set<string>): boolean {
  if (c?.isMe === true) return true;
  return typeof c?.jid === "string" && botIds.has(c.jid);
}

/** Replace every `@<digits>` token with `replacement`, and nothing else. */
function replaceMentionToken(body: string, digits: string, replacement: string): string {
  if (!/^\d+$/.test(digits)) return body;
  // `\b` after the digits so "@111222" does not match inside "@1112229999".
  const re = new RegExp(`@${digits}\\b`, "g");
  // Function replacer: a member name containing "$&" or "$1" must not be
  // interpreted as a capture reference.
  return body.replace(re, () => replacement);
}

export interface RewriteMentionsResult {
  /** The body with ONLY the bot's own mention rewritten. */
  body: string;
  /** Display names for the other mentions, for the server to verify. */
  mentionNames: MentionName[];
  /** Was the bot itself @-mentioned? */
  botMentioned: boolean;
}

/**
 * Rewrite a self-mention to "@Match Time", collect every other mention's
 * display name for the server, and report whether the bot was tagged.
 *
 * Total: it is called on data read off a whatsapp-web.js Message on a
 * build whose injected code is known to hand back throwing getters, so
 * every field is treated as possibly absent or the wrong type.
 */
export function rewriteMentions(args: {
  body: string;
  contacts: RawMentionContact[];
  botIdentities?: Array<string | null | undefined>;
}): RewriteMentionsResult {
  let body = typeof args?.body === "string" ? args.body : "";
  const contacts = Array.isArray(args?.contacts) ? args.contacts : [];
  const botIds = botIdentitySet(args?.botIdentities ?? []);
  const mentionNames: MentionName[] = [];
  let botMentioned = false;

  for (const c of contacts) {
    if (!c || typeof c.jid !== "string") continue;
    const digits = mentionDigits(c.jid);
    if (contactIsBot(c, botIds)) {
      botMentioned = true;
      // The bot is not a player: its name never becomes a mention
      // candidate, and this is the ONLY body rewrite the Pi performs.
      if (digits.length >= MIN_MENTION_DIGITS) {
        body = replaceMentionToken(body, digits, BOT_MENTION_TEXT);
      }
      continue;
    }
    if (digits.length < MIN_MENTION_DIGITS) continue;
    const name = sanitiseMentionName(c.name);
    const phone = isLidMention(c.jid) ? sanitiseMentionPhone(c.phone) : undefined;
    if (!name && !phone) continue;
    mentionNames.push({ jid: c.jid, ...(name ? { name } : {}), ...(phone ? { phone } : {}) });
  }

  return { body, mentionNames, botMentioned };
}
