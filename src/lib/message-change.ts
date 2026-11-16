/**
 * A GROUP MESSAGE DELETED FOR EVERYONE LEAVES MATCHTIME'S STORED CHAT, AND
 * AN EDIT REPLACES IT (2026-11-15, round 2 after two reviews).
 *
 * Until PR #606 the Pi dropped WhatsApp's delete and edit notices
 * (`protocolMessage`) as unreadable, so the words a member had taken back
 * stayed in every store below for up to a week, and any tagged question
 * could have them quoted back. The Pi now posts each one to
 * `/api/whatsapp/message-change` (and retries until it lands); this is what
 * that does. Housekeeping only: nothing here analyses, replies, reacts or
 * sends.
 *
 * THE TOMBSTONE (`DeletedMessage`). A delete is RECORDED before anything is
 * cleared, and the record is what makes a delete win in any order:
 *
 *   - every writer of a member's words writes, THEN calls `enforceDeletes`,
 *     which clears again whatever a delete applies to. The tombstone is
 *     committed before the clear starts, so either the clear sees the
 *     writer's row, or the writer's check sees the tombstone. Never neither;
 *   - the analyze and admin-group doors leave a deleted message out before
 *     reading anything (`deletedAmong`), and give a reply that quotes one no
 *     quote text, never the Pi's copy (`withoutDeletedQuotes`);
 *   - an edit that arrives after its delete (or is applied after it) changes
 *     nothing.
 *
 * WHO MAY DELETE: a group admin (the Pi reads it from the group's metadata,
 * `byAdmin`), or the message's own author, as WhatsApp's own clients allow.
 * A delete from anyone else is recorded (it can be checked again when the
 * message turns up) but applies to nothing; it is logged by ids only.
 *
 * THE STORES OF A MEMBER'S WORDS, and what an applying delete does to each
 * (one transaction per message, so a retry finds it whole or untouched):
 *
 *   AnalyzedMessage   body, reasoning, pipelineTrace set to null; the ROW
 *       stays as the analyze route's dedupe key. The players' group's week
 *       (open answer, unified answer, rating adjuster) and the extractors'
 *       recent chat already leave a null body out; so now does the open
 *       "who do you mean?" clarification (`awaiting-answer.ts`).
 *   GroupMessage      body "" (the row is the archive's dedupe key); the
 *       squad-from-list reader leaves an empty body out.
 *   AdminGroupMessage HQ's log (`<id>`) and the players' group's organiser
 *       lines (`group:<id>`): DELETED. The tombstone, not the row, is what
 *       stops a late write bringing it back.
 *   MessageMentions   deleted.
 *
 * AN EDIT, by the message's author only (anyone else's edit is ignored and
 * changes nothing): the new words, normalised as inbound text is (the
 * club's roster names every "@<digits>" it can; a token it cannot is never
 * stored as digits; 2,000 characters in AnalyzedMessage, 4,000 in the
 * archive, 500 in HQ's log), and the model's reading of the OLD words is
 * cleared with them (AnalyzedMessage reasoning and pipelineTrace, HQ's
 * pipelineTrace and hqOutcome), so the refused-ask retry, which reads the
 * trace, cannot repeat a request the edit took back. An edit that leaves no
 * text (a caption removed) clears the text. The mentions are left as they
 * were. An edit is never re-analysed.
 *
 * MATCHED BY WHATSAPP ID AND GROUP, NEVER BY TEXT: see `isStoredIdOf`.
 * DMs are not posted (no member's DM text is stored for a later answer).
 * Logs carry ids and counts, never the words.
 */
import { db } from "./db";
import { Prisma } from "@/generated/prisma/client";
// Types only, statically: the doors that import this module (the
// admin-group route among them) stay free of the pipeline's import graph
// (`admin-group-model-door.source.test.ts`); the naming is loaded when an
// edit is applied.
import type { MentionNameInput } from "./pipeline/mention-names";

