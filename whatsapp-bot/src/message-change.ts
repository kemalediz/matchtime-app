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
 * AN EDIT, ONE RULE (round 5), whatever order things arrive in, and never
 * judging whether the message was "already analysed":
 *
 *   (a) it is ALWAYS recorded here and posted as an "edited" tombstone (no
 *       words): the server purges every stored copy of the message's text,
 *       including after any later write, and strips quotes of it;
 *   (b) its new content (read exactly as an inbound message is,
 *       `readGroupMessageForServer`: body, mentions, mention names, the
 *       bot's tag) REPLACES any copy waiting in the batch, a requeued one
 *       after a failed post included, so the message is analysed once, with
 *       its edited words; an edit that adds the tag is flushed at once, as
 *       a tagged message is;
 *   (c) the content is kept IN MEMORY ONLY for 30 minutes, keyed by id, so
 *       an original that arrives after its edit (a held picture, content
 *       that failed to decrypt first) is queued with the edited content;
 *   (d) a merged edit (Baileys folds it into the original after a
 *       reconnect) is the same: the original carries it, the notice behind
 *       it is (a) plus (b), and applying the same content twice changes
 *       nothing;
 *   (f) of two edits, the later by the edit's OWN time wins, never by
 *       arrival or by when its reading finished.
 *
 * The outbox and the tombstone never hold a word of any message.
 *
 * WHO: a delete from a group admin (`byAdmin`, from the group's metadata)
 * or the message's own author; an edit from its author only. Anything else
 * changes nothing. Decided against each stored copy here and on the
 * server, never trusted from the notice alone. When the group's admins
 * could not be read, the delete is kept as `adminUnknown` and the outbox
 * checks again on its retries; it applies to the sender's own messages
 * meanwhile, and to others' only once the sender is known to be an admin.
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
  /** The sender is an admin of the group (a delete may then take anyone's message). Never for an edit. */
  byAdmin: boolean;
  /** Whether the sender is an admin could not be read yet: checked again by the outbox. */
  adminUnknown?: boolean;
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
  return { kind: "edit", chatId: c.groupId, messageId: c.messageId, senderJids: c.senderJids, senderPhone: c.senderPhone };
}

/** An edit's new content, read as an inbound message is. In memory only. */
export interface ReadEdit {
  text: string;
  botMentioned: boolean;
  mentions?: string[];
  mentionNames?: Array<{ jid: string; name?: string; phone?: string }>;
}

export interface MessageChangeDeps {
  /** An edit's new content read exactly as an inbound message is. */
  readEdit(view: InboundMessage): Promise<ReadEdit | null>;
  /**
   * Keep an author's edit (in memory, the latest by `editedAtMs`) and put it
   * in place of any copy waiting in the batch. `tagAdded`: the edit tags
   * MatchTime where the waiting copy did not.
   */
  replacePending(change: LocalMessageChange, read: ReadEdit, editedAtMs: number): { replaced: boolean; tagAdded: boolean };
  /** The immediate flush a tagged message gets. */
  flushNow(groupId: string): Promise<void>;
  /**
   * An author's edit whose new content cannot be read (no content, the
   * mapper rejected it, the reader returned nothing or threw): the message
   * is dropped from the batch and the recent chat, never analysed with the
   * words its author took back.
   */
  editUnreadable(change: LocalMessageChange): { buffered: number; history: number };
  /** The Pi's own LID-to-phone map (local, never a WhatsApp lookup). */
  phoneForLid?(lidJid: string): Promise<string | null>;
  applyLocally(change: LocalMessageChange): { buffered: number; history: number; quotes: number };
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
  const isDelete = change.kind === "revoke";
  let local: LocalMessageChange = {
    kind: change.kind,
    groupId: change.chatId,
    messageId: change.messageId,
    senderJids: change.senderJids,
    senderPhone: change.senderPhone,
    byAdmin: isDelete && change.byAdmin === true,
    ...(isDelete && change.adminUnknown ? { adminUnknown: true } : {}),
  };
  // A sender known only by a LID, widened through the Pi's own LID map, so
  // it matches an original stored under the phone (round 6).
  if (!local.senderPhone && deps.phoneForLid) {
    for (const jid of local.senderJids.filter((j) => j.endsWith("@lid"))) {
      try {
        const phone = await deps.phoneForLid(jid);
        if (phone) {
          local = { ...local, senderPhone: phone, senderJids: [...new Set([...local.senderJids, `${phone}@c.us`])] };
          break;
        }
      } catch {
        /* the change goes on as the sender it named */
      }
    }
  }
  try {
    // (a) recorded here and in the outbox first, whatever happens next. An
    // author's edit marks its message as being read: a flush now holds it back.
    const counts = deps.applyLocally(local);
    const key = deps.record(local);
    // (b)/(c) an author's edit: its content, in memory, in place of any
    // waiting copy. Content that cannot be read: the message is dropped,
    // never analysed or kept with the original words.
    if (!isDelete) {
      let read: ReadEdit | null = null;
      try {
        read = change.edited ? await deps.readEdit(change.edited) : null;
      } catch {
        read = null;
      }
      if (read) {
        const r = deps.replacePending(local, read, change.editedAtMs ?? 0);
        if (r.replaced) deps.log(`${tag}: a waiting copy now carries the edited content`);
        if (r.tagAdded) await deps.flushNow(change.chatId);
      } else {
        const dropped = deps.editUnreadable(local);
        deps.error(`${tag}: its new content could not be read; the message is left out (batch=${dropped.buffered} recent=${dropped.history})`);
      }
    }
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
