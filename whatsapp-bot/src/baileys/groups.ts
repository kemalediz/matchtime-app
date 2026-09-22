/**
 * Groups, participants and the LID-to-phone bridge. Plan §2.7, Phase 4.
 *
 * ── No precedent ────────────────────────────────────────────────────
 * HomeTenant's Baileys driver drops every `@g.us` message before anything
 * else happens, so none of this has run in anyone's production. What is
 * written here is read out of Baileys 7.0.0-rc14's own source, and the
 * facts it rests on are:
 *
 *   - `groupMetadata(jid)` asks WhatsApp for the group with
 *     `request: 'interactive'` and `extractGroupMetadata` builds each
 *     participant as `{ id, phoneNumber, lid, username, admin }`, where
 *     `phoneNumber` is set ONLY when `id` is a LID and `lid` ONLY when `id`
 *     is a phone (`lib/Socket/groups.js`). No `name`, no `notify`: names do
 *     not come from here, whatever the plan's §2.9 hoped.
 *   - the same function carries a literal `// TODO: Store LID MAPPINGS`, so
 *     Baileys never puts those pairs into its own mapping store. We do,
 *     with `storeLIDPNMappings`, on every sweep.
 *   - that store validates with `isLidUser` (`endsWith('@lid')`) and
 *     `isPnUser` (`endsWith('@s.whatsapp.net')`) and silently SKIPS
 *     anything else with a warn line. A bare user part, an `@c.us` phone,
 *     `@hosted` or `@hosted.lid` would all vanish. That is the Phase 1 bug
 *     class 3b fixed on the read side; `lidPnPairs` is the write side, and
 *     `groups.test.ts` checks it against Baileys' own predicates.
 *   - `groupFetchAllParticipating` builds its metadata with the same
 *     function but is marked `// TODO: properly parse LID / PN DATA`. It
 *     is used for the group LIST only, never as a roster.
 *
 * ── The bridge, end to end ──────────────────────────────────────────
 * MatchTime identifies players by phone; Baileys speaks LIDs. On each
 * roster read the driver (1) learns every pair into its harvested
 * directory, (2) writes them into Baileys' own store, and (3) hands
 * `index.ts` PHONE-form ids (`447...@c.us`) for everyone WhatsApp gave a
 * phone, so the sweep posts phones exactly as it did under
 * whatsapp-web.js. After that every later lookup (a message's sender, a
 * reactor, a voter, `getContact(lid).number`) finds the phone locally.
 * A LID with no phone anywhere stays a LID. Its digits are never a phone.
 *
 * ── The cache, and how often the sweep really hits WhatsApp ─────────
 * See `GROUP_SWEEP_INTERVAL_MS` below.
 *
 * Pure: no Baileys runtime import, no I/O.
 */
import type { GroupMembershipEvent, GroupSnapshot, GroupSummary, SnapshotParticipant } from "../driver.js";
import { legacyJid } from "./key.js";
import { bareUser, isLidJid, parseJid, phoneFromJid, toUserJid } from "./jid.js";

/**
 * How long a roster read (and the group listing) is trusted before the
 * next open reads it again from WhatsApp: 15 minutes.
 *
 * Why this number. `index.ts` runs the whole startup block on EVERY open:
 * the group listing, one roster read per org, and the recovery sweep.
 * Under Baileys an open happens on every reconnect, and the reconnect
 * policy retries after 1s, 2s, 4s up to a minute, resetting after each
 * success. A line that keeps dropping for a minute at a time would re-read
 * every roster dozens of times an hour. With this window that costs at
 * most one listing and one `groupMetadata` per group per quarter hour,
 * however much the line flaps.
 *
 * Why not longer. The server's roster freshness window is ten days
 * (`GROUP_SYNC_FRESHNESS_DAYS`), so any value up to hours would satisfy
 * it. The limit is correctness: while connected the cache is kept exact by
 * `group-participants.update`, but a change made while the socket was
 * down reaches us only if WhatsApp replays that notification on
 * reconnect, which is expected and not yet measured (Phase 5, item 6).
 * Fifteen minutes bounds how long a missed leave could ride along in a
 * posted roster, which matters because the sweep can restore a member.
 *
 * The very first open of a process always reads from WhatsApp: the cache
 * is empty.
 */
export const GROUP_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** A participant as Baileys builds it, or the older bare-string shape. */
export interface ParticipantLike {
  id?: string | null;
  lid?: string | null;
  phoneNumber?: string | null;
  admin?: string | null;
  isAdmin?: boolean | null;
  isSuperAdmin?: boolean | null;
}

