/**
 * EDIT OR DELETE A GROUP MESSAGE, AND MATCHTIME FORGETS THE ORIGINAL WORDS
 * (2026-11-15, round 3 after two rounds of review).
 *
 * Until PR #606 the Pi dropped WhatsApp's delete and edit notices
 * (`protocolMessage`) as unreadable, so the words a member had taken back
 * stayed in every store below for up to a week, and any tagged question
 * could have them quoted back. The Pi now posts each one to
 * `/api/whatsapp/message-change` (and retries until it lands); this is what
 * that does. Housekeeping only: nothing here analyses, replies, reacts or
 * sends.
 *
 * AN EDIT IS A PURGE (decision after round 2): when the AUTHOR edits a
 * message, MatchTime forgets the original words exactly as it does for a
 * delete, through the same code, and it does NOT store the new ones. So
 * every order and race a delete survives, an edit survives too, and no
 * edited text is ever written to the server or to the Pi's disk.
 *
 * THE TOMBSTONE (`DeletedMessage`, reason "deleted" or "edited"). It is
 * RECORDED before anything is cleared, and the record is what makes the
 * change win in any order:
 *
 *   - every writer of a member's words writes, THEN calls `enforceDeletes`,
 *     which clears again whatever a tombstone applies to. The tombstone is
 *     committed before the clear starts, so either the clear sees the
 *     writer's row, or the writer's check sees the tombstone. Never neither;
 *   - an hourly sweep (`sweepRecentTombstones`, on /api/cron/bot-health)
 *     enforces every tombstone of the last 14 days, for a request that died
 *     before its own clear (a function time limit);
 *   - the analyze and admin-group doors leave such a message out before
 *     reading anything (`deletedAmong`), and give a reply that quotes one no
 *     quote text, never the Pi's copy (`withoutDeletedQuotes`).
 *
 * WHO: a delete applies to a copy when it came from a group admin (the Pi
 * reads it from the group's metadata, `byAdmin`) or from the copy's own
 * author; an edit only from its author (`byAdmin` is never true for one).
 * Anything else is recorded (it can be checked again when the message
 * turns up) and applies to nothing.
 *
 * THE DOOR AND AN EDIT (round 4): an author's edit to a message the Pi has
 * NOT sent for analysis yet replaces it in the Pi's waiting batch (the
 * original words never leave the Pi), and the Pi posts nothing for it. An
 * edit to a message already sent is posted here and purges it. So the
 * analyze door leaves out only a DELETED message; a batch carrying an
 * edited one carries what the Pi holds now, and clear-after-write still
 * purges any copy stored under an edited tombstone.
 *
 * THE STORES OF A MEMBER'S WORDS, and what an applying change does (one
 * transaction per message, so a retry finds it whole or untouched):
 *
 *   AnalyzedMessage   body, reasoning, pipelineTrace set to null; the ROW
 *       stays as the analyze route's dedupe key. The players' group's week
 *       (open answer, unified answer, rating adjuster), the extractors'
 *       recent chat and the open "who do you mean?" clarification leave a
 *       null body out; the refused-ask retry reads the (null) trace.
 *   GroupMessage      body "" (the row is the archive's dedupe key); the
 *       squad-from-list reader leaves an empty body out.
 *   AdminGroupMessage HQ's log (`<id>`) and the players' group's organiser
 *       lines (`group:<id>`): DELETED, trace and hqOutcome with them.
 *   MessageMentions   deleted, each row by its own id's author.
 *   AdminSquadProposal / AdminFeeProposal  an HQ proposal made from the
 *       message: an open one cancelled (outcome "source-deleted", so a later
 *       YES applies nothing); its copied names, month seed and fee text
 *       cleared.
 *   BotJob            an unsent reminder DM the message asked for
 *       (`aboutKey` "asked-reminder:<id>"): cancelled.
 *
 * MATCHED BY WHATSAPP ID AND GROUP, NEVER BY TEXT (`isStoredIdOf`). Every
 * lookup is narrowed by an index: the group (AnalyzedMessage.groupId,
 * GroupMessage.waChatId), the club(s) the group belongs to (HQ's log and
 * the mentions), and the 14 days before the change.
 *
 * DMs are not posted (no member's DM text is stored for a later answer).
 * Logs carry ids and counts, never the words.
 */
