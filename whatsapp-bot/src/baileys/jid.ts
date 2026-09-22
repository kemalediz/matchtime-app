/**
 * JID handling for the Baileys driver. Pure, no Baileys import.
 *
 * ── Why this module exists ──────────────────────────────────────────
 * whatsapp-web.js and Baileys disagree about how to write down a person,
 * in three separate ways, and each disagreement is a silent failure:
 *
 *   a person   `447700900123@c.us`   vs  `447700900123@s.whatsapp.net`
 *   a group    `1234@g.us`           vs  `1234@g.us`               (same)
 *   ourselves  `client.info.wid`     vs  `sock.user.id`, which carries a
 *                                        DEVICE SUFFIX: `4477...:12@s.w...`
 *
 * That last one is the classic Baileys first-week bug: every self-check
 * silently returns false, so the bot never notices it was @-mentioned and
 * never notices it was the one added to a group. `bareUser` exists for it.
 *
 * ── Why it is hand-written rather than importing jidDecode ──────────
 * Keeping this file Baileys-free is what lets every consumer be unit-tested
 * without the library, and it keeps the parse rules visible rather than
 * buried in a dependency. The risk of drifting from the real decoder is
 * paid off in `jid.test.ts`, which asserts agreement with Baileys' own
 * `jidDecode` over a table of sample JIDs, including device suffixes,
 * agent suffixes and `hosted.lid`.
 *
 * ── The rule that matters most ──────────────────────────────────────
 * A `@lid` is NOT a phone number and its digits must never be treated as
 * one. `158055467598020@lid` looks like a number and is not. Pasting it in
 * as a phone would match another member's record. `phoneFromJid` refuses,
 * and `resolveInboundSender` returns a null phone rather than guessing.
 */

export interface ParsedJid {
  user: string;
  server: string;
  device?: number;
}

/** Servers that carry a real phone number in the user part. */
export const PHONE_SERVERS: ReadonlySet<string> = new Set(["s.whatsapp.net", "c.us", "hosted"]);

/** Servers that carry an opaque privacy identity. `hosted.lid` is real. */
export const LID_SERVERS: ReadonlySet<string> = new Set(["lid", "hosted.lid"]);

export const GROUP_SERVER = "g.us";

/**
 * Split a JID into user, server and device.
 *
 * Mirrors Baileys' `jidDecode`: everything after the first `@` is the
 * server, the part before it is `user[_agent][:device]`.
 */
export function parseJid(jid: string | null | undefined): ParsedJid | null {
  if (typeof jid !== "string") return null;
  const at = jid.indexOf("@");
  if (at < 0) return null;
  const server = jid.slice(at + 1);
  const left = jid.slice(0, at);
  const [userAgent, device] = left.split(":");
  const user = userAgent.split("_")[0];
  return { user, server, device: device ? Number(device) : undefined };
}

export function isPhoneJid(jid: string | null | undefined): boolean {
  const p = parseJid(jid);
  return !!p && PHONE_SERVERS.has(p.server);
}

export function isLidJid(jid: string | null | undefined): boolean {
  const p = parseJid(jid);
  return !!p && LID_SERVERS.has(p.server);
}

export function isGroupJid(jid: string | null | undefined): boolean {
  const p = parseJid(jid);
  return !!p && p.server === GROUP_SERVER;
}

/**
 * The JID with its device suffix removed, so two spellings of the same
 * identity compare equal. `sock.user.id` always carries one.
 */
export function bareUser(jid: string | null | undefined): string | null {
  const p = parseJid(jid);
  return p ? `${p.user}@${p.server}` : null;
}

/** The bare user part of a LID. NOT what `getPNForLID` takes; see `lidLookupJid`. */
export function bareLid(jid: string | null | undefined): string | null {
  return isLidJid(jid) ? (parseJid(jid) as ParsedJid).user : null;
}

/**
 * A LID as Baileys' `getPNForLID` wants it: the full JID, device stripped.
 *
 * Phase 1 passed the bare user part, and `lid-mapping.js` opens its lookup
 * with `if (!isLidUser(lid)) continue`, where `isLidUser` is
 * `jid.endsWith("@lid")`. So the local store answered null for every LID
 * it was ever asked about, and path 3 of §2.7 was silently dead.
 * `jid.test.ts` now proves the form against Baileys' real store.
 */
export function lidLookupJid(jid: string | null | undefined): string | null {
  return isLidJid(jid) ? bareUser(jid) : null;
}

/**
 * The E.164 digits behind a phone JID, or null.
 *
 * Refuses a LID (its digits are not a phone), refuses a group, and refuses
 * `0@s.whatsapp.net`, which is WhatsApp's own PSA account rather than a
 * person.
 */