export interface GroupMetaLike {
  id: string;
  subject?: string | null;
  addressingMode?: string | null;
  participants: Array<ParticipantLike | string>;
  author?: string | null;
  authorPn?: string | null;
}

/** One pair for `storeLIDPNMappings`: full wire JIDs, no device. */
export interface LidPnPair {
  lid: string;
  pn: string;
}

export interface ParticipantsUpdateLike {
  id: string;
  action: string;
  author?: string | null;
  authorPn?: string | null;
  participants: Array<ParticipantLike | string>;
}

export function participantOf(p: ParticipantLike | string | null | undefined): ParticipantLike {
  if (typeof p === "string") return { id: p };
  return p && typeof p === "object" ? p : {};
}

function idsOf(p: ParticipantLike): Array<string | null | undefined> {
  return [p.id, p.lid, p.phoneNumber];
}

/** A phone on a server Baileys' store accepts: `s.whatsapp.net` or `c.us`, never `hosted`. */
function storablePhone(jid: string | null | undefined): string | null {
  const server = parseJid(jid)?.server;
  if (server !== "s.whatsapp.net" && server !== "c.us") return null;
  return phoneFromJid(jid);
}

/** A plain `@lid` (not `@hosted.lid`), device stripped. */
function storableLid(jid: string | null | undefined): string | null {
  return parseJid(jid)?.server === "lid" ? bareUser(jid) : null;
}

/** The pair this participant record carries, in the form Baileys' store accepts. */
export function lidPnPair(raw: ParticipantLike | string): LidPnPair | null {
  const p = participantOf(raw);
  const ids = idsOf(p);
  const lid = ids.map(storableLid).find((v): v is string => !!v);
  const phone = ids.map(storablePhone).find((v): v is string => !!v);
  if (!lid || !phone) return null;
  return { lid, pn: toUserJid(phone) };
}

export function lidPnPairs(participants: ReadonlyArray<ParticipantLike | string>): LidPnPair[] {
  const out = new Map<string, LidPnPair>();
  for (const p of participants ?? []) {
    const pair = lidPnPair(p);
    if (pair) out.set(pair.lid, pair);
  }
  return [...out.values()];
}

/** The phone a participant record ITSELF carries: a phone id, or `phoneNumber`. Never guessed. */
export function participantPhone(raw: ParticipantLike | string): string | null {
  const p = participantOf(raw);
  return phoneFromJid(p.id) ?? phoneFromJid(p.phoneNumber);
}

/** The participant's LID in whatsapp-web.js spelling, if it has one. */
export function participantLid(raw: ParticipantLike | string): string | null {
  const p = participantOf(raw);
  const lid = [p.id, p.lid].find((j) => isLidJid(j));
  return lid ? legacyJid(lid) : null;
}

export function isAdminParticipant(raw: ParticipantLike | string): boolean {
  const p = participantOf(raw);
  return p.admin === "admin" || p.admin === "superadmin" || !!p.isAdmin || !!p.isSuperAdmin;
}

/** Every spelling above the seam might compare this participant by. */
export function legacyIdsOf(raw: ParticipantLike | string): string[] {
  const p = participantOf(raw);
  const out = new Set<string>();
  for (const j of idsOf(p)) {
    const l = legacyJid(j);
    if (l) out.add(l);
  }
  const phone = participantPhone(p);
  if (phone) out.add(`${phone}@c.us`);
  return [...out];
}

function sameParticipant(a: ParticipantLike | string, b: ParticipantLike | string): boolean {
  const ids = new Set(legacyIdsOf(a));
  return legacyIdsOf(b).some((id) => ids.has(id));
}

/**
 * The phone for a participant: the record first, then local knowledge of
 * its LID (the harvested directory and Baileys' local store, via the
 * caller). A throwing lookup reads as "unknown".
 */
export async function resolveParticipantPhone(
  raw: ParticipantLike | string,
  phoneForLid: (lidJid: string) => Promise<string | null>,
): Promise<string | null> {
  const direct = participantPhone(raw);
  if (direct) return direct;
  const p = participantOf(raw);
  const lid = [p.id, p.lid].map((j) => (isLidJid(j) ? bareUser(j) : null)).find((v): v is string => !!v);
  if (!lid) return null;
  try {
    return phoneFromJid(toUserJid(String((await phoneForLid(lid)) ?? "")));
  } catch {
    return null;
  }
}

