/**
 * EDIT OR DELETE A GROUP MESSAGE, AND MATCHTIME FORGETS THE ORIGINAL WORDS
 * (2026-11-15, PR #606, after seven rounds of review).
 *
 * Until PR #606 the Pi dropped WhatsApp's delete and edit notices
 * (`protocolMessage`) as unreadable, so the words a member had taken back
 * stayed in every store below for up to a week, and any tagged question
 * could have them quoted back. The Pi now posts each one to
 * `/api/whatsapp/message-change` (and retries until it lands); this is what
 * that does. Housekeeping only: nothing here analyses, replies, reacts or
 * sends.
 *
 * WHAT A MEMBER IS PROMISED (the rule after six review rounds):
 *
 *   1. Delete for everyone: MatchTime forgets the words, and anything it
 *      was about to do because of that message (a proposal waiting for a
 *      YES, a reminder, a draft DM) is cancelled.
 *   2. Edit your own message: MatchTime forgets the original words. It acts
 *      on what it read, as it always has; it does not re-read edits. So an
 *      edit purges the stored text through the very code a delete's purge
 *      takes, stores no new words, and NEVER cancels anything.
 *   3. Nobody else can do either for you.
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
 *     enforces every tombstone never enforced yet, for a request that died
 *     before its own clear (a function time limit), and re-checks each for
 *     six hours after its latest change (a late writer).
 *
 * WHO, PER CHANGE (round 6): every change is kept on its own (`changes`:
 * reason, sender, byAdmin, time; the same change once, at most 20), and
 * each is judged alone. A delete applies to a copy when it came from a
 * group admin (the Pi reads it from the group's metadata) or from the
 * copy's own author; an edit only from its author. A forged delete never
 * borrows the author's real edit: the message is DELETED only if an
 * applying delete exists. Anything else is recorded (it can be checked
 * again when the message turns up) and applies to nothing.
 *
 * THE DOOR: the analyze and admin-group doors leave out only a DELETED
 * message; an edited one is analysed as the Pi sent it, and clear-after-
 * write then purges what was stored. The Pi's recent-chat lines and quotes
 * of a deleted or author-edited message are dropped at the door
 * (`withoutChangedHistory`, `withoutDeletedQuotes`).
 *
 * THE STORES OF A MEMBER'S WORDS, and what an applying change does (one
 * transaction per message, so a retry finds it whole or untouched). A
 * DELETE removes; an EDIT purges the TEXT and keeps the FACTS (round 8):
 * every row a feature reads stays, with its sender, time, kind and flags.
 *
 *   AnalyzedMessage   body and reasoning null (the ROW stays as the analyze
 *       route's dedupe key). pipelineTrace: null for a delete; for an
 *       edit, its structured reading only (`message-change-trace.ts`:
 *       enums, numbers, booleans, checked times; no names), so "try
 *       again" still finds the ask. An edited question with a "who do you
 *       mean?" still open keeps its question in the trace, for that
 *       clarification alone, until its hour is up; then the sweep takes
 *       it. The week of chat, the extractors' recent chat and the open
 *       clarification leave a null body out; only a delete closes it.
 *   GroupMessage      body "" (the row is the archive's dedupe key); the
 *       squad-from-list reader leaves an empty body out.
 *   AdminGroupMessage HQ's log (`<id>`) and the players' group's organiser
 *       lines (`group:<id>`): a delete REMOVES the row, trace and
 *       hqOutcome with it; an edit keeps the row (who spoke, when, the
 *       outcome: the safe-YES rule and "who shall I ask?" read it) with
 *       text "" and the trace as above. No reader shows a blank line.
 *   MessageMentions   a delete removes it, each row by its own id's author;
 *       an edit keeps it ("DM the people above" reads who was tagged,
 *       which is no words).
 *   FormNote          the reason a note was set with ("tired"), when the
 *       message set it last: "" (the delta stays).
 *
 * AND, FOR A DELETE ONLY (what MatchTime was about to do because of it):
 *
 *   AdminSquadProposal / AdminFeeProposal  an HQ proposal made from the
 *       message: an open one cancelled (outcome "source-deleted", so a later
 *       YES applies nothing); its copied names, month seed and fee text
 *       cleared, and MatchTime's own question about it, which repeats them
 *       (the HQ reply's claimed text, the HQ log's "list:<id>" and
 *       "fee:<proposalId>" lines, a month-seed draft's DM offer).
 *   BotJob            an unsent DM made from the message: a reminder it
 *       asked for (`aboutKey` "asked-reminder:<id>") or a month-seed draft
 *       read from it ("month-seed-of:<id>"): cancelled.
 *
 * MATCHED BY WHATSAPP ID AND GROUP, NEVER BY TEXT (`isStoredIdOf`). Every
 * lookup is narrowed by an index: the group (AnalyzedMessage.groupId,
 * GroupMessage.waChatId), the club(s) the group belongs to (HQ's log and
 * the mentions, the form notes), and the 14 days before the first change.
 *
 * DMs are not posted (no member's DM text is stored for a later answer).
 * Logs carry ids and counts, never the words.
 */