export const DELETED_MESSAGE_RETENTION_DAYS = 14;
/** AnalyzedMessage's cut (`recordAnalysis`). */
export const MAX_ANALYZED_TEXT = 2000;
/** The archive's cut (`storeMessagesForSquadFromList`), and the most an edit carries. */
export const MAX_EDIT_TEXT = 4000;
/** HQ's log cut (`admin-group-log.ts`). */
const HQ_MAX_TEXT = 500;

/** A group JID: digits (and an old-style "-"), or a sandbox spelling; never "_" or a second "@". */
const GROUP_JID = /^[0-9A-Za-z-]{3,64}@g\.us$/;
/** A WhatsApp message id: letters, digits and a little punctuation, never '@' or a space. */
const MESSAGE_ID = /^[0-9A-Za-z._:-]{4,128}$/;
/** A canonical legacy JID, as the participant part of a stored id is spelled. */
const LEGACY_JID = /^[^@_:\s]+@[a-z]+(?:\.[a-z]+)*$/;
/** A raw mention token, as WhatsApp writes a tag into the text. */
const RAW_MENTION = /@\d{5,}/g;

interface Sender {
  senderJids: string[];
  senderPhone: string | null;
}

export type MessageChangeInput =
  | ({ kind: "revoke"; chatId: string; messageId: string; byAdmin: boolean } & Sender)
  | ({
      kind: "edit";
      chatId: string;
      messageId: string;
      /** "" when the edit left no text (a caption removed). */
      text: string;
      mentions?: string[];
      mentionNames?: MentionNameInput[];
    } & Sender);

export interface MessageChangeResult {
  /** AnalyzedMessage rows changed. */
  analyzed: number;
  /** GroupMessage (squad archive) rows changed. */
  archived: number;
  /** AdminGroupMessage rows changed or deleted. */
  hq: number;
  /** MessageMentions rows deleted. */
  mentions: number;
  /** Rows left alone: a delete or an edit by somebody who may not make it,
   *  or an edit of a message already deleted. */
  refused: number;
}

/** What a tombstone says about who deleted. */
export interface Tombstone {
  byAdmin: boolean;
  senderJids: string[];
  senderPhones: string[];
}

const digits = (v: unknown): string => (typeof v === "string" ? v.replace(/\D/g, "") : "");
const empty = (): MessageChangeResult => ({ analyzed: 0, archived: 0, hq: 0, mentions: 0, refused: 0 });

function senderOf(b: Record<string, unknown>): Sender {
  const senderJids = Array.isArray(b.senderJids)
    ? b.senderJids.filter((j): j is string => typeof j === "string" && LEGACY_JID.test(j)).slice(0, 8)
    : [];
  return { senderJids, senderPhone: digits(b.senderPhone) || null };
}