import { db } from "./db";
import { Prisma } from "@/generated/prisma/client";

export const DELETED_MESSAGE_RETENTION_DAYS = 14;
const WINDOW_MS = DELETED_MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** The most tombstones one sweep enforces (newest first). */
const SWEEP_MAX = 500;

/** A group JID: digits (and an old-style "-"), or a sandbox spelling; never "_" or a second "@". */
const GROUP_JID = /^[0-9A-Za-z-]{3,64}@g\.us$/;
/** A WhatsApp message id: letters, digits and a little punctuation, never '@' or a space. */
const MESSAGE_ID = /^[0-9A-Za-z._:-]{4,128}$/;
/** A canonical legacy JID, as the participant part of a stored id is spelled. */
const LEGACY_JID = /^[^@_:\s]+@[a-z]+(?:\.[a-z]+)*$/;

export interface MessageChangeInput {
  kind: "revoke" | "edit";
  chatId: string;
  messageId: string;
  /** A group admin sent it. Never true for an edit: only the author may edit. */
  byAdmin: boolean;
  senderJids: string[];
  senderPhone: string | null;
}

export interface MessageChangeResult {
  /** AnalyzedMessage rows cleared. */
  analyzed: number;
  /** GroupMessage (squad archive) rows cleared. */
  archived: number;
  /** AdminGroupMessage rows deleted. */
  hq: number;
  /** MessageMentions rows deleted. */
  mentions: number;
  /** Copies left alone: the change came from somebody who may not make it. */
  refused: number;
}

/** What a tombstone says about who changed the message, and how. */
export interface Tombstone {
  byAdmin: boolean;
  senderJids: string[];
  senderPhones: string[];
  /** "deleted" once any delete was seen, else "edited". */
  reason?: string;
}

const digits = (v: unknown): string => (typeof v === "string" ? v.replace(/\D/g, "") : "");
const empty = (): MessageChangeResult => ({ analyzed: 0, archived: 0, hq: 0, mentions: 0, refused: 0 });

/** PURE. The Pi's body, or null when it is not a group message change. An edit's words, if any are sent, are dropped here. */
export function parseMessageChangeInput(body: unknown): MessageChangeInput | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const chatId = typeof b.chatId === "string" ? b.chatId.trim() : "";
  const messageId = typeof b.messageId === "string" ? b.messageId.trim() : "";
  if (!GROUP_JID.test(chatId) || !MESSAGE_ID.test(messageId)) return null;
  if (b.kind !== "revoke" && b.kind !== "edit") return null;
  const senderJids = Array.isArray(b.senderJids)
    ? b.senderJids.filter((j): j is string => typeof j === "string" && LEGACY_JID.test(j)).slice(0, 8)
    : [];
  return {
    kind: b.kind,
    chatId,
    messageId,
    byAdmin: b.kind === "revoke" && b.byAdmin === true,
    senderJids,
    senderPhone: digits(b.senderPhone) || null,
  };
}

/** PURE. The stored ids that can be this message: exact, and the participant prefixes. */
export function storedIdForms(chatId: string, messageId: string, prefix = ""): { exact: string[]; prefixes: string[] } {
  const bases = ["false", "true"].map((fromMe) => `${prefix}${fromMe}_${chatId}_${messageId}`);
  return { exact: bases, prefixes: bases.map((b) => `${b}_`) };
}

/** PURE. The participant of a stored id of this message: a JID, null (none), or undefined (not this message). */
function participantPart(storedId: string, chatId: string, messageId: string, prefix = ""): string | null | undefined {
  if (storedId === messageId) return null;
  if (!storedId.startsWith(prefix)) return undefined;
  const s = storedId.slice(prefix.length);
  for (const fromMe of ["false", "true"]) {
    const base = `${fromMe}_${chatId}_${messageId}`;
    if (s === base) return null;
    if (s.startsWith(`${base}_`)) {
      const rest = s.slice(base.length + 1);
      return LEGACY_JID.test(rest) ? rest : undefined;
    }
  }
  return undefined;
}