/** The id `index.ts` should see: the phone form when known, the LID otherwise. */
export function handedUpId(raw: ParticipantLike | string, phone: string | null): string | null {
  if (phone) return `${phone}@c.us`;
  return participantLid(raw) ?? legacyJid(participantOf(raw).id);
}

// ── The cache ─────────────────────────────────────────────────────────

interface VerifiedEntry {
  meta: GroupMetaLike;
  readAt: number;
  epoch: number;
}

export interface GroupCache {
  /** The participating listing, which is NOT a roster. */
  putListing(groups: GroupMetaLike[]): void;
  /** The group list, while fresh; null when it must be read again. */
  listing(): GroupSummary[] | null;
  /** When the fresh listing was read, or null. */
  listingAgeMs(): number | null;
  /** A roster read by `groupMetadata`. */
  putVerified(meta: GroupMetaLike, epoch: number): void;
  /** The roster, while fresh. */
  verified(jid: string): GroupMetaLike | null;
  verifiedAgeMs(jid: string): number | null;
  /** For Baileys' `cachedGroupMetadata`: read in THIS connection, and fresh. */
  forSend(jid: string, epoch: number): GroupMetaLike | undefined;
  addressingMode(jid: string): "lid" | "pn" | undefined;
  subject(jid: string): string | null;
  /** Apply `group-participants.update`. `selfIds` are our legacy ids. */
  applyParticipants(update: ParticipantsUpdateLike, selfIds: ReadonlySet<string>): void;
  /** Apply a `groups.update` partial: subject and addressing only, never its roster. */
  applyGroupUpdate(partial: Partial<GroupMetaLike> & { id?: string | null }): void;
  forget(jid: string): void;
}

function clone(meta: GroupMetaLike): GroupMetaLike {
  return {
    ...meta,
    participants: (meta.participants ?? []).map((p) => ({ ...participantOf(p) })),
  };
}

function mode(v: string | null | undefined): "lid" | "pn" | undefined {
  return v === "lid" ? "lid" : v === "pn" ? "pn" : undefined;
}

export function createGroupCache(
  opts: { ttlMs?: number; now?: () => number } = {},
): GroupCache {
  const ttl = opts.ttlMs ?? GROUP_SWEEP_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const verifiedByJid = new Map<string, VerifiedEntry>();
  const subjects = new Map<string, string>();
  const modes = new Map<string, "lid" | "pn">();
  let listed: { ids: string[]; readAt: number } | null = null;

  const fresh = (readAt: number) => now() - readAt < ttl;

  function note(meta: Partial<GroupMetaLike> & { id?: string | null }): void {
    if (!meta.id) return;
    if (typeof meta.subject === "string") subjects.set(meta.id, meta.subject);
    const m = mode(meta.addressingMode);
    if (m) modes.set(meta.id, m);
  }

  return {
    putListing(groups) {
      for (const g of groups) note(g);
      listed = { ids: groups.map((g) => g.id), readAt: now() };
    },

    listing() {
      if (!listed || !fresh(listed.readAt)) return null;
      return listed.ids.map((id) => ({ id, name: subjects.get(id) ?? "" }));
    },

    listingAgeMs() {
      return listed && fresh(listed.readAt) ? now() - listed.readAt : null;
    },

    putVerified(meta, epoch) {
      note(meta);
      verifiedByJid.set(meta.id, { meta: clone(meta), readAt: now(), epoch });
    },

    verified(jid) {
      const e = verifiedByJid.get(jid);
      return e && fresh(e.readAt) ? clone(e.meta) : null;
    },

    verifiedAgeMs(jid) {
      const e = verifiedByJid.get(jid);
      return e && fresh(e.readAt) ? now() - e.readAt : null;
    },

    forSend(jid, epoch) {
      const e = verifiedByJid.get(jid);
      return e && e.epoch === epoch && fresh(e.readAt) ? clone(e.meta) : undefined;
    },

    addressingMode(jid) {
      return modes.get(jid);
    },

    subject(jid) {
      return subjects.get(jid) ?? null;
    },

    applyParticipants(update, selfIds) {
      const jid = update?.id;
      if (!jid) return;
      const people = (update.participants ?? []).map(participantOf);
      const involvesSelf = people.some((p) => legacyIdsOf(p).some((id) => selfIds.has(id)));
      if (involvesSelf && (update.action === "add" || update.action === "remove")) {
        // Our own membership changed: the group list is wrong now.
        listed = null;
        if (update.action === "remove") {
          verifiedByJid.delete(jid);
          return;
        }
      }
      const e = verifiedByJid.get(jid);
      if (!e) return;
      const roster = e.meta.participants.map(participantOf);
      switch (update.action) {
        case "add":
          for (const p of people) if (!roster.some((r) => sameParticipant(r, p))) roster.push({ ...p });
          break;
        case "remove":
          e.meta.participants = roster.filter((r) => !people.some((p) => sameParticipant(r, p)));
          return;
        case "promote":
        case "demote":
          for (const r of roster) {
            if (people.some((p) => sameParticipant(r, p))) r.admin = update.action === "promote" ? "admin" : null;
          }
          break;
        default:
          // `modify` is a number change, and rc14 hands its parameters over
          // in a shape it cannot even parse itself. Drop the roster rather
          // than keep a wrong one; the next sweep reads it afresh.
          verifiedByJid.delete(jid);
          return;
      }
      e.meta.participants = roster;
    },

    applyGroupUpdate(partial) {
      if (!partial?.id) return;
      note(partial);
      const e = verifiedByJid.get(partial.id);
      if (!e) return;
      if (typeof partial.subject === "string") e.meta.subject = partial.subject;
      const m = mode(partial.addressingMode);
      if (m) e.meta.addressingMode = m;
    },

    forget(jid) {
      verifiedByJid.delete(jid);
    },
  };
}

