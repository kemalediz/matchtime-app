/**
 * A MESSAGE DELETED FOR EVERYONE, OR EDITED: HOUSEKEEPING ONLY (2026-11-15,
 * round 2 after two reviews).
 *
 * The driver hands the change up (`onMessageChange`, read off WhatsApp's
 * protocol message by `baileys/message-change.ts`). Until PR #606 it was
 * dropped as unreadable, so MatchTime kept the words a member had taken
 * back and could quote them to anybody who asked within the week.
 *
 * For any group, in this order:
 *
 *   1. the Pi's OWN record and copies (`smart-analysis.ts`
 *      `applyMessageChangeLocally`): the batch still waiting to be analysed,
 *      the recent chat sent with it, the quotes of replies waiting in it,
 *      and the record every later copy is held to (a replay, a requeue, an
 *      admin-group forward, the react and reply step). FIRST and for every
 *      group: right after a restart the org list may not have loaded, and a
 *      delete that waited for it would be forgotten;
 *   2. the durable outbox (`message-change-outbox.ts`), before any post;
 *   3. a running analysis of that group allowed to end (bounded);
 *   4. one post to `/api/whatsapp/message-change`; a failure is left to the
 *      outbox's retries with backoff, across restarts.
 *
 * WHO MAY DELETE: a group admin (`byAdmin`, from the group's metadata), or
 * the message's own author. WHO MAY EDIT: the author only; anyone else's
 * edit changes nothing. Both are decided against each stored copy here and
 * on the server, never trusted from the notice alone.
 *
 * AN EDIT is read from its new content exactly as an inbound message is
 * (`readGroupMessageForServer`: the bot's own tag found, mentions named
 * from the contacts), so the batch, the recent chat and the server all get
 * the same words, mentions and tag. An edit that left no text clears it.
 *
 * NOTHING HERE SENDS, REPLIES, REACTS OR ANALYSES: its only effects are the
 * injected ones. A DM is not posted: the server keeps no member's DM text
 * for a later answer (the DM context is MatchTime's own DMs).
 *
 * Logs carry ids and counts, never the words.
 */
import type { InboundMessage, MessageChangeEvent } from "./driver.js";
import type { MessageChangeBody } from "./api.js";
import { legacyJid, parseKey } from "./baileys/key.js";

/** A change, as the Pi's own record and the outbox keep it. */
export interface LocalMessageChange {
  kind: "revoke" | "edit";
  groupId: string;
  /** The BARE WhatsApp id of the message deleted or edited. */
  messageId: string;
  senderJids: string[];
  senderPhone: string | null;
  /** The sender is an admin of the group (a delete may then take anyone's message). */
  byAdmin: boolean;
  /** An edit's words, read as inbound text is; "" when it left none. */
  text?: string;
  mentions?: string[];
  mentionNames?: Array<{ jid: string; name?: string; phone?: string }>;
  botMentioned?: boolean;
}

/** An edit's new content, read as an inbound message is. */
export interface ReadEdit {
  text: string;
  mentions?: string[];
  mentionNames?: Array<{ jid: string; name?: string; phone?: string }>;
  botMentioned: boolean;
}

/** A WhatsApp message id: never '@', never a space. */
const PLAUSIBLE_ID = /^[0-9A-Za-z._:-]{4,128}$/;

/** PURE. The bare WhatsApp id inside a stored id, or the id itself when it is already bare. */
export function bareOf(id: string | null | undefined): string | null {
  if (typeof id !== "string" || !id || id.startsWith("synthetic:")) return null;
  const key = parseKey(id);
  if (key) return key.id;
  return PLAUSIBLE_ID.test(id) ? id : null;
}

/** PURE. Does a stored whatsapp-web.js id name this group's message? */
export function isIdOfMessage(storedId: string, chatId: string, messageId: string): boolean {
  const key = parseKey(storedId);
  return !!key && legacyJid(key.remoteJid) === chatId && key.id === messageId;
}

/** PURE. A stored id, or a quote's bare id, naming this group's message. */
export function namesMessage(id: string | null | undefined, chatId: string, messageId: string): boolean {
  if (typeof id !== "string" || !id) return false;
  return id === messageId || isIdOfMessage(id, chatId, messageId);
}

/**
 * PURE. Is somebody the author of the stored message? Its id's participant
 * is one of their spellings, or the stored phone is theirs. The server
 * applies the same rule.
 */