import { db } from "./db";
import { Prisma } from "@/generated/prisma/client";
import { TOMBSTONE_UPSERT_SQL } from "./message-change-sql";
import { groupReplyKey, hqReplyKey } from "./reply-context";
import { listAskRef } from "./admin-group-log";
import { feeAskRef } from "./fee-waiver-rules";
import { heldQuestionOf, isTextFree, sameJson, textFreeTrace, withHeldQuestion } from "./message-change-trace";

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
  /** AdminGroupMessage rows removed (a delete) or blanked, row kept (an edit). */
  hq: number;
  /** MessageMentions rows deleted. */
  mentions: number;
  /** FormNote reasons cleared. */
  notes: number;
  /** Copies left alone: the change came from somebody who may not make it. */
  refused: number;
}

/** What a tombstone says about who changed the message, and how. */
export interface Tombstone {
  byAdmin: boolean;
  senderJids: string[];
  senderPhones: string[];
  /** "deleted" once any delete was seen, else "edited". A summary. */
  reason?: string;
  /** EACH change on its own: the source of truth (round 6). */
  changes?: ChangeRecord[];
}

/** One delete or edit of a message, as recorded: who, how, and when. */
export interface ChangeRecord {
  reason: "deleted" | "edited";
  /** A group admin sent it. Only ever true for a delete. */
  byAdmin: boolean;
  senderJids: string[];
  senderPhones: string[];
  /** ISO time the change was recorded. */
  at: string;
}

/** The changes of a tombstone; a row with none (written before round 6, or by a test) reads as one change from its summary. */
function changesOf(t: Tombstone & { deletedAt?: Date }): ChangeRecord[] {
  const list = Array.isArray(t.changes) ? t.changes.filter((c) => c && (c.reason === "deleted" || c.reason === "edited")) : [];
  if (list.length) return list;
  return [
    {
      reason: t.reason === "edited" ? "edited" : "deleted",
      byAdmin: t.byAdmin && t.reason !== "edited",
      senderJids: t.senderJids ?? [],
      senderPhones: t.senderPhones ?? [],
      at: (t.deletedAt ?? new Date(0)).toISOString(),
    },
  ];
}

type StoredRef = { storedId: string; chatId: string; messageId: string; prefix?: string; storedPhone?: string | null };

/** Does ONE change apply to this stored copy? A delete from an admin, or any change from the copy's own author. */
function changeApplies(c: ChangeRecord, stored: StoredRef): boolean {
  return (c.reason === "deleted" && c.byAdmin) || isAuthorOf(stored, { jids: c.senderJids, phones: c.senderPhones });
}

const digits = (v: unknown): string => (typeof v === "string" ? v.replace(/\D/g, "") : "");
const empty = (): MessageChangeResult => ({ analyzed: 0, archived: 0, hq: 0, mentions: 0, notes: 0, refused: 0 });
const anyCleared = (o: MessageChangeResult) => o.analyzed + o.archived + o.hq + o.mentions + o.notes > 0;

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
export function deleteApplies(t: Tombstone & { deletedAt?: Date }, stored: StoredRef): boolean {
  return changesOf(t).some((c) => changeApplies(c, stored));
}

/** PURE. Was this copy DELETED (a delete that applies to it, never an edit)? Only this drops a batch at the door. */
export function deletedFor(t: Tombstone & { deletedAt?: Date }, stored: StoredRef): boolean {
  return changesOf(t).some((c) => c.reason === "deleted" && changeApplies(c, stored));
}

/** PURE. Was any delete recorded (whoever sent it)? Only then is anything made from the message looked at, to cancel. */
function hasDelete(t: Tombstone & { deletedAt?: Date }): boolean {
  return changesOf(t).some((c) => c.reason === "deleted");
}

// ── The stores ─────────────────────────────────────────────────────────

/** The models a transaction here touches (the extended client's own delegates). */
type Tx = Pick<
  typeof db,
  | "analyzedMessage"
  | "groupMessage"
  | "adminGroupMessage"
  | "messageMentions"
  | "deletedMessage"
  | "organisation"
  | "adminSquadProposal"
  | "adminFeeProposal"
  | "botJob"
  | "formNote"
  | "ratingAdjustment"
  | "sentNotification"
>;

/** The prefix of a reminder DM's `BotJob.aboutKey`: the message that asked for it (`owner-deps.ts`). */
export const REMINDER_ABOUT_PREFIX = "asked-reminder:";
/** The prefix of a month-seed draft DM's `BotJob.aboutKey`: the pasted message it was read from (`month-seed-group.ts`). */
export const MONTH_SEED_ABOUT_PREFIX = "month-seed-of:";
/** Unsent DMs made from a message, cancelled with it. */
const SOURCE_ABOUT_PREFIXES = [REMINDER_ABOUT_PREFIX, MONTH_SEED_ABOUT_PREFIX];

