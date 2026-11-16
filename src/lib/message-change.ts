/**
 * A GROUP MESSAGE DELETED FOR EVERYONE LEAVES MATCHTIME'S STORED CHAT, AND
 * AN EDIT REPLACES IT (2026-11-15).
 *
 * Until today the Pi dropped WhatsApp's delete and edit notices
 * (`protocolMessage`) as unreadable, so the words a member had taken back
 * stayed in every store below for up to a week, and any tagged question
 * could have them quoted back. The Pi now posts each one to
 * `/api/whatsapp/message-change`; this is what that does. Housekeeping
 * only: nothing here analyses, replies, reacts or sends.
 *
 * THE STORES OF A MEMBER'S WORDS, and what a delete does to each:
 *
 *   AnalyzedMessage.body (+ reasoning, pipelineTrace)   the players' group's
 *       week (open answer, unified answer, rating adjuster) and the
 *       extractors' recent chat. The ROW STAYS with its words set to null:
 *       its `waMessageId` is the analyze route's dedupe key, so a replay of
 *       the same message after a restart is never analysed again. The
 *       readers already leave out a null body. `reasoning` and the trace
 *       are the model's account of the words (the refused-ask retry reads
 *       the trace), so they go too.
 *   GroupMessage.body   the squad-from-list archive a model reads. The row
 *       stays as the archive's dedupe key, with an empty body, which the
 *       archive's reader leaves out.
 *   AdminGroupMessage   HQ's log (`<id>`) and the players' group's organiser
 *       lines (`group:<id>`). The row is DELETED: nothing dedupes on it, and
 *       a deleted message must not count as "somebody else talking" for the
 *       safe-YES rule either.
 *   MessageMentions     who the message tagged ("the people above"). Deleted.
 *
 * An EDIT puts the new words where the old ones were (HQ's copy cut to its
 * 500 characters, as `recordHqMessage` does). It is applied only when the
 * edit's sender is the stored message's author (the participant in the
 * stored id, or the stored phone): WhatsApp lets only the author edit, and
 * a forged edit must never put words in somebody's mouth. A sender we
 * cannot tie to the author gets the old words REMOVED instead, as a delete
 * would: never the forged text, and never the words they replaced. An edit
 * is not re-analysed, and its mentions are left as they were.
 *
 * MATCHED BY WHATSAPP ID AND GROUP, NEVER BY TEXT. A stored id is the
 * whatsapp-web.js string the Pi has always sent (`whatsapp-bot/src/baileys/
 * key.ts`): `<fromMe>_<group>_<id>` or `<fromMe>_<group>_<id>_<participant>`.
 * The Pi sends the bare id, because a delete by a group admin names the
 * ADMIN as its sender, so the participant cannot be rebuilt from it. The
 * database is asked for the candidates (an `in` and a `startsWith`), and
 * each row is then checked exactly here (`isStoredIdOf`), so another
 * group's message with the same id, or a longer id, is never touched.
 *
 * DMs are not posted: a member's DM text is not stored anywhere a later
 * answer reads (the DM context is MatchTime's own DMs), see the PR.
 *
 * Logs carry ids and counts, never the words.
 */
import { db } from "./db";
import { Prisma } from "@/generated/prisma/client";

/** The archive's cut (`storeMessagesForSquadFromList`) and the largest edit we keep. */
export const MAX_EDIT_TEXT = 4000;
/** HQ's log cut (`admin-group-log.ts`). */
const HQ_MAX_TEXT = 500;

/** A group JID: digits (and an old-style "-"), or a sandbox spelling; never "_" or a second "@". */
const GROUP_JID = /^[0-9A-Za-z-]{3,64}@g\.us$/;
/** A WhatsApp message id: letters, digits and a little punctuation, never '@' or a space. */
const MESSAGE_ID = /^[0-9A-Za-z._:-]{4,128}$/;
/** A canonical legacy JID, as the participant part of a stored id is spelled. */
const LEGACY_JID = /^[^@_:\s]+@[a-z]+(?:\.[a-z]+)*$/;