export function isByAuthor(
  storedId: string,
  storedPhone: string | null | undefined,
  who: { senderJids: string[]; senderPhone: string | null },
): boolean {
  const participant = legacyJid(parseKey(storedId)?.participant ?? null);
  if (participant && who.senderJids.includes(participant)) return true;
  const phone = (who.senderPhone ?? "").replace(/\D/g, "");
  if (!phone) return false;
  if (participant?.endsWith("@c.us") && participant.split("@")[0] === phone) return true;
  return (storedPhone ?? "").replace(/\D/g, "") === phone;
}

/** PURE. Does a delete take this copy's words out? An admin's always; anyone else's only their own. */
export function deleteApplies(change: LocalMessageChange, storedId: string, storedPhone: string | null | undefined): boolean {
  return change.byAdmin || isByAuthor(storedId, storedPhone, change);
}

/** PURE. The server's body for a change. */
export function bodyForServer(c: LocalMessageChange): MessageChangeBody {
  if (c.kind === "revoke") {
    return { kind: "revoke", chatId: c.groupId, messageId: c.messageId, byAdmin: c.byAdmin, senderJids: c.senderJids, senderPhone: c.senderPhone };
  }
  return {
    kind: "edit",
    chatId: c.groupId,
    messageId: c.messageId,
    text: c.text ?? "",
    ...(c.mentions?.length ? { mentions: c.mentions } : {}),
    ...(c.mentionNames?.length ? { mentionNames: c.mentionNames } : {}),
    senderJids: c.senderJids,
    senderPhone: c.senderPhone,
  };
}

export interface MessageChangeDeps {
  applyLocally(change: LocalMessageChange): { buffered: number; history: number; quotes: number };
  /** An edit's new content read as inbound text is (`readGroupMessageForServer`). */
  readEdit(view: InboundMessage): Promise<ReadEdit | null>;
  /** Into the durable outbox; returns its key. */
  record(change: LocalMessageChange): string;
  /** One post; true when the server took it. */
  attempt(key: string): Promise<boolean>;
  /** True when no analysis of the group is running; false on its timeout. */
  whenFlushIdle(groupId: string): Promise<boolean>;
  log(line: string): void;
  error(line: string): void;
}

export type MessageChangeOutcome = "posted" | "queued" | "dm";

/** Never throws. */
export async function handleMessageChange(change: MessageChangeEvent, deps: MessageChangeDeps): Promise<MessageChangeOutcome> {
  const what = change.kind === "revoke" ? "delete for everyone" : "edit";
  const tag = `[message-change] ${what} of ${change.messageId} in ${change.chatId}`;
  if (!change.isGroup) {
    deps.log(`${tag}: a DM; MatchTime keeps no DM text for later answers, nothing to change`);
    return "dm";
  }
  let local: LocalMessageChange = {
    kind: change.kind,
    groupId: change.chatId,
    messageId: change.messageId,
    senderJids: change.senderJids,
    senderPhone: change.senderPhone,
    byAdmin: change.byAdmin === true,
  };
  if (change.kind === "edit") {
    let read: ReadEdit | null = null;
    if (change.edited && change.text) {
      try {
        read = await deps.readEdit(change.edited);
      } catch {
        read = null;
      }
    }
    local = read
      ? {
          ...local,
          text: read.text,
          botMentioned: read.botMentioned,
          ...(read.mentions?.length ? { mentions: read.mentions } : {}),
          ...(read.mentionNames?.length ? { mentionNames: read.mentionNames } : {}),
        }
      : { ...local, text: change.text ?? "", botMentioned: false };
  }
  try {
    const counts = deps.applyLocally(local);
    const key = deps.record(local);
    const idle = await deps.whenFlushIdle(change.chatId);
    if (!idle) deps.log(`${tag}: an analysis of this group is still running; posting anyway`);
    let taken = false;
    try {
      taken = await deps.attempt(key);
    } catch {
      taken = false;
    }
    const where = `batch=${counts.buffered} recent=${counts.history} quotes=${counts.quotes}`;
    if (!taken) {
      deps.error(`${tag}: not taken by the server yet (${where}); queued, retried with backoff`);
      return "queued";
    }
    deps.log(`${tag}: ${where}; taken by the server`);
    return "posted";
  } catch (err) {
    deps.error(`${tag}: ${err instanceof Error ? err.message : "failed"}; queued`);
    return "queued";
  }
}
