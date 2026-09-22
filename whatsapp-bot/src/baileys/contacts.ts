/**
 * Names and LID-to-phone pairs, harvested from what WhatsApp already sent.
 *
 * ── Why harvested, never fetched ────────────────────────────────────
 * whatsapp-web.js had `getContactById(jid)`, which asked the WhatsApp Web
 * page. Baileys has no equivalent, and the only network substitute, a
 * USync directory query, is what got every linked device on HomeTenant's
 * number unlinked on 2026-09-17 after about a hundred of them (plan §2.2).
 * So the Baileys driver answers `getContact` and `contactOf` from this
 * module and from Baileys' own LOCAL mapping store, and from nothing else.
 *
 * What feeds it (plan §2.9):
 *   - `pushName` on every inbound message, including the ones the driver
 *     does not hand up (a reaction arrives as a message too, so a reactor
 *     who never types still gets a name);
 *   - the envelope's `participantAlt` / `remoteJidAlt`, which pair a LID
 *     with its phone for a sender we have never seen before;
 *   - `contacts.upsert` / `contacts.update` during app-state sync, where
 *     `notify` is the pushname and `name` is the saved name;
 *   - `lid-mapping.update`.
 *
 * What it costs when a name is unknown: nothing breaks. Every caller above
 * the seam reads `pushname || name`, finds neither, and falls back exactly
 * as it did when a whatsapp-web.js lookup threw. `mentions.ts` already
 * forbids pasting these names into the analyzer's input, so the worst case
 * is one fewer lookup key for the server's roster match.
 *
 * ── Bounded ─────────────────────────────────────────────────────────
 * A fortnight of uptime must not grow it without limit. Both maps evict
 * their oldest entry past `max`; a re-learned entry moves to the back.
 *
 * In memory only, for now. Persisting it (plan §2.9 suggests a small JSON
 * file) would let a restart keep the names, and is worth doing once the
 * Phase 5 shadow run shows how often a name is missing.
 *
 * Pure: no Baileys import, no I/O.
 */
import { legacyJid } from "./key.js";
import { isGroupJid, isLidJid, isPhoneJid, phoneFromJid, type InboundKeyLike } from "./jid.js";

export interface HarvestedNames {
  /** The name the person set on their own profile (`notify`, `pushName`). */
  pushname?: string;
  /** The name saved in the bot phone's address book, if any. */
  name?: string;
  verifiedName?: string;
}

/** The shape of a Baileys `Contact` this module reads. */
export interface ContactLike {
  id?: string | null;
  lid?: string | null;
  phoneNumber?: string | null;
  name?: string | null;
  notify?: string | null;
  verifiedName?: string | null;
}

export interface ContactDirectory {
  learnFromMessage(key: InboundKeyLike | null | undefined, pushName: string | null | undefined): void;
  learnContact(contact: ContactLike | null | undefined): void;
  /** A LID and a phone JID for the same person, in either order. */
  learnPair(a: string | null | undefined, b: string | null | undefined): void;
  /** The phone digits behind a LID, if we have been told. Never guessed. */
  phoneForLid(lidJid: string | null | undefined): string | null;
  /** Every name known for this JID or its LID/phone counterpart. {} when none. */
  namesFor(jid: string | null | undefined): HarvestedNames;
  /** Entries in the name map. */
  size(): number;
}

export const DEFAULT_DIRECTORY_MAX = 5000;

function clean(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** Map.set that moves an existing key to the back, then evicts past max. */
function touch<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function createContactDirectory(max = DEFAULT_DIRECTORY_MAX): ContactDirectory {
  /** legacy JID -> names */
  const names = new Map<string, HarvestedNames>();
  /** legacy LID JID -> phone digits */
  const lidToPhone = new Map<string, string>();
  /** phone digits -> legacy LID JID */
  const phoneToLid = new Map<string, string>();

  function learnName(jid: string | null | undefined, fields: HarvestedNames): void {
    const key = legacyJid(jid);
    if (!key || isGroupJid(key)) return;
    const incoming: HarvestedNames = {};
    for (const f of ["pushname", "name", "verifiedName"] as const) {
      const v = clean(fields[f]);
      if (v) incoming[f] = v;
    }
    if (Object.keys(incoming).length === 0) return;
    touch(names, key, { ...names.get(key), ...incoming }, max);
  }

  function learnPair(a: string | null | undefined, b: string | null | undefined): void {
    const [lid, pn] = isLidJid(a) && isPhoneJid(b) ? [a, b] : isLidJid(b) && isPhoneJid(a) ? [b, a] : [];
    const lidKey = legacyJid(lid);
    const phone = phoneFromJid(pn);
    if (!lidKey || !phone) return;
    touch(lidToPhone, lidKey, phone, max);
    touch(phoneToLid, phone, lidKey, max);
  }

  function counterpart(key: string): string | null {
    if (isLidJid(key)) {
      const phone = lidToPhone.get(key);
      return phone ? `${phone}@c.us` : null;
    }
    const phone = phoneFromJid(key);
    return phone ? (phoneToLid.get(phone) ?? null) : null;
  }

  return {
    learnFromMessage(key, pushName) {
      if (!key) return;
      const group = isGroupJid(key.remoteJid);
      const sender = group ? key.participant : key.remoteJid;
      const alt = group ? key.participantAlt : key.remoteJidAlt;
      learnPair(sender, alt);
      // On our own messages pushName is OUR name and remoteJid is whoever
      // we sent to. Filing it would rename every DM recipient after the bot.
      if (key.fromMe) return;
      const name = clean(pushName);
      if (!name) return;
      learnName(sender, { pushname: name });
      learnName(alt, { pushname: name });
    },

    learnContact(contact) {
      if (!contact) return;
      const fields: HarvestedNames = {
        pushname: clean(contact.notify),
        name: clean(contact.name),
        verifiedName: clean(contact.verifiedName),
      };
      const ids = [contact.id, contact.lid, contact.phoneNumber];
      for (const a of ids) for (const b of ids) if (a !== b) learnPair(a, b);
      for (const id of ids) learnName(id, fields);
    },

    learnPair,

    phoneForLid(lidJid) {
      const key = legacyJid(lidJid);
      if (!key || !isLidJid(key)) return null;
      return lidToPhone.get(key) ?? null;
    },

    namesFor(jid) {
      const key = legacyJid(jid);
      if (!key) return {};
      const other = counterpart(key);
      return { ...(other ? names.get(other) : undefined), ...names.get(key) };
    },

    size() {
      return names.size;
    },
  };
}