/**
 * PURE. Is `storedId` this group's message `messageId`? `bare`: the row is
 * already known to be this group's (a group column matched), so the bare
 * id itself counts too.
 */
export function isStoredIdOf(storedId: string, chatId: string, messageId: string, opts: { prefix?: string; bare?: boolean } = {}): boolean {
  if (storedId === messageId) return opts.bare === true;
  return participantPart(storedId, chatId, messageId, opts.prefix ?? "") !== undefined;
}

/** PURE. The bare WhatsApp id inside a stored id (serialised, `group:`-prefixed, or bare). */
export function bareIdOf(storedId: string): string | null {
  if (storedId.startsWith("synthetic:")) return null;
  const s = storedId.startsWith("group:") ? storedId.slice("group:".length) : storedId;
  const m = /^(?:true|false)_[^_@]+@[a-z.]+_(.+)$/.exec(s);
  if (!m) return MESSAGE_ID.test(s) ? s : null;
  const rest = m[1];
  const last = rest.lastIndexOf("_");
  const id = last >= 0 && LEGACY_JID.test(rest.slice(last + 1)) ? rest.slice(0, last) : rest;
  return MESSAGE_ID.test(id) ? id : null;
}

/**
 * PURE. Is somebody the stored message's author? The participant in the
 * stored id is one of their JIDs (phone or LID spelling), or the stored
 * phone (or the participant's phone) is one of theirs. Nothing to compare
 * is "no".
 */
export function isAuthorOf(
  stored: { storedId: string; chatId: string; messageId: string; prefix?: string; storedPhone?: string | null },
  who: { jids: string[]; phones: string[] },
): boolean {
  const participant = participantPart(stored.storedId, stored.chatId, stored.messageId, stored.prefix ?? "");
  if (participant && who.jids.includes(participant)) return true;
  const phones = new Set(who.phones.map(digits).filter(Boolean));
  if (phones.size === 0) return false;
  if (participant?.endsWith("@c.us") && phones.has(digits(participant.split("@")[0]))) return true;
  const own = digits(stored.storedPhone);
  return !!own && phones.has(own);
}

/** PURE. Does a recorded change take this stored copy's words out? An admin's delete always; anything else only the author's. */
export function deleteApplies(
  t: Tombstone,
  stored: { storedId: string; chatId: string; messageId: string; prefix?: string; storedPhone?: string | null },
): boolean {
  return t.byAdmin || isAuthorOf(stored, { jids: t.senderJids, phones: t.senderPhones });
}

// ── The stores ─────────────────────────────────────────────────────────

/** The models a transaction here touches (the extended client's own delegates). */
type Tx = Pick<
  typeof db,
  "analyzedMessage" | "groupMessage" | "adminGroupMessage" | "messageMentions" | "deletedMessage" | "organisation" | "adminSquadProposal" | "adminFeeProposal" | "botJob"
>;

/** The prefix of a reminder DM's `BotJob.aboutKey`: the message that asked for it (`owner-deps.ts`). */
export const REMINDER_ABOUT_PREFIX = "asked-reminder:";

function idWhere(chatId: string, messageId: string, opts: { prefix?: string; bare?: boolean; field?: string } = {}) {
  const f = storedIdForms(chatId, messageId, opts.prefix ?? "");
  const field = opts.field ?? "waMessageId";
  return [
    { [field]: { in: opts.bare ? [...f.exact, messageId] : f.exact } },
    ...f.prefixes.map((p) => ({ [field]: { startsWith: p } })),
  ];
}

interface Copies {
  analyzed: Array<{ id: string; waMessageId: string; authorPhone: string | null }>;
  archived: Array<{ id: string; waMessageId: string; senderPhone: string | null }>;
  hq: Array<{ id: string; waMessageId: string; prefix: string }>;
  mentions: Array<{ id: string; waMessageId: string }>;
  squadProposals: Array<{ id: string; waMessageId: string; resolvedAt: Date | null }>;
  feeProposals: Array<{ id: string; waMessageId: string; resolvedAt: Date | null }>;
  reminders: Array<{ id: string; storedId: string }>;
}