export type MessageChangeInput =
  | { kind: "revoke"; chatId: string; messageId: string }
  | { kind: "edit"; chatId: string; messageId: string; text: string; senderJids?: string[]; senderPhone?: string | null };

export interface MessageChangeResult {
  /** AnalyzedMessage rows changed. */
  analyzed: number;
  /** GroupMessage (squad archive) rows changed. */
  archived: number;
  /** AdminGroupMessage rows changed or deleted. */
  hq: number;
  /** MessageMentions rows deleted. */
  mentions: number;
  /** Rows whose edit was not the author's, so their words were removed instead. */
  editsRefused: number;
}

const digits = (v: unknown): string => (typeof v === "string" ? v.replace(/\D/g, "") : "");

/** PURE. The Pi's body, or null when it is not a group message change. */
export function parseMessageChangeInput(body: unknown): MessageChangeInput | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const chatId = typeof b.chatId === "string" ? b.chatId.trim() : "";
  const messageId = typeof b.messageId === "string" ? b.messageId.trim() : "";
  if (!GROUP_JID.test(chatId) || !MESSAGE_ID.test(messageId)) return null;
  if (b.kind === "revoke") return { kind: "revoke", chatId, messageId };
  if (b.kind !== "edit") return null;
  const text = typeof b.text === "string" ? b.text.trim().slice(0, MAX_EDIT_TEXT) : "";
  if (!text) return null;
  const senderJids = Array.isArray(b.senderJids)
    ? b.senderJids.filter((j): j is string => typeof j === "string" && LEGACY_JID.test(j))
    : [];
  const phone = digits(b.senderPhone);
  return { kind: "edit", chatId, messageId, text, senderJids, senderPhone: phone || null };
}

/** PURE. The stored ids that can be this message: exact, and the participant prefixes. */
export function storedIdForms(chatId: string, messageId: string, prefix = ""): { exact: string[]; prefixes: string[] } {
  const bases = ["false", "true"].map((fromMe) => `${prefix}${fromMe}_${chatId}_${messageId}`);
  return { exact: bases, prefixes: bases.map((b) => `${b}_`) };
}

/** PURE. The participant of a stored id of this message, or null (none, or not this message). */
function participantPart(storedId: string, chatId: string, messageId: string, prefix = ""): string | null | undefined {
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
  if (opts.bare && storedId === messageId) return true;
  return participantPart(storedId, chatId, messageId, opts.prefix ?? "") !== undefined;
}

/**
 * PURE. Is the edit's sender the stored message's author? The participant
 * in the stored id is one of the sender's JIDs (phone or LID spelling), or
 * the stored phone is the sender's phone. Nothing to compare is "no".
 */
export function editIsByAuthor(
  stored: { storedId: string; chatId: string; messageId: string; prefix?: string; storedPhone?: string | null },
  sender: { jids: string[]; phone: string | null },
): boolean {
  const participant = participantPart(stored.storedId, stored.chatId, stored.messageId, stored.prefix ?? "");
  if (participant && sender.jids.includes(participant)) return true;
  const phone = digits(sender.phone);
  if (!phone) return false;
  if (participant && participant.endsWith("@c.us") && digits(participant.split("@")[0]) === phone) return true;
  return digits(stored.storedPhone) === phone;
}

function idWhere(chatId: string, messageId: string, opts: { prefix?: string; bare?: boolean } = {}) {
  const f = storedIdForms(chatId, messageId, opts.prefix ?? "");
  return [
    { waMessageId: { in: opts.bare ? [...f.exact, messageId] : f.exact } },
    ...f.prefixes.map((p) => ({ waMessageId: { startsWith: p } })),
  ];
}

/**
 * Apply a delete or an edit to every store. Idempotent: a second delete
 * finds the same rows already empty, or none. Throws only on a database
 * failure, which the route turns into a 500 the Pi logs.
 */