/** PURE. The Pi's body, or null when it is not a group message change. */
export function parseMessageChangeInput(body: unknown): MessageChangeInput | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const chatId = typeof b.chatId === "string" ? b.chatId.trim() : "";
  const messageId = typeof b.messageId === "string" ? b.messageId.trim() : "";
  if (!GROUP_JID.test(chatId) || !MESSAGE_ID.test(messageId)) return null;
  if (b.kind === "revoke") return { kind: "revoke", chatId, messageId, byAdmin: b.byAdmin === true, ...senderOf(b) };
  if (b.kind !== "edit" || typeof b.text !== "string") return null;
  const mentions = Array.isArray(b.mentions) ? b.mentions.filter((j): j is string => typeof j === "string").slice(0, 50) : [];
  const mentionNames = Array.isArray(b.mentionNames)
    ? (b.mentionNames as unknown[])
        .filter((m): m is MentionNameInput => !!m && typeof (m as { jid?: unknown }).jid === "string")
        .map((m) => ({ jid: m.jid, ...(typeof m.name === "string" ? { name: m.name } : {}), ...(typeof m.phone === "string" ? { phone: m.phone } : {}) }))
        .slice(0, 50)
    : [];
  return {
    kind: "edit",
    chatId,
    messageId,
    text: b.text.trim().slice(0, MAX_EDIT_TEXT),
    ...(mentions.length ? { mentions } : {}),
    ...(mentionNames.length ? { mentionNames } : {}),
    ...senderOf(b),
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

/** PURE. Does a recorded delete take this stored copy's words out? An admin's always; anyone else's only their own. */
export function deleteApplies(
  t: Tombstone,
  stored: { storedId: string; chatId: string; messageId: string; prefix?: string; storedPhone?: string | null },
): boolean {
  return t.byAdmin || isAuthorOf(stored, { jids: t.senderJids, phones: t.senderPhones });
}

/** PURE. An edit's words: "@<digits>" never stored as digits, then cut. */
export function scrubbedEditText(text: string, max: number): string {
  return text.replace(RAW_MENTION, "@someone").slice(0, max).trim();
}

// ── The stores ─────────────────────────────────────────────────────────

/** The models a transaction here touches (the extended client's own delegates). */
type Tx = Pick<typeof db, "analyzedMessage" | "groupMessage" | "adminGroupMessage" | "messageMentions" | "deletedMessage">;

function idWhere(chatId: string, messageId: string, opts: { prefix?: string; bare?: boolean } = {}) {
  const f = storedIdForms(chatId, messageId, opts.prefix ?? "");
  return [
    { waMessageId: { in: opts.bare ? [...f.exact, messageId] : f.exact } },
    ...f.prefixes.map((p) => ({ waMessageId: { startsWith: p } })),
  ];
}

interface Copies {
  analyzed: Array<{ id: string; waMessageId: string; orgId: string; authorPhone: string | null }>;
  archived: Array<{ id: string; waMessageId: string; orgId: string; senderPhone: string | null }>;
  hq: Array<{ id: string; waMessageId: string; orgId: string; prefix: string }>;
  mentions: Array<{ id: string; waMessageId: string }>;
}

/** Every stored copy of one group message, each checked exactly. */
async function copiesOf(tx: Tx, chatId: string, messageId: string): Promise<Copies> {
  const analyzed = (
    await tx.analyzedMessage.findMany({
      where: { groupId: chatId, OR: idWhere(chatId, messageId, { bare: true }) },
      select: { id: true, waMessageId: true, orgId: true, authorPhone: true },
    })
  ).filter((r) => isStoredIdOf(r.waMessageId, chatId, messageId, { bare: true }));
  const archived = (
    await tx.groupMessage.findMany({
      where: { OR: [...idWhere(chatId, messageId), { waChatId: chatId, waMessageId: messageId }] },
      select: { id: true, waMessageId: true, orgId: true, waChatId: true, senderPhone: true },
    })
  ).filter((r) => isStoredIdOf(r.waMessageId, chatId, messageId, { bare: r.waChatId === chatId }));
  const hq = (
    await tx.adminGroupMessage.findMany({
      where: { fromMatchTime: false, OR: [...idWhere(chatId, messageId), ...idWhere(chatId, messageId, { prefix: "group:" })] },
      select: { id: true, waMessageId: true, orgId: true },
    })
  )
    .map((r) => ({ ...r, prefix: r.waMessageId.startsWith("group:") ? "group:" : "" }))
    .filter((r) => r.waMessageId !== messageId && isStoredIdOf(r.waMessageId, chatId, messageId, { prefix: r.prefix }));
  const mentions = (
    await tx.messageMentions.findMany({
      where: { chatId, OR: idWhere(chatId, messageId, { bare: true }) },
      select: { id: true, waMessageId: true },
    })
  ).filter((r) => isStoredIdOf(r.waMessageId, chatId, messageId, { bare: true }));
  return { analyzed, archived, hq, mentions };
}

/** Take the words out of every copy a delete applies to. Inside the caller's transaction. */
async function clearCopies(tx: Tx, chatId: string, messageId: string, t: Tombstone, c: Copies, out: MessageChangeResult): Promise<void> {
  const applies = (storedId: string, storedPhone?: string | null, prefix = "") => deleteApplies(t, { storedId, chatId, messageId, prefix, storedPhone });
  for (const r of c.analyzed) {
    if (!applies(r.waMessageId, r.authorPhone)) {
      out.refused++;
      continue;
    }
    await tx.analyzedMessage.update({ where: { id: r.id }, data: { body: null, reasoning: null, pipelineTrace: Prisma.DbNull } });
    out.analyzed++;
  }
  for (const r of c.archived) {
    if (!applies(r.waMessageId, r.senderPhone)) {
      out.refused++;
      continue;
    }
    await tx.groupMessage.update({ where: { id: r.id }, data: { body: "" } });
    out.archived++;
  }
  const hqGone = c.hq.filter((r) => applies(r.waMessageId, null, r.prefix)).map((r) => r.id);
  out.refused += c.hq.length - hqGone.length;
  if (hqGone.length) out.hq += (await tx.adminGroupMessage.deleteMany({ where: { id: { in: hqGone } } })).count;
  // Who a message tagged has no author column: the message's own row (or
  // the delete's admin) decides, through the analysed or HQ copy.
  const authorised = t.byAdmin || c.analyzed.some((r) => applies(r.waMessageId, r.authorPhone)) || c.hq.some((r) => applies(r.waMessageId, null, r.prefix)) || c.mentions.some((r) => applies(r.waMessageId));
  if (authorised && c.mentions.length) out.mentions += (await tx.messageMentions.deleteMany({ where: { id: { in: c.mentions.map((r) => r.id) } } })).count;
}

/** The recorded delete of one message, merged with any earlier one. Its own statement, committed before any clear. */
async function recordTombstone(input: { chatId: string; messageId: string; byAdmin: boolean } & Sender, now: Date): Promise<Tombstone> {
  const where = { chatId_waMessageId: { chatId: input.chatId, waMessageId: input.messageId } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await db.deletedMessage.findUnique({ where, select: { byAdmin: true, senderJids: true, senderPhones: true } });
    const next: Tombstone = {
      byAdmin: (cur?.byAdmin ?? false) || input.byAdmin,
      senderJids: [...new Set([...(cur?.senderJids ?? []), ...input.senderJids])],
      senderPhones: [...new Set([...(cur?.senderPhones ?? []), ...(input.senderPhone ? [input.senderPhone] : [])])],
    };
    try {
      if (cur) await db.deletedMessage.update({ where, data: next });
      else await db.deletedMessage.create({ data: { chatId: input.chatId, waMessageId: input.messageId, ...next, deletedAt: now } });
      return next;
    } catch (err) {
      // Two deletes of one message at once: the other created it; merge into it.
      if (attempt === 0 && (err as { code?: string })?.code === "P2002") continue;
      throw err;
    }
  }
  throw new Error("tombstone not recorded");
}

async function pruneTombstones(now: Date): Promise<void> {
  await db.deletedMessage
    .deleteMany({ where: { deletedAt: { lt: new Date(now.getTime() - DELETED_MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000) } } })
    .catch(() => {});
}

/** The club roster's names for an edit's "@<digits>" tokens, as the analyze door names inbound ones. Best-effort. */
async function namedEditText(orgId: string, input: Extract<MessageChangeInput, { kind: "edit" }>): Promise<string> {
  if (!input.text || !input.mentions?.length || !new RegExp(RAW_MENTION.source).test(input.text)) return input.text;
  try {
    const [members, aliases] = await Promise.all([
      db.membership.findMany({ where: { orgId }, select: { user: { select: { id: true, name: true, phoneNumber: true } } } }),
      db.userAlias.findMany({ where: { orgId }, select: { alias: true, userId: true } }),
    ]);
    const knownLids = await import("./known-lids").then((m) => m.loadKnownLids(orgId)).catch(() => []);
    const { nameMentions } = await import("./pipeline/mention-names");
    const roster = members
      .map((m) => m.user)
      .filter((u) => !!u?.name)
      .map((u) => ({ userId: u.id, name: u.name as string, phone: u.phoneNumber }));
    const [named] = await nameMentions({
      messages: [{ body: input.text, mentions: input.mentions, mentionNames: input.mentionNames }],
      roster,
      aliases,
      knownLids,
      where: "the club's WhatsApp group",
    });
    return named?.body ?? input.text;
  } catch {
    return input.text;
  }
}

/**
 * Apply a delete or an edit to every store. Idempotent: a retry finds the
 * same rows already changed, or none. Throws only on a database failure,
 * which the route turns into a 500 the Pi retries.
 */
export async function applyMessageChange(input: MessageChangeInput, now: Date = new Date()): Promise<MessageChangeResult> {
  const { chatId, messageId } = input;
  const out = empty();

  if (input.kind === "revoke") {
    const t = await recordTombstone(input, now);
    await db.$transaction(async (tx) => clearCopies(tx, chatId, messageId, t, await copiesOf(tx, chatId, messageId), out));
    await pruneTombstones(now);
    return out;
  }

  // An edit: its text named per club before the transaction (a read).
  const named = new Map<string, string>();
  await db.$transaction(async (tx) => {
    const t = await tx.deletedMessage.findUnique({
      where: { chatId_waMessageId: { chatId, waMessageId: messageId } },
      select: { byAdmin: true, senderJids: true, senderPhones: true },
    });
    const c = await copiesOf(tx, chatId, messageId);
    const sender = { jids: input.senderJids, phones: input.senderPhone ? [input.senderPhone] : [] };
    const author = (storedId: string, storedPhone?: string | null, prefix = "") => isAuthorOf({ storedId, chatId, messageId, prefix, storedPhone }, sender);
    const deleted = (storedId: string, storedPhone?: string | null, prefix = "") =>
      !!t && deleteApplies(t, { storedId, chatId, messageId, prefix, storedPhone });
    for (const orgId of new Set([...c.analyzed, ...c.archived, ...c.hq].map((r) => r.orgId))) {
      if (!named.has(orgId)) named.set(orgId, await namedEditText(orgId, input));
    }
    const words = (orgId: string, max: number) => scrubbedEditText(named.get(orgId) ?? input.text, max);

    for (const r of c.analyzed) {
      if (deleted(r.waMessageId, r.authorPhone) || !author(r.waMessageId, r.authorPhone)) {
        out.refused++;
        continue;
      }
      const text = words(r.orgId, MAX_ANALYZED_TEXT);
      await tx.analyzedMessage.update({ where: { id: r.id }, data: { body: text || null, reasoning: null, pipelineTrace: Prisma.DbNull } });
      out.analyzed++;
    }
    for (const r of c.archived) {
      if (deleted(r.waMessageId, r.senderPhone) || !author(r.waMessageId, r.senderPhone)) {
        out.refused++;
        continue;
      }
      await tx.groupMessage.update({ where: { id: r.id }, data: { body: words(r.orgId, MAX_EDIT_TEXT) } });
      out.archived++;
    }
    for (const r of c.hq) {
      if (deleted(r.waMessageId, null, r.prefix) || !author(r.waMessageId, null, r.prefix)) {
        out.refused++;
        continue;
      }
      await tx.adminGroupMessage.update({ where: { id: r.id }, data: { text: words(r.orgId, HQ_MAX_TEXT), pipelineTrace: Prisma.DbNull, hqOutcome: null } });
      out.hq++;
    }
  });
  return out;
}

// ── For the writers and the doors ──────────────────────────────────────

/** The tombstones of these bare ids in one chat. Best-effort: none on any failure (a missing table). */
async function tombstonesFor(chatId: string, bareIds: string[]): Promise<Map<string, Tombstone>> {
  const ids = [...new Set(bareIds)].filter(Boolean);
  if (ids.length === 0) return new Map();
  try {
    const rows = await db.deletedMessage.findMany({
      where: { chatId, waMessageId: { in: ids } },
      select: { waMessageId: true, byAdmin: true, senderJids: true, senderPhones: true },
    });
    return new Map(rows.map((r) => [r.waMessageId, { byAdmin: r.byAdmin, senderJids: r.senderJids, senderPhones: r.senderPhones }]));
  } catch {
    return new Map();
  }
}

/**
 * The messages of a batch a recorded delete applies to (by their stored
 * ids), so a door leaves them out before reading anything. Best-effort.
 */
export async function deletedAmong(chatId: string, items: Array<{ id: string; authorPhone?: string | null }>): Promise<Set<string>> {
  const withBare = items.map((i) => ({ ...i, bare: bareIdOf(i.id) })).filter((i): i is typeof i & { bare: string } => !!i.bare);
  const t = await tombstonesFor(chatId, withBare.map((i) => i.bare));
  const out = new Set<string>();
  for (const i of withBare) {
    const ts = t.get(i.bare);
    if (ts && deleteApplies(ts, { storedId: i.id, chatId, messageId: i.bare, storedPhone: i.authorPhone ?? null })) out.add(i.id);
  }
  return out;
}

/**
 * A reply quoting a deleted message carries no quote text: never the Pi's
 * copy. A delete of the quoted message by somebody who may not make it
 * leaves the quote; one whose author is unknown here takes it out (the
 * quote is context, and words taken back are not). Best-effort.
 */
export async function withoutDeletedQuotes<T extends { quotedMessageId?: string | null; quotedAuthorPhone?: string | null }>(
  chatId: string,
  messages: T[],
  textField: keyof T,
): Promise<T[]> {
  const quoted = messages.filter((m) => typeof m.quotedMessageId === "string" && m.quotedMessageId);
  if (quoted.length === 0) return messages;
  const t = await tombstonesFor(chatId, quoted.map((m) => bareIdOf(m.quotedMessageId as string) ?? ""));
  if (t.size === 0) return messages;
  return messages.map((m) => {
    const bare = typeof m.quotedMessageId === "string" ? bareIdOf(m.quotedMessageId) : null;
    const ts = bare ? t.get(bare) : undefined;
    if (!ts || !bare) return m;
    const phone = digits(m.quotedAuthorPhone);
    const applies = !phone || deleteApplies(ts, { storedId: m.quotedMessageId as string, chatId, messageId: bare, storedPhone: phone });
    if (!applies) return m;
    const copy = { ...m };
    delete copy[textField];
    return copy;
  });
}

/**
 * AFTER a writer has written: clear again every message of `storedIds` a
 * recorded delete applies to. With the tombstone committed before every
 * delete's own clear, this closes the race where a message is written while
 * its delete runs. Never throws; returns how many messages it cleared.
 */
export async function enforceDeletes(chatId: string, storedIds: Array<string | null | undefined>): Promise<number> {
  try {
    const bares = [...new Set(storedIds.map((id) => (id ? bareIdOf(id) : null)).filter((b): b is string => !!b))];
    const t = await tombstonesFor(chatId, bares);
    let cleared = 0;
    for (const [bare, ts] of t) {
      const out = empty();
      await db.$transaction(async (tx) => clearCopies(tx, chatId, bare, ts, await copiesOf(tx, chatId, bare), out));
      if (out.analyzed + out.archived + out.hq + out.mentions > 0) {
        cleared++;
        console.log(`[message-change] ${chatId} ${bare}: a late copy of a deleted message cleared (analyzed=${out.analyzed} archived=${out.archived} hq=${out.hq} mentions=${out.mentions})`);
      }
    }
    return cleared;
  } catch (err) {
    console.error(`[message-change] ${chatId}: deletes not enforced:`, err instanceof Error ? err.message : "failed");
    return 0;
  }
}