/** The clubs a group belongs to (its players' group or its HQ). */
async function clubsOf(tx: Pick<typeof db, "organisation">, chatId: string): Promise<string[]> {
  return (await tx.organisation.findMany({ where: { OR: [{ whatsappGroupId: chatId }, { adminGroupId: chatId }] }, select: { id: true } })).map((o) => o.id);
}

/**
 * Every stored copy of one group message from the 14 days before `at`,
 * each checked exactly. Narrowed by indexes: the group, its club(s), the
 * time.
 */
async function copiesOf(tx: Tx, chatId: string, messageId: string, at: Date, orgIds: string[]): Promise<Copies> {
  const since = new Date(at.getTime() - WINDOW_MS);
  const analyzed = (
    await tx.analyzedMessage.findMany({
      where: { groupId: chatId, createdAt: { gte: since }, OR: idWhere(chatId, messageId, { bare: true }) },
      select: { id: true, waMessageId: true, authorPhone: true, body: true, reasoning: true, pipelineTrace: true },
    })
  )
    // A copy already cleared has nothing left to take out (the sweep stays a no-op).
    .filter((r) => isStoredIdOf(r.waMessageId, chatId, messageId, { bare: true }) && (r.body !== null || r.reasoning !== null || r.pipelineTrace !== null));
  const archived = (
    await tx.groupMessage.findMany({
      where: { waChatId: chatId, createdAt: { gte: since }, OR: idWhere(chatId, messageId, { bare: true }) },
      select: { id: true, waMessageId: true, senderPhone: true, body: true },
    })
  ).filter((r) => isStoredIdOf(r.waMessageId, chatId, messageId, { bare: true }) && r.body !== "");
  const none = { hq: [], mentions: [], squadProposals: [], feeProposals: [], reminders: [] };
  if (orgIds.length === 0) return { analyzed, archived, ...none };
  const hq = (
    await tx.adminGroupMessage.findMany({
      where: {
        orgId: { in: orgIds },
        createdAt: { gte: since },
        fromMatchTime: false,
        OR: [...idWhere(chatId, messageId), ...idWhere(chatId, messageId, { prefix: "group:" })],
      },
      select: { id: true, waMessageId: true },
    })
  )
    .map((r) => ({ ...r, prefix: r.waMessageId.startsWith("group:") ? "group:" : "" }))
    .filter((r) => r.waMessageId !== messageId && isStoredIdOf(r.waMessageId, chatId, messageId, { prefix: r.prefix }));
  const mentions = (
    await tx.messageMentions.findMany({
      where: { orgId: { in: orgIds }, chatId, sentAt: { gte: since }, OR: idWhere(chatId, messageId, { bare: true }) },
      select: { id: true, waMessageId: true },
    })
  ).filter((r) => isStoredIdOf(r.waMessageId, chatId, messageId, { bare: true }));
  const proposalWhere = { orgId: { in: orgIds }, createdAt: { gte: since }, OR: idWhere(chatId, messageId) };
  const squadProposals = (await tx.adminSquadProposal.findMany({ where: proposalWhere, select: { id: true, waMessageId: true, resolvedAt: true } })).filter((r) =>
    isStoredIdOf(r.waMessageId, chatId, messageId),
  );
  const feeProposals = (await tx.adminFeeProposal.findMany({ where: proposalWhere, select: { id: true, waMessageId: true, resolvedAt: true } })).filter((r) =>
    isStoredIdOf(r.waMessageId, chatId, messageId),
  );
  const reminders = (
    await tx.botJob.findMany({
      where: { orgId: { in: orgIds }, kind: "dm", sentAt: null, OR: idWhere(chatId, messageId, { prefix: REMINDER_ABOUT_PREFIX, field: "aboutKey" }) },
      select: { id: true, aboutKey: true },
    })
  )
    .map((r) => ({ id: r.id, storedId: (r.aboutKey ?? "").slice(REMINDER_ABOUT_PREFIX.length) }))
    .filter((r) => isStoredIdOf(r.storedId, chatId, messageId));
  return { analyzed, archived, hq, mentions, squadProposals, feeProposals, reminders };
}