function idWhere(chatId: string, messageId: string, opts: { prefix?: string; bare?: boolean; field?: string } = {}) {
  const f = storedIdForms(chatId, messageId, opts.prefix ?? "");
  const field = opts.field ?? "waMessageId";
  return [
    { [field]: { in: opts.bare ? [...f.exact, messageId] : f.exact } },
    ...f.prefixes.map((p) => ({ [field]: { startsWith: p } })),
  ];
}

interface Copies {
  analyzed: Array<{ id: string; waMessageId: string; authorPhone: string | null; body: string | null; reasoning: string | null; pipelineTrace: unknown; intent: string | null; createdAt: Date }>;
  archived: Array<{ id: string; waMessageId: string; senderPhone: string | null }>;
  hq: Array<{ id: string; waMessageId: string; prefix: string; text: string; pipelineTrace: unknown }>;
  mentions: Array<{ id: string; waMessageId: string }>;
  notes: Array<{ id: string; orgId: string; sourceMessageId: string; sourceIds: string[]; matchId: string; userId: string; delta: number; reason: string }>;
  squadProposals: Array<{ id: string; orgId: string; waMessageId: string; resolvedAt: Date | null }>;
  feeProposals: Array<{ id: string; orgId: string; waMessageId: string; resolvedAt: Date | null }>;
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
async function copiesOf(tx: Tx, chatId: string, messageId: string, at: Date, orgIds: string[], withMade: boolean): Promise<Copies> {
  const since = new Date(at.getTime() - WINDOW_MS);
  const analyzed = (
    await tx.analyzedMessage.findMany({
      where: { groupId: chatId, createdAt: { gte: since }, OR: idWhere(chatId, messageId, { bare: true }) },
      select: { id: true, waMessageId: true, authorPhone: true, body: true, reasoning: true, pipelineTrace: true, intent: true, createdAt: true },
    })
  ).filter((r) => isStoredIdOf(r.waMessageId, chatId, messageId, { bare: true }));
  const archived = (
    await tx.groupMessage.findMany({
      where: { waChatId: chatId, createdAt: { gte: since }, OR: idWhere(chatId, messageId, { bare: true }) },
      select: { id: true, waMessageId: true, senderPhone: true, body: true },
    })
  ).filter((r) => isStoredIdOf(r.waMessageId, chatId, messageId, { bare: true }) && r.body !== "");
  const none = { hq: [], mentions: [], notes: [], squadProposals: [], feeProposals: [], reminders: [] };
  if (orgIds.length === 0) return { analyzed, archived, ...none };
  const hq = (
    await tx.adminGroupMessage.findMany({
      where: {
        orgId: { in: orgIds },
        createdAt: { gte: since },
        fromMatchTime: false,
        OR: [...idWhere(chatId, messageId), ...idWhere(chatId, messageId, { prefix: "group:" })],
      },
      select: { id: true, waMessageId: true, text: true, pipelineTrace: true },
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
  // A form note's reason, when this message set the note last OR wrote its
  // reason (a later message may only have changed the amount).
  const notes = (
    await tx.formNote.findMany({
      where: {
        orgId: { in: orgIds },
        reason: { not: "" },
        OR: [...idWhere(chatId, messageId, { field: "sourceMessageId" }), ...idWhere(chatId, messageId, { field: "reasonSourceMessageId" })],
      },
      select: { id: true, orgId: true, sourceMessageId: true, reasonSourceMessageId: true, matchId: true, userId: true, delta: true, reason: true },
    })
  ).flatMap((r) => {
    const ids = [r.sourceMessageId, r.reasonSourceMessageId].filter((x): x is string => !!x);
    const src = ids.find((x) => isStoredIdOf(x, chatId, messageId));
    return src ? [{ id: r.id, orgId: r.orgId, sourceMessageId: src, sourceIds: [...new Set(ids)], matchId: r.matchId, userId: r.userId, delta: r.delta, reason: r.reason }] : [];
  });
  // What MatchTime was about to do because of the message: only a delete cancels it.
  if (!withMade) return { analyzed, archived, hq, mentions, notes, squadProposals: [], feeProposals: [], reminders: [] };
  const proposalWhere = { orgId: { in: orgIds }, createdAt: { gte: since }, OR: idWhere(chatId, messageId) };
  const squadProposals = (await tx.adminSquadProposal.findMany({ where: proposalWhere, select: { id: true, orgId: true, waMessageId: true, resolvedAt: true } })).filter((r) =>
    isStoredIdOf(r.waMessageId, chatId, messageId),
  );
  const feeProposals = (await tx.adminFeeProposal.findMany({ where: proposalWhere, select: { id: true, orgId: true, waMessageId: true, resolvedAt: true } })).filter((r) =>
    isStoredIdOf(r.waMessageId, chatId, messageId),
  );
  const reminders = (
    await tx.botJob.findMany({
      where: { orgId: { in: orgIds }, kind: "dm", sentAt: null, OR: SOURCE_ABOUT_PREFIXES.flatMap((prefix) => idWhere(chatId, messageId, { prefix, field: "aboutKey" })) },
      select: { id: true, aboutKey: true },
    })
  )
    .map((r) => {
      const key = r.aboutKey ?? "";
      const prefix = SOURCE_ABOUT_PREFIXES.find((x) => key.startsWith(x)) ?? "";
      return { id: r.id, storedId: key.slice(prefix.length) };
    })
    .filter((r) => isStoredIdOf(r.storedId, chatId, messageId));
  return { analyzed, archived, hq, mentions, notes, squadProposals, feeProposals, reminders };
}

/**
 * What a change does to one stored copy (round 8): "delete" when an
 * applying DELETE exists (the copy goes, as it always has), "edit" when only
 * its author's EDIT applies (the TEXT goes, the facts stay), or null.
 */
type Mode = "delete" | "edit" | null;

/**
 * Take the words out of every copy a change applies to. Inside the caller's
 * transaction. Returns true when a copy was deliberately left for later (an
 * open "who do you mean?" holding its question): the tombstone is then not
 * marked enforced, so the sweep comes back for it.
 *
 * A DELETE removes, as before. An EDIT purges the TEXT and keeps the FACTS
 * (the member's promise 2): every row a feature reads stays, with its
 * sender, time, kind and flags, and only its words go:
 *
 *   AnalyzedMessage   body and reasoning null; the trace keeps its
 *       structured reading (`message-change-trace.ts`). An open "who do you
 *       mean?" (intent stats_clarification, within its hour) keeps its
 *       question in the trace, for that clarification alone, until the
 *       hour is up.
 *   AdminGroupMessage text "", the trace as above; the row (who spoke,
 *       when, its outcome) stays for the safe-YES rule and the "who shall
 *       I ask?" positional tests.
 *   MessageMentions   kept whole: it holds who was tagged, never words.
 */
async function clearCopies(tx: Tx, chatId: string, messageId: string, t: Tombstone, c: Copies, out: MessageChangeResult, now: Date, clar: Clarification, forms: FormNoteFormat): Promise<boolean> {
  const mode = (storedId: string, storedPhone?: string | null, prefix = ""): Mode => {
    const ref = { storedId, chatId, messageId, prefix, storedPhone };
    if (deletedFor(t, ref)) return "delete";
    return deleteApplies(t, ref) ? "edit" : null;
  };
  const applies = (storedId: string, storedPhone?: string | null, prefix = "") => mode(storedId, storedPhone, prefix) !== null;
  let deferred = false;

  // AnalyzedMessage: one row at a time (each trace is its own).
  for (const r of c.analyzed) {
    const m = mode(r.waMessageId, r.authorPhone);
    if (!m) {
      if (r.body !== null || r.reasoning !== null || r.pipelineTrace !== null) out.refused++;
      continue;
    }
    let trace: unknown = null;
    if (m === "edit") {
      trace = textFreeTrace(r.pipelineTrace);
      const until = new Date(r.createdAt.getTime() + clar.ttlMs);
      if (r.intent === clar.intent && now.getTime() < until.getTime()) {
        const question = r.body ?? heldQuestionOf(r.pipelineTrace)?.text ?? null;
        if (question) {
          trace = withHeldQuestion(trace as Record<string, unknown> | null, question, until);
          deferred = true;
        }
      }
    }
    const done = r.body === null && r.reasoning === null && sameJson(r.pipelineTrace ?? null, trace);
    if (done) continue;
    await tx.analyzedMessage.update({ where: { id: r.id }, data: { body: null, reasoning: null, pipelineTrace: trace === null ? Prisma.DbNull : (trace as object) } });
    out.analyzed++;
  }
  const archivedOk = c.archived.filter((r) => applies(r.waMessageId, r.senderPhone));
  out.refused += c.archived.length - archivedOk.length;
  if (archivedOk.length) out.archived += (await tx.groupMessage.updateMany({ where: { id: { in: archivedOk.map((r) => r.id) } }, data: { body: "" } })).count;
  // HQ's log and the players' group's organiser lines.
  const hqGone: string[] = [];
  for (const r of c.hq) {
    const m = mode(r.waMessageId, null, r.prefix);
    if (!m) {
      out.refused++;
      continue;
    }
    if (m === "delete") {
      hqGone.push(r.id);
      continue;
    }
    if (r.text === "" && isTextFree(r.pipelineTrace)) continue;
    const trace = textFreeTrace(r.pipelineTrace);
    await tx.adminGroupMessage.update({ where: { id: r.id }, data: { text: "", pipelineTrace: trace === null ? Prisma.DbNull : (trace as object) } });
    out.hq++;
  }
  if (hqGone.length) out.hq += (await tx.adminGroupMessage.deleteMany({ where: { id: { in: hqGone } } })).count;
  // Each mention row by its own id's author (the participant in it): a
  // member who reuses another's bare id never removes the other's row. A
  // DELETE removes it; an edit keeps it (who was tagged is no words).
  const mentionsGone = c.mentions.filter((r) => mode(r.waMessageId) === "delete");
  if (mentionsGone.length) out.mentions += (await tx.messageMentions.deleteMany({ where: { id: { in: mentionsGone.map((r) => r.id) } } })).count;
  const notesOk = c.notes.filter((r) => applies(r.sourceMessageId));
  out.refused += c.notes.length - notesOk.length;
  if (notesOk.length) {
    out.notes += (await tx.formNote.updateMany({ where: { id: { in: notesOk.map((r) => r.id) } }, data: { reason: "" } })).count;
    for (const n of notesOk) {
      // Team generation copies the reason into the rating adjustment's audit
      // row, formatted (`form-note-rules.ts` `formNoteReason`, through
      // `formNotesWin`): that exact string for that player in that match, and
      // nothing looser, so the adjuster's own rows are never touched.
      const copied = forms.formNoteReason({ delta: forms.clampFormDelta(n.delta).delta, reason: n.reason });
      await tx.ratingAdjustment.updateMany({ where: { matchId: n.matchId, userId: n.userId, reason: copied }, data: { reason: "" } });
      // MatchTime's acknowledgement ("Noted: -0.5 for Pete Power (tired) ..."),
      // claimed under the message it answered (`group-reply-claims.ts`): the
      // note's reason, MatchTime's own copy of that exact string, goes from it.
      const keys = n.sourceIds.flatMap((id) => [groupReplyKey(n.orgId, id), hqReplyKey(n.orgId, id)]);
      const acks = await tx.sentNotification.findMany({ where: { key: { in: keys } }, select: { id: true, text: true } });
      for (const a of acks) {
        const text = withoutReason(a.text, n.reason);
        if (text !== a.text) await tx.sentNotification.update({ where: { id: a.id }, data: { text } });
      }
    }
  }
  // FOR A DELETE ONLY: what MatchTime was about to do because of the message.
  // An HQ proposal made from it (a pasted list, a fee): an open one is
  // cancelled, so a later YES applies nothing, and its copied names, month
  // seed and fee text go with every one, with MatchTime's own question
  // about it. A DM made from it, not sent yet (a reminder it asked for, a
  // month-seed draft read from it): cancelled, since it quotes the message.
  // Guarded like every other copy: a delete from somebody who may not make
  // it leaves someone else's proposal open and their DM queued. An EDIT
  // never cancels anything (the member's promise 2).
  const cancels = (storedId: string) => deletedFor(t, { storedId, chatId, messageId });
  const squadOk = c.squadProposals.filter((r) => cancels(r.waMessageId));
  out.refused += c.squadProposals.length - squadOk.length;
  if (squadOk.length) {
    const open = squadOk.filter((r) => r.resolvedAt === null).map((r) => r.id);
    if (open.length) await tx.adminSquadProposal.updateMany({ where: { id: { in: open }, resolvedAt: null }, data: { resolvedAt: now, outcome: "source-deleted" } });
    await tx.adminSquadProposal.updateMany({ where: { id: { in: squadOk.map((r) => r.id) } }, data: { playingNewNames: [], reserveNewNames: [], monthSeed: Prisma.DbNull } });
    await tx.adminGroupMessage.updateMany({
      where: { orgId: { in: [...new Set(squadOk.map((r) => r.orgId))] }, fromMatchTime: true, askRef: { in: squadOk.map((r) => listAskRef(r.waMessageId)) } },
      data: { text: "" },
    });
  }
  const feeOk = c.feeProposals.filter((r) => cancels(r.waMessageId));
  out.refused += c.feeProposals.length - feeOk.length;
  if (feeOk.length) {
    const open = feeOk.filter((r) => r.resolvedAt === null).map((r) => r.id);
    if (open.length) await tx.adminFeeProposal.updateMany({ where: { id: { in: open }, resolvedAt: null }, data: { resolvedAt: now, outcome: "source-deleted" } });
    await tx.adminFeeProposal.updateMany({ where: { id: { in: feeOk.map((r) => r.id) } }, data: { text: "" } });
    // Its question's HQ line (`fee:<proposalId>`, `fee-waiver.ts`).
    await tx.adminGroupMessage.updateMany({
      where: { orgId: { in: [...new Set(feeOk.map((r) => r.orgId))] }, fromMatchTime: true, askRef: { in: feeOk.map((r) => feeAskRef(r.id)) } },
      data: { text: "" },
    });
  }
  // MatchTime's HQ reply to the message (the question about the list or the
  // fee), as claimed for its ack: its words go; its id stays, so a YES
  // quoting it is still recognised.
  // And a month-seed draft's DM offer (`month-seed-group.ts`), keyed by the proposal.
  const asked = [...[...squadOk, ...feeOk].map((r) => hqReplyKey(r.orgId, r.waMessageId)), ...squadOk.map((r) => `org-${r.orgId}:month-seed-dm:${r.id}`)];
  if (asked.length) await tx.sentNotification.updateMany({ where: { key: { in: [...new Set(asked)] } }, data: { text: null } });
  const remindersOk = c.reminders.filter((r) => cancels(r.storedId));
  out.refused += c.reminders.length - remindersOk.length;
  if (remindersOk.length) await tx.botJob.deleteMany({ where: { id: { in: remindersOk.map((r) => r.id) }, sentAt: null } });
  return deferred;
}

/**
 * The deleters' phones, widened through the club's LID map (the server's
 * `loadKnownLids`, the same one the mention naming uses): an author whose
 * copy is stored under a phone JID, deleting with only a LID, is matched.
 */
async function withKnownPhones<T extends Tombstone & { deletedAt?: Date }>(t: T, orgIds: string[]): Promise<T> {
  const list = changesOf(t);
  const lids = [...new Set(list.flatMap((c) => c.senderJids).filter((j) => j.endsWith("@lid")).map((j) => j.split("@")[0]))];
  if (lids.length === 0 || orgIds.length === 0) return t;
  try {
    const { loadKnownLids } = await import("./known-lids");
    const known = (await Promise.all(orgIds.map((o) => loadKnownLids(o)))).flat();
    const phoneOf = (lid: string) => known.filter((k) => k.phone && k.lid.split("@")[0] === lid).map((k) => digits(k.phone));
    const changes = list.map((c) => {
      const extra = c.senderJids.filter((j) => j.endsWith("@lid")).flatMap((j) => phoneOf(j.split("@")[0]));
      return extra.length ? { ...c, senderPhones: [...new Set([...c.senderPhones, ...extra])] } : c;
    });
    return { ...t, changes };
  } catch {
    return t;
  }
}

/** An open "who do you mean?": its intent and its window (`pipeline/awaiting-answer.ts`). */
interface Clarification {
  intent: string;
  ttlMs: number;
}

/** How team generation formats a note's reason (`form-note-rules.ts`). */
interface FormNoteFormat {
  formNoteReason(note: { delta: number; reason: string }): string;
  clampFormDelta(raw: number): { delta: number };
}

/** PURE. MatchTime's own text with a note's reason taken out ("... (tired) in" becomes "... in"). */
function withoutReason(text: string | null, reason: string): string | null {
  if (!text || !reason) return text;
  return text.split(` (${reason})`).join("").split(`(${reason})`).join("").split(reason).join("");
}

/** One message's change, cleared in one transaction. True when a copy was left for later (see `clearCopies`). */
async function clearMessage(chatId: string, messageId: string, t: Tombstone, at: Date, out: MessageChangeResult, now: Date): Promise<boolean> {
  const orgIds = await clubsOf(db, chatId);
  const widened = await withKnownPhones(t, orgIds);
  // Loaded here, not imported above: the admin-group route's static graph
  // stays clear of the pipeline (`admin-group-model-door.source.test.ts`).
  const { GROUP_QUESTION_TTL_MS, STATS_CLARIFICATION_INTENT } = await import("./pipeline/awaiting-answer");
  const clar = { intent: STATS_CLARIFICATION_INTENT, ttlMs: GROUP_QUESTION_TTL_MS };
  const forms = await import("./form-note-rules");
  return db.$transaction(async (tx) => clearCopies(tx, chatId, messageId, widened, await copiesOf(tx, chatId, messageId, at, orgIds, hasDelete(widened)), out, now, clar, forms));
}

async function markEnforced(chatId: string, messageIds: string[], now: Date): Promise<void> {
  if (messageIds.length === 0) return;
  await db.deletedMessage.updateMany({ where: { chatId, waMessageId: { in: messageIds } }, data: { enforcedAt: now } }).catch(() => {});
}

/**
 * The recorded change of one message, merged with any earlier one IN ONE
 * STATEMENT (an upsert whose UPDATE merges in SQL: byAdmin = old OR new,
 * the senders unioned, "deleted" wins over "edited", the change appended
 * unless the same one, whatever its time, is there already, at most
 * MAX_CHANGES_PER_MESSAGE kept with deletes before edits, `lastChangeAt`
 * moved on), so two changes posted at once can never lose each other's
 * values (`message-change-sql.ts`). Committed before any clear. A NEW
 * change resets `enforcedAt`, so it is cleared again; the same change again
 * is a no-op for the record.
 */
async function recordTombstone(input: MessageChangeInput, now: Date): Promise<Tombstone & { deletedAt: Date }> {
  const rows = (await db.$queryRawUnsafe(
    TOMBSTONE_UPSERT_SQL,
    `dm_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 12)}`,
    input.chatId,
    input.messageId,
    input.byAdmin,
    input.kind === "revoke" ? "deleted" : "edited",
    input.senderJids,
    input.senderPhone ? [input.senderPhone] : [],
    now,
    JSON.stringify([
      {
        reason: input.kind === "revoke" ? "deleted" : "edited",
        byAdmin: input.kind === "revoke" && input.byAdmin,
        senderJids: input.senderJids,
        senderPhones: input.senderPhone ? [input.senderPhone] : [],
        at: now.toISOString(),
      } satisfies ChangeRecord,
    ]),
  )) as Array<{ byAdmin: boolean; reason: string; senderJids: string[] | null; senderPhones: string[] | null; deletedAt: Date; changes: unknown }>;
  const r = rows[0];
  if (!r) throw new Error("tombstone not recorded");
  const changes = (typeof r.changes === "string" ? JSON.parse(r.changes) : r.changes) as ChangeRecord[] | null;
  return { byAdmin: r.byAdmin, reason: r.reason, senderJids: r.senderJids ?? [], senderPhones: r.senderPhones ?? [], changes: changes ?? [], deletedAt: new Date(r.deletedAt) };
}

/**
 * Apply a delete or an author's edit: record it, then clear every copy it
 * applies to. Only for a group linked to a club: the stores cleared here
 * keep only those groups' messages (the chat captured when MatchTime joins a
 * group, for setup, is not cleared: the PR's known limits). Idempotent: a retry finds the same rows already cleared, or none.
 * Throws only on a database failure, which the route turns into a 500 the
 * Pi retries.
 */
export async function applyMessageChange(input: MessageChangeInput, now: Date = new Date()): Promise<MessageChangeResult> {
  const out = empty();
  if ((await clubsOf(db, input.chatId)).length === 0) return out;
  const t = await recordTombstone({ ...input, byAdmin: input.kind === "revoke" && input.byAdmin }, now);
  const deferred = await clearMessage(input.chatId, input.messageId, t, now, out, now);
  if (!deferred) await markEnforced(input.chatId, [input.messageId], now);
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
      select: { waMessageId: true, byAdmin: true, reason: true, senderJids: true, senderPhones: true, changes: true, deletedAt: true },
    });
    return new Map(
      rows.map((r) => [
        r.waMessageId,
        { byAdmin: r.byAdmin, reason: r.reason, senderJids: r.senderJids, senderPhones: r.senderPhones, changes: (r.changes ?? []) as unknown as ChangeRecord[], deletedAt: r.deletedAt },
      ]),
    );
  } catch {
    return new Map();
  }
}

/**
 * The messages of a batch a recorded DELETE applies to (by their stored
 * ids), so the door leaves them out before reading anything. An EDITED
 * message is not left out: it is analysed once, as the Pi sent it (the
 * member's promise 2), and clear-after-write then purges what was stored.
 * Best-effort.
 */
export async function deletedAmong(chatId: string, items: Array<{ id: string; authorPhone?: string | null }>): Promise<Set<string>> {
  const withBare = items.map((i) => ({ ...i, bare: bareIdOf(i.id) })).filter((i): i is typeof i & { bare: string } => !!i.bare);
  const t = await tombstonesFor(chatId, withBare.map((i) => i.bare));
  const out = new Set<string>();
  for (const i of withBare) {
    const ts = t.get(i.bare);
    if (ts && deletedFor(ts, { storedId: i.id, chatId, messageId: i.bare, storedPhone: i.authorPhone ?? null })) out.add(i.id);
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
  const orgIds = await clubsOf(db, chatId).catch(() => [] as string[]);
  const out: T[] = [];
  for (const m of messages) {
    const bare = typeof m.quotedMessageId === "string" ? bareIdOf(m.quotedMessageId) : null;
    const raw = bare ? t.get(bare) : undefined;
    if (!raw || !bare) {
      out.push(m);
      continue;
    }
    // The deleter widened through the club's LID map, as the clear does.
    const ts = await withKnownPhones(raw, orgIds);
    const jid = typeof m.quotedAuthorJid === "string" && LEGACY_JID.test(m.quotedAuthorJid) ? m.quotedAuthorJid : null;
    const phone = digits(m.quotedAuthorPhone) || (jid?.endsWith("@c.us") ? digits(jid.split("@")[0]) : "");
    const author = jid || phone ? { jids: jid ? [jid] : [], phones: phone ? [phone] : [] } : await storedAuthorOf(chatId, bare);
    const strip = changesOf(ts).some(
      (c) => (c.reason === "deleted" && c.byAdmin) || author.jids.some((j) => c.senderJids.includes(j)) || author.phones.some((p) => c.senderPhones.map(digits).includes(p)),
    );
    if (!strip) {
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
 * THE SERVER'S SAFETY NET FOR THE PI'S RECENT CHAT (round 6): a line whose
 * message was deleted, or edited by its author (the participant in the
 * line's own id), is dropped before any model reads it, so a slip on the
 * Pi cannot bring the original words back. A forged change, or a line with
 * no id (an older Pi), is kept. Best-effort.
 */
export async function withoutChangedHistory<L extends { waMessageId?: string | null }>(chatId: string, lines: L[]): Promise<L[]> {
  const withId = lines.filter((l) => typeof l.waMessageId === "string" && l.waMessageId);
  if (withId.length === 0) return lines;
  const t = await tombstonesFor(chatId, withId.map((l) => bareIdOf(l.waMessageId as string) ?? ""));
  if (t.size === 0) return lines;
  const orgIds = await clubsOf(db, chatId).catch(() => [] as string[]);
  const out: L[] = [];
  for (const l of lines) {
    const bare = typeof l.waMessageId === "string" ? bareIdOf(l.waMessageId) : null;
    const raw = bare ? t.get(bare) : undefined;
    if (raw && bare && deleteApplies(await withKnownPhones(raw, orgIds), { storedId: l.waMessageId as string, chatId, messageId: bare })) continue;
    out.push(l);
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
      const deferred = await clearMessage(chatId, bare, ts, ts.deletedAt, out, now);
      // A copy left for later (a clarification written after the tombstone
      // was enforced, holding its question): the tombstone is due again, so
      // the sweep comes back for it, however long ago the change was.
      if (deferred) await db.deletedMessage.updateMany({ where: { chatId, waMessageId: bare }, data: { enforcedAt: null } }).catch(() => {});
      if (anyCleared(out)) {
        cleared++;
        console.log(
          `[message-change] ${chatId} ${bare}: a late copy of a deleted or edited message cleared (analyzed=${out.analyzed} archived=${out.archived} hq=${out.hq} mentions=${out.mentions} notes=${out.notes})`,
        );
      }
    }
    return cleared;
  } catch (err) {
    console.error(`[message-change] ${chatId}: deletes not enforced:`, err instanceof Error ? err.message : "failed");
    return 0;
  }
}

/**
 * A held "who do you mean?" question read after its hour is up (round 9):
 * its words are dropped there and then, where the analyze route reads the
 * open clarifications (the pipeline's loader writes nothing). The sweep
 * drops them too. One indexed read of the club's last two hours. Never throws.
 */
export async function dropExpiredHeldQuestions(orgId: string, now: Date = new Date()): Promise<number> {
  try {
    const { STATS_CLARIFICATION_INTENT } = await import("./pipeline/awaiting-answer");
    const rows = await db.analyzedMessage.findMany({
      where: { orgId, intent: STATS_CLARIFICATION_INTENT, body: null, createdAt: { gte: new Date(now.getTime() - 2 * 60 * 60 * 1000) } },
      select: { id: true, pipelineTrace: true },
    });
    let dropped = 0;
    for (const r of rows) {
      const held = heldQuestionOf(r.pipelineTrace);
      if (!held || held.until.getTime() > now.getTime()) continue;
      await db.analyzedMessage.update({ where: { id: r.id }, data: { pipelineTrace: (textFreeTrace(r.pipelineTrace) ?? { v: 1, extractions: [] }) as object } });
      dropped++;
    }
    return dropped;
  } catch (err) {
    console.error(`[message-change] ${orgId}: held questions not dropped:`, err instanceof Error ? err.message : "failed");
    return 0;
  }
}

/** How long after a change the sweep keeps re-checking it for late writers. */
export const SWEEP_RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * THE SAFETY SWEEP (hourly, /api/cron/bot-health). The tombstones never
 * enforced yet (`enforcedAt` null: a request that died before its own
 * clear), oldest first, then the ones changed in the last six hours again
 * (a late writer; by the LATEST change, so a second change is re-checked as
 * the first was), at most SWEEP_MAX a run, each marked enforced; then the
 * ones 14 days past their latest change pruned. A backlog is worked through run by
 * run. Idempotent; each message is a handful of indexed reads. Never throws.
 */
export async function sweepRecentTombstones(now: Date = new Date()): Promise<{ checked: number; cleared: number; pruned: number }> {
  try {
    const since = new Date(now.getTime() - WINDOW_MS);
    const pruned = (await db.deletedMessage.deleteMany({ where: { lastChangeAt: { lt: since } } })).count;
    const select = { chatId: true, waMessageId: true, byAdmin: true, reason: true, senderJids: true, senderPhones: true, changes: true, deletedAt: true } as const;
    const never = await db.deletedMessage.findMany({ where: { enforcedAt: null, lastChangeAt: { gte: since } }, orderBy: { lastChangeAt: "asc" }, take: SWEEP_MAX, select });
    const recent =
      never.length < SWEEP_MAX
        ? await db.deletedMessage.findMany({
            where: { enforcedAt: { not: null }, lastChangeAt: { gte: new Date(now.getTime() - SWEEP_RECHECK_MS) } },
            orderBy: { lastChangeAt: "desc" },
            take: SWEEP_MAX - never.length,
            select,
          })
        : [];
    const rows = [...never, ...recent];
    let cleared = 0;
    for (const r of rows) {
      // Per row: one tombstone that cannot be cleared (it is retried next
      // run, still unenforced) never stalls the ones behind it.
      try {
        const out = empty();
        const deferred = await clearMessage(r.chatId, r.waMessageId, { ...r, changes: (r.changes ?? []) as unknown as ChangeRecord[] }, r.deletedAt, out, now);
        if (anyCleared(out)) cleared++;
        // A copy left for later (an open clarification's question): not enforced yet, so the next run comes back.
        if (!deferred) await markEnforced(r.chatId, [r.waMessageId], now);
      } catch (err) {
        console.error(`[message-change] sweep: ${r.chatId} ${r.waMessageId} not cleared this run:`, err instanceof Error ? err.message : "failed");
      }
    }
    if (cleared > 0) console.log(`[message-change] sweep: ${cleared} of ${rows.length} deleted or edited message(s) had copies cleared`);
    return { checked: rows.length, cleared, pruned };
  } catch (err) {
    console.error("[message-change] sweep failed:", err instanceof Error ? err.message : "failed");
    return { checked: 0, cleared: 0, pruned: 0 };
  }
}