// ── Join and leave ────────────────────────────────────────────────────

/**
 * `group-participants.update` as the bot's `group_join` / `group_leave`.
 *
 * Recipients go up in PHONE form whenever a phone is known, because
 * `index.ts`'s `extractPhones` keeps only `@c.us` ids: a LID it cannot read
 * is dropped there, as a whatsapp-web.js `@lid` recipient always was. The
 * author likewise, because `bot-added.ts` takes `addedByPhone` from an
 * `@c.us` author. `promote`, `demote` and `modify` are not membership
 * changes and return null.
 */
export async function membershipEvent(
  update: ParticipantsUpdateLike,
  deps: { phoneForLid(lidJid: string): Promise<string | null> },
): Promise<{ kind: "join" | "leave"; event: GroupMembershipEvent } | null> {
  const kind = update?.action === "add" ? "join" : update?.action === "remove" ? "leave" : null;
  if (!kind || !update.id) return null;
  const recipientIds: string[] = [];
  for (const p of update.participants ?? []) {
    const id = handedUpId(p, await resolveParticipantPhone(p, deps.phoneForLid));
    if (id) recipientIds.push(id);
  }
  const event: GroupMembershipEvent = { chatId: update.id, recipientIds };
  const author = await authorId(update.author, update.authorPn, deps.phoneForLid);
  if (author) event.author = author;
  return { kind, event };
}

export async function authorId(
  author: string | null | undefined,
  authorPn: string | null | undefined,
  phoneForLid: (lidJid: string) => Promise<string | null>,
): Promise<string | undefined> {
  if (!author && !authorPn) return undefined;
  const phone = await resolveParticipantPhone({ id: author ?? undefined, phoneNumber: authorPn ?? undefined }, phoneForLid);
  if (phone) return `${phone}@c.us`;
  return legacyJid(author) ?? undefined;
}

// ── The self-setup snapshot ──────────────────────────────────────────

export async function snapshotFromMetadata(
  meta: GroupMetaLike,
  selfIds: readonly string[],
  deps: {
    phoneForLid(lidJid: string): Promise<string | null>;
    /** A harvested name for any of these legacy ids. */
    pushnameFor(ids: string[]): string | undefined;
  },
): Promise<GroupSnapshot> {
  const self = new Set(selfIds.map((s) => legacyJid(s) ?? s));
  const participants: SnapshotParticipant[] = [];
  let lidOnly = 0;
  for (const raw of meta.participants ?? []) {
    const ids = legacyIdsOf(raw);
    if (ids.some((id) => self.has(id))) continue;
    const phone = await resolveParticipantPhone(raw, deps.phoneForLid);
    const entry: SnapshotParticipant = {};
    if (phone) {
      entry.phone = phone;
    } else {
      const lid = participantLid(raw);
      if (!lid) continue;
      entry.lidId = lid;
      lidOnly++;
    }
    const known = phone ? [`${phone}@c.us`, ...ids] : ids;
    const pushname = deps.pushnameFor(known);
    if (pushname) entry.pushname = pushname;
    entry.isAdmin = isAdminParticipant(raw);
    participants.push(entry);
  }
  const notes: string[] = [];
  if (lidOnly > 0) notes.push(`${lidOnly} participant(s) had only a LID and no phone WhatsApp would give`);
  return { subject: meta.subject ?? null, participants, source: "groupMetadata", notes };
}