/** Take the words out of every copy a change applies to. Inside the caller's transaction. */
async function clearCopies(tx: Tx, chatId: string, messageId: string, t: Tombstone, c: Copies, out: MessageChangeResult, now: Date): Promise<void> {
  const applies = (storedId: string, storedPhone?: string | null, prefix = "") => deleteApplies(t, { storedId, chatId, messageId, prefix, storedPhone });
  const analyzedOk = c.analyzed.filter((r) => applies(r.waMessageId, r.authorPhone));
  out.refused += c.analyzed.length - analyzedOk.length;
  if (analyzedOk.length) {
    out.analyzed += (
      await tx.analyzedMessage.updateMany({ where: { id: { in: analyzedOk.map((r) => r.id) } }, data: { body: null, reasoning: null, pipelineTrace: Prisma.DbNull } })
    ).count;
  }
  const archivedOk = c.archived.filter((r) => applies(r.waMessageId, r.senderPhone));
  out.refused += c.archived.length - archivedOk.length;
  if (archivedOk.length) out.archived += (await tx.groupMessage.updateMany({ where: { id: { in: archivedOk.map((r) => r.id) } }, data: { body: "" } })).count;
  const hqOk = c.hq.filter((r) => applies(r.waMessageId, null, r.prefix));
  out.refused += c.hq.length - hqOk.length;
  if (hqOk.length) out.hq += (await tx.adminGroupMessage.deleteMany({ where: { id: { in: hqOk.map((r) => r.id) } } })).count;
  // Each mention row by its own id's author (the participant in it): a
  // member who reuses another's bare id never removes the other's row.
  const mentionsOk = c.mentions.filter((r) => applies(r.waMessageId));
  if (mentionsOk.length) out.mentions += (await tx.messageMentions.deleteMany({ where: { id: { in: mentionsOk.map((r) => r.id) } } })).count;
  // An HQ proposal made from the message (a pasted list, a fee): an open one
  // is cancelled, so a later YES applies nothing, and its copied names,
  // month seed and fee text go with every one.
  const squadOk = c.squadProposals.filter((r) => applies(r.waMessageId));
  if (squadOk.length) {
    const open = squadOk.filter((r) => r.resolvedAt === null).map((r) => r.id);
    if (open.length) await tx.adminSquadProposal.updateMany({ where: { id: { in: open }, resolvedAt: null }, data: { resolvedAt: now, outcome: "source-deleted" } });
    await tx.adminSquadProposal.updateMany({ where: { id: { in: squadOk.map((r) => r.id) } }, data: { playingNewNames: [], reserveNewNames: [], monthSeed: Prisma.DbNull } });
  }
  const feeOk = c.feeProposals.filter((r) => applies(r.waMessageId));
  if (feeOk.length) {
    const open = feeOk.filter((r) => r.resolvedAt === null).map((r) => r.id);
    if (open.length) await tx.adminFeeProposal.updateMany({ where: { id: { in: open }, resolvedAt: null }, data: { resolvedAt: now, outcome: "source-deleted" } });
    await tx.adminFeeProposal.updateMany({ where: { id: { in: feeOk.map((r) => r.id) } }, data: { text: "" } });
  }
  // A reminder DM it asked for, not sent yet: cancelled (its note quotes the message).
  const remindersOk = c.reminders.filter((r) => applies(r.storedId));
  if (remindersOk.length) await tx.botJob.deleteMany({ where: { id: { in: remindersOk.map((r) => r.id) }, sentAt: null } });
}

/**
 * The deleters' phones, widened through the club's LID map (the server's
 * `loadKnownLids`, the same one the mention naming uses): an author whose
 * copy is stored under a phone JID, deleting with only a LID, is matched.
 */
async function withKnownPhones(t: Tombstone, orgIds: string[]): Promise<Tombstone> {
  const lids = t.senderJids.filter((j) => j.endsWith("@lid")).map((j) => j.split("@")[0]);
  if (lids.length === 0 || orgIds.length === 0) return t;
  try {
    const { loadKnownLids } = await import("./known-lids");
    const known = (await Promise.all(orgIds.map((o) => loadKnownLids(o)))).flat();
    const phones = known.filter((k) => k.phone && lids.includes(k.lid.split("@")[0])).map((k) => digits(k.phone));
    return phones.length ? { ...t, senderPhones: [...new Set([...t.senderPhones, ...phones])] } : t;
  } catch {
    return t;
  }
}