export async function applyMessageChange(input: MessageChangeInput): Promise<MessageChangeResult> {
  const { chatId, messageId } = input;
  const out: MessageChangeResult = { analyzed: 0, archived: 0, hq: 0, mentions: 0, editsRefused: 0 };
  const sender = input.kind === "edit" ? { jids: input.senderJids ?? [], phone: input.senderPhone ?? null } : null;
  const byAuthor = (storedId: string, storedPhone?: string | null, prefix = ""): boolean =>
    !!sender && editIsByAuthor({ storedId, chatId, messageId, prefix, storedPhone }, sender);

  // 1. The players' group's analysed messages (and any row this group's id names).
  const analyzed = (
    await db.analyzedMessage.findMany({
      where: { groupId: chatId, OR: idWhere(chatId, messageId, { bare: true }) },
      select: { id: true, waMessageId: true, authorPhone: true },
    })
  ).filter((r) => isStoredIdOf(r.waMessageId, chatId, messageId, { bare: true }));
  for (const r of analyzed) {
    const edit = input.kind === "edit" && byAuthor(r.waMessageId, r.authorPhone);
    if (input.kind === "edit" && !edit) out.editsRefused++;
    await db.analyzedMessage.update({
      where: { id: r.id },
      data: edit ? { body: input.text } : { body: null, reasoning: null, pipelineTrace: Prisma.DbNull },
    });
    out.analyzed++;
  }

  // 2. The squad-from-list archive.
  const archived = (
    await db.groupMessage.findMany({
      where: { OR: [...idWhere(chatId, messageId), { waChatId: chatId, waMessageId: messageId }] },
      select: { id: true, waMessageId: true, waChatId: true, senderPhone: true },
    })
  ).filter((r) => isStoredIdOf(r.waMessageId, chatId, messageId, { bare: r.waChatId === chatId }));
  for (const r of archived) {
    const edit = input.kind === "edit" && byAuthor(r.waMessageId, r.senderPhone);
    if (input.kind === "edit" && !edit) out.editsRefused++;
    await db.groupMessage.update({ where: { id: r.id }, data: { body: edit ? input.text.slice(0, MAX_EDIT_TEXT) : "" } });
    out.archived++;
  }

  // 3. HQ's log and the players' group's organiser lines kept beside it.
  const hq = (
    await db.adminGroupMessage.findMany({
      where: { fromMatchTime: false, OR: [...idWhere(chatId, messageId), ...idWhere(chatId, messageId, { prefix: "group:" })] },
      select: { id: true, waMessageId: true },
    })
  )
    .map((r) => ({ ...r, prefix: r.waMessageId.startsWith("group:") ? "group:" : "" }))
    .filter((r) => isStoredIdOf(r.waMessageId, chatId, messageId, { prefix: r.prefix }));
  const hqGone: string[] = [];
  for (const r of hq) {
    const edit = input.kind === "edit" && byAuthor(r.waMessageId, null, r.prefix);
    if (input.kind === "edit" && !edit) out.editsRefused++;
    if (edit) await db.adminGroupMessage.update({ where: { id: r.id }, data: { text: input.text.slice(0, HQ_MAX_TEXT) } });
    else hqGone.push(r.id);
    out.hq++;
  }
  if (hqGone.length) await db.adminGroupMessage.deleteMany({ where: { id: { in: hqGone } } });

  // 4. Who it tagged: gone with a delete, left alone by an edit.
  if (input.kind === "revoke") {
    const tagged = (
      await db.messageMentions.findMany({
        where: { chatId, OR: idWhere(chatId, messageId, { bare: true }) },
        select: { id: true, waMessageId: true },
      })
    ).filter((r) => isStoredIdOf(r.waMessageId, chatId, messageId, { bare: true }));
    if (tagged.length) {
      out.mentions = (await db.messageMentions.deleteMany({ where: { id: { in: tagged.map((r) => r.id) } } })).count;
    }
  }

  return out;
}