export function phoneFromJid(jid: string | null | undefined): string | null {
  const p = parseJid(jid);
  if (!p || !PHONE_SERVERS.has(p.server)) return null;
  return /^\d{6,15}$/.test(p.user) ? p.user : null;
}

/** `447700900123` to the Baileys form. Tolerates a `+` and spacing. */
export function toUserJid(phone: string): string {
  return `${String(phone).replace(/\D/g, "")}@s.whatsapp.net`;
}

/**
 * `447700900123` to the whatsapp-web.js form.
 *
 * Still needed: every `waMessageId` already in the database was serialised
 * with `@c.us` in it, and the reaction join depends on those strings
 * staying byte-identical across the cutover. See the migration plan, §2.5.
 */
export function toLegacyUserJid(phone: string): string {
  return `${String(phone).replace(/\D/g, "")}@c.us`;
}

// ─── Inbound filtering ──────────────────────────────────────────────

export interface InboundKeyLike {
  remoteJid?: string | null;
  participant?: string | null;
  remoteJidAlt?: string | null;
  participantAlt?: string | null;
  fromMe?: boolean | null;
  id?: string | null;
}

/**
 * Why this message is not interesting, or null if it is.
 *
 * An ALLOW-list, not a deny-list: anything that is not a group or a direct
 * chat with a person is dropped before anything else happens. WhatsApp
 * keeps adding servers (`@newsletter`, `@bot` for Meta AI, `@call`), and a
 * deny-list would silently start feeding them into the analyser.
 *
 * Unlike HomeTenant's version, groups are KEPT: MatchTime lives in them.
 */
export function inboundDropReason(
  key: InboundKeyLike,
  options: { keepOwn?: boolean } = {},
): string | null {
  const jid = key.remoteJid;
  if (!jid) return "no remoteJid";
  // The observer drops our own messages. The driver keeps them: the
  // `onMessage` contract is "including our own", and `index.ts` does the
  // fromMe skip itself, after its `[msg]` log line.
  if (key.fromMe && !options.keepOwn) return "own message";
  if (jid === "status@broadcast") return "status update";
  if (jid.endsWith("@broadcast")) return "broadcast list";
  if (jid.endsWith("@newsletter")) return "newsletter";
  if (!isGroupJid(jid) && !isPhoneJid(jid) && !isLidJid(jid)) {
    return `not a chat with a person or a group (${parseJid(jid)?.server ?? jid})`;
  }
  if (!key.id) return "no message id";
  return null;
}

export type SenderResolution =
  | { phone: string; source: "jid" | "alt" | "lid-mapping" }
  | { phone: null; lid?: string; reason: string };

/**
 * The sender's phone number, or an honest null.
 *
 * Order, cheapest and most trustworthy first:
 *
 *   1. a phone JID on `participant` (group) or `remoteJid` (DM);
 *   2. a phone JID on `participantAlt` / `remoteJidAlt`. The server puts
 *      the other addressing form on the stanza itself, so this works for a
 *      sender we have never seen before and needs no local state;
 *   3. the local LID mapping store, asked with the FULL LID JID
 *      (`lidLookupJid`). NOTE this has no network fallback in
 *      Baileys (`lib/Signal/lid-mapping.js`): it is a cache read and it
 *      returns null in about a millisecond for an unknown LID. It is not a
 *      lookup and must never be mistaken for one.
 *
 * There is deliberately no step 4 in this module. A group's participant
 * list carries `phoneNumber` for LID-addressed members and is a genuine
 * resolution path, but it needs group metadata, which is Phase 4. When it
 * arrives it goes in the CALLER, so this stays pure.
 *
 * Never guesses. A LID's digits are not a phone number and a guess can
 * match somebody else's record.
 */
export async function resolveInboundSender(
  key: InboundKeyLike,
  getPNForLID: (lid: string) => Promise<string | null>,
): Promise<SenderResolution> {
  const sender = key.participant || key.remoteJid || undefined;
  const direct = phoneFromJid(sender);
  if (direct) return { phone: direct, source: "jid" };

  const alt = key.participantAlt || key.remoteJidAlt || undefined;
  const fromAlt = phoneFromJid(alt);
  if (fromAlt) return { phone: fromAlt, source: "alt" };

  const lid = bareLid(sender) ?? bareLid(alt);
  const lookup = lidLookupJid(sender) ?? lidLookupJid(alt);
  if (!lid || !lookup) {
    return { phone: null, reason: `sender ${sender ?? "?"} is neither a phone JID nor a LID` };
  }

  try {
    const mapped = phoneFromJid(await getPNForLID(lookup));
    if (mapped) return { phone: mapped, source: "lid-mapping" };
  } catch (err) {
    return {
      phone: null,
      lid,
      reason: `LID mapping lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    phone: null,
    lid,
    reason: "no phone number on the envelope and no stored mapping for this LID",
  };
}