/** One message's change, cleared in one transaction. */
async function clearMessage(chatId: string, messageId: string, t: Tombstone, at: Date, out: MessageChangeResult, now: Date): Promise<void> {
  const orgIds = await clubsOf(db, chatId);
  const widened = await withKnownPhones(t, orgIds);
  await db.$transaction(async (tx) => clearCopies(tx, chatId, messageId, widened, await copiesOf(tx, chatId, messageId, at, orgIds), out, now));
}

async function markEnforced(chatId: string, messageIds: string[], now: Date): Promise<void> {
  if (messageIds.length === 0) return;
  await db.deletedMessage.updateMany({ where: { chatId, waMessageId: { in: messageIds } }, data: { enforcedAt: now } }).catch(() => {});
}

/**
 * The recorded change of one message, merged with any earlier one IN ONE
 * STATEMENT (an upsert whose UPDATE merges in SQL: byAdmin = old OR new,
 * the senders unioned, "deleted" wins over "edited"), so two changes
 * posted at once can never lose each other's values. Committed before any
 * clear. A merge resets `enforcedAt`, so the change is cleared again.
 */
async function recordTombstone(input: MessageChangeInput, now: Date): Promise<Tombstone & { deletedAt: Date }> {
  const rows = (await db.$queryRawUnsafe(
    `INSERT INTO "DeletedMessage" ("id", "chatId", "waMessageId", "byAdmin", "reason", "senderJids", "senderPhones", "deletedAt")
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8)
     ON CONFLICT ("chatId", "waMessageId") DO UPDATE SET
       "byAdmin" = "DeletedMessage"."byAdmin" OR EXCLUDED."byAdmin",
       "reason" = CASE WHEN "DeletedMessage"."reason" = 'deleted' OR EXCLUDED."reason" = 'deleted' THEN 'deleted' ELSE 'edited' END,
       "senderJids" = ARRAY(SELECT DISTINCT x FROM unnest(COALESCE("DeletedMessage"."senderJids", '{}'::text[]) || EXCLUDED."senderJids") AS x),
       "senderPhones" = ARRAY(SELECT DISTINCT x FROM unnest(COALESCE("DeletedMessage"."senderPhones", '{}'::text[]) || EXCLUDED."senderPhones") AS x),
       "enforcedAt" = NULL
     RETURNING "byAdmin", "reason", "senderJids", "senderPhones", "deletedAt"`,
    `dm_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 12)}`,
    input.chatId,
    input.messageId,
    input.byAdmin,
    input.kind === "revoke" ? "deleted" : "edited",
    input.senderJids,
    input.senderPhone ? [input.senderPhone] : [],
    now,
  )) as Array<{ byAdmin: boolean; reason: string; senderJids: string[] | null; senderPhones: string[] | null; deletedAt: Date }>;
  const r = rows[0];
  if (!r) throw new Error("tombstone not recorded");
  return { byAdmin: r.byAdmin, reason: r.reason, senderJids: r.senderJids ?? [], senderPhones: r.senderPhones ?? [], deletedAt: new Date(r.deletedAt) };
}

/**
 * Apply a delete or an author's edit: record it, then clear every copy it
 * applies to. Only for a group linked to a club (nothing is stored for any
 * other). Idempotent: a retry finds the same rows already cleared, or none.
 * Throws only on a database failure, which the route turns into a 500 the
 * Pi retries.
 */
export async function applyMessageChange(input: MessageChangeInput, now: Date = new Date()): Promise<MessageChangeResult> {
  const out = empty();
  if ((await clubsOf(db, input.chatId)).length === 0) return out;
  const t = await recordTombstone({ ...input, byAdmin: input.kind === "revoke" && input.byAdmin }, now);
  await clearMessage(input.chatId, input.messageId, t, now, out, now);
  await markEnforced(input.chatId, [input.messageId], now);
  return out;
}

// ── For the writers, the doors and the sweep ───────────────────────────

/** The tombstones of these bare ids in one chat. Best-effort: none on any failure (a missing table). */
async function tombstonesFor(chatId: string, bareIds: string[]): Promise<Map<string, Tombstone & { deletedAt: Date }>> {
  const ids = [...new Set(bareIds)].filter(Boolean);
  if (ids.length === 0) return new Map();
  try {
    const rows = await db.deletedMessage.findMany({
      where: { chatId, waMessageId: { in: ids } },
      select: { waMessageId: true, byAdmin: true, reason: true, senderJids: true, senderPhones: true, deletedAt: true },
    });
    return new Map(rows.map((r) => [r.waMessageId, { byAdmin: r.byAdmin, reason: r.reason, senderJids: r.senderJids, senderPhones: r.senderPhones, deletedAt: r.deletedAt }]));
  } catch {
    return new Map();
  }
}

/**
 * The messages of a batch a recorded DELETE applies to (by their stored
 * ids), so the door leaves them out before reading anything. An EDITED
 * message is not left out: a batch carrying it carries what the Pi holds
 * for it now (the Pi puts an author's edit into its waiting batch in place
 * of the original, `smart-analysis.ts`), and clear-after-write still purges
 * any copy stored under an edited one. Best-effort.
 */
export async function deletedAmong(chatId: string, items: Array<{ id: string; authorPhone?: string | null }>): Promise<Set<string>> {
  const withBare = items.map((i) => ({ ...i, bare: bareIdOf(i.id) })).filter((i): i is typeof i & { bare: string } => !!i.bare);
  const t = await tombstonesFor(chatId, withBare.map((i) => i.bare));
  const out = new Set<string>();
  for (const i of withBare) {
    const ts = t.get(i.bare);
    if (ts && ts.reason === "deleted" && deleteApplies(ts, { storedId: i.id, chatId, messageId: i.bare, storedPhone: i.authorPhone ?? null })) out.add(i.id);
  }
  return out;
}

/** The author of a stored message, from its stored copy's id (the participant) or phone. */
async function storedAuthorOf(chatId: string, messageId: string): Promise<{ jids: string[]; phones: string[] }> {
  try {
    const rows = await db.analyzedMessage.findMany({
      where: { groupId: chatId, OR: idWhere(chatId, messageId, { bare: true }) },
      select: { waMessageId: true, authorPhone: true },
      take: 5,
    });
    const jids: string[] = [];
    const phones: string[] = [];
    for (const r of rows) {
      const p = participantPart(r.waMessageId, chatId, messageId);
      if (p) jids.push(p);
      if (digits(r.authorPhone)) phones.push(digits(r.authorPhone));
    }
    return { jids, phones };
  } catch {
    return { jids: [], phones: [] };
  }
}

/**
 * A reply quoting a deleted or edited message carries no quote text, never
 * the Pi's copy: when the change came from a group admin, or from the
 * QUOTED message's author, matched by the quote's participant id (LID or
 * phone JID) or its phone. When the Pi could not name the quoted author,
 * the stored copy of the quoted message names them. A change from anybody
 * else (a forged delete) leaves the quote. Best-effort.
 */
export async function withoutDeletedQuotes<T extends { quotedMessageId?: string | null; quotedAuthorPhone?: string | null; quotedAuthorJid?: string | null }>(
  chatId: string,
  messages: T[],
  textField: keyof T,
): Promise<T[]> {
  const quoted = messages.filter((m) => typeof m.quotedMessageId === "string" && m.quotedMessageId);
  if (quoted.length === 0) return messages;
  const t = await tombstonesFor(chatId, quoted.map((m) => bareIdOf(m.quotedMessageId as string) ?? ""));
  if (t.size === 0) return messages;
  const out: T[] = [];
  for (const m of messages) {
    const bare = typeof m.quotedMessageId === "string" ? bareIdOf(m.quotedMessageId) : null;
    const ts = bare ? t.get(bare) : undefined;
    if (!ts || !bare) {
      out.push(m);
      continue;
    }
    const jid = typeof m.quotedAuthorJid === "string" && LEGACY_JID.test(m.quotedAuthorJid) ? m.quotedAuthorJid : null;
    const phone = digits(m.quotedAuthorPhone) || (jid?.endsWith("@c.us") ? digits(jid.split("@")[0]) : "");
    const author = jid || phone ? { jids: jid ? [jid] : [], phones: phone ? [phone] : [] } : await storedAuthorOf(chatId, bare);
    const byAuthor = author.jids.some((j) => ts.senderJids.includes(j)) || author.phones.some((p) => ts.senderPhones.map(digits).includes(p));
    if (!ts.byAdmin && !byAuthor) {
      out.push(m);
      continue;
    }
    const copy = { ...m };
    delete copy[textField];
    out.push(copy);
  }
  return out;
}

/**
 * AFTER a writer has written: clear again every message of `storedIds` a
 * recorded change applies to. With the tombstone committed before every
 * change's own clear, this closes the race where a message is written
 * while its delete or edit runs. Never throws; returns how many messages
 * it cleared.
 */
export async function enforceDeletes(chatId: string, storedIds: Array<string | null | undefined>): Promise<number> {
  try {
    const bares = [...new Set(storedIds.map((id) => (id ? bareIdOf(id) : null)).filter((b): b is string => !!b))];
    const t = await tombstonesFor(chatId, bares);
    let cleared = 0;
    const now = new Date();
    for (const [bare, ts] of t) {
      const out = empty();
      await clearMessage(chatId, bare, ts, ts.deletedAt, out, now);
      if (out.analyzed + out.archived + out.hq + out.mentions > 0) {
        cleared++;
        console.log(`[message-change] ${chatId} ${bare}: a late copy of a deleted or edited message cleared (analyzed=${out.analyzed} archived=${out.archived} hq=${out.hq} mentions=${out.mentions})`);
      }
    }
    return cleared;
  } catch (err) {
    console.error(`[message-change] ${chatId}: deletes not enforced:`, err instanceof Error ? err.message : "failed");
    return 0;
  }
}

/** How long after a change the sweep keeps re-checking it for late writers. */
export const SWEEP_RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * THE SAFETY SWEEP (hourly, /api/cron/bot-health). The tombstones never
 * enforced yet (`enforcedAt` null: a request that died before its own
 * clear), oldest first, then the ones of the last six hours again (a late
 * writer), at most SWEEP_MAX a run, each marked enforced; then the ones
 * past the 14-day retention pruned. A backlog is worked through run by
 * run. Idempotent; each message is a handful of indexed reads. Never throws.
 */
export async function sweepRecentTombstones(now: Date = new Date()): Promise<{ checked: number; cleared: number; pruned: number }> {
  try {
    const since = new Date(now.getTime() - WINDOW_MS);
    const pruned = (await db.deletedMessage.deleteMany({ where: { deletedAt: { lt: since } } })).count;
    const select = { chatId: true, waMessageId: true, byAdmin: true, reason: true, senderJids: true, senderPhones: true, deletedAt: true } as const;
    const never = await db.deletedMessage.findMany({ where: { enforcedAt: null, deletedAt: { gte: since } }, orderBy: { deletedAt: "asc" }, take: SWEEP_MAX, select });
    const recent =
      never.length < SWEEP_MAX
        ? await db.deletedMessage.findMany({
            where: { enforcedAt: { not: null }, deletedAt: { gte: new Date(now.getTime() - SWEEP_RECHECK_MS) } },
            orderBy: { deletedAt: "desc" },
            take: SWEEP_MAX - never.length,
            select,
          })
        : [];
    const rows = [...never, ...recent];
    let cleared = 0;
    for (const r of rows) {
      const out = empty();
      await clearMessage(r.chatId, r.waMessageId, r, r.deletedAt, out, now);
      if (out.analyzed + out.archived + out.hq + out.mentions > 0) cleared++;
      await markEnforced(r.chatId, [r.waMessageId], now);
    }
    if (cleared > 0) console.log(`[message-change] sweep: ${cleared} of ${rows.length} deleted or edited message(s) had copies cleared`);
    return { checked: rows.length, cleared, pruned };
  } catch (err) {
    console.error("[message-change] sweep failed:", err instanceof Error ? err.message : "failed");
    return { checked: 0, cleared: 0, pruned: 0 };
  }
}
