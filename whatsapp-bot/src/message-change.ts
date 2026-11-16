/**
 * A MESSAGE DELETED FOR EVERYONE, OR EDITED: HOUSEKEEPING ONLY (2026-11-15).
 *
 * The driver hands the change up (`onMessageChange`, read off WhatsApp's
 * protocol message by `baileys/message-change.ts`). Until today it was
 * dropped as unreadable, so MatchTime kept the words a member had taken
 * back and could quote them to anybody who asked within the week.
 *
 * For a group MatchTime reads (a players' group or HQ), in this order:
 *
 *   1. the Pi's own copies: the batch still waiting to be analysed and the
 *      recent chat that rides along with it (`smart-analysis.ts`
 *      `applyMessageChangeLocally`). A message deleted inside the
 *      ten-minute batch window is then never posted at all;
 *   2. wait for a running analysis of that group to end (bounded), because
 *      the server stores a batch only after answering it, and a delete
 *      that arrived first would find nothing to delete;
 *   3. post the change (`/api/whatsapp/message-change`), which takes the
 *      words out of every store the server keeps (src/lib/message-change.ts).
 *
 * NOTHING HERE SENDS, REPLIES, REACTS OR ANALYSES: its only effects are the
 * injected ones, and `index.ts` injects nothing that talks to WhatsApp.
 * A DM is not posted: the server keeps no member's DM text for a later
 * answer (the DM context is MatchTime's own DMs).
 *
 * Logs carry ids and counts, never the words.
 */
import type { MessageChangeEvent } from "./driver.js";
import type { MessageChangeBody, MessageChangeResponse } from "./api.js";
import { legacyJid, parseKey } from "./baileys/key.js";

export interface MessageChangeDeps {
  /** A group MatchTime reads: monitored, or a club's admin group. */
  isTrackedGroup(chatId: string): boolean;
  applyLocally(change: LocalMessageChange): { buffered: number; history: number };
  /** True when no analysis of the group is running; false on its timeout. */
  whenFlushIdle(groupId: string): Promise<boolean>;
  post(body: MessageChangeBody): Promise<MessageChangeResponse | null>;
  log(line: string): void;
  error(line: string): void;
}

/** A change, as the Pi's own copies take it. */
export interface LocalMessageChange {
  kind: "revoke" | "edit";
  groupId: string;
  messageId: string;
  text?: string;
  senderJids: string[];
  senderPhone: string | null;
}

/** PURE. Does a stored whatsapp-web.js id name this group's message? */
export function isIdOfMessage(storedId: string, chatId: string, messageId: string): boolean {
  const key = parseKey(storedId);
  return !!key && legacyJid(key.remoteJid) === chatId && key.id === messageId;
}

/**
 * PURE. Is an edit's sender the author of the stored message? The stored
 * id's participant is one of the sender's spellings, or the stored phone
 * is the sender's phone. The server applies the same rule.
 */
export function editIsByAuthor(
  storedId: string,
  storedPhone: string | null | undefined,
  sender: { senderJids: string[]; senderPhone: string | null },
): boolean {
  const participant = legacyJid(parseKey(storedId)?.participant ?? null);
  if (participant && sender.senderJids.includes(participant)) return true;
  const phone = (sender.senderPhone ?? "").replace(/\D/g, "");
  if (!phone) return false;
  if (participant?.endsWith("@c.us") && participant.split("@")[0] === phone) return true;
  return (storedPhone ?? "").replace(/\D/g, "") === phone;
}

export type MessageChangeOutcome = "posted" | "dm" | "untracked" | "failed";

/** Never throws. */
export async function handleMessageChange(change: MessageChangeEvent, deps: MessageChangeDeps): Promise<MessageChangeOutcome> {
  const what = change.kind === "revoke" ? "delete for everyone" : "edit";
  const tag = `[message-change] ${what} of ${change.messageId} in ${change.chatId}`;
  try {
    if (!change.isGroup) {
      deps.log(`${tag}: a DM; MatchTime keeps no DM text for later answers, nothing to change`);
      return "dm";
    }
    if (!deps.isTrackedGroup(change.chatId)) {
      deps.log(`${tag}: not a group MatchTime reads, nothing stored`);
      return "untracked";
    }
    const local = deps.applyLocally({
      kind: change.kind,
      groupId: change.chatId,
      messageId: change.messageId,
      ...(change.kind === "edit" && change.text ? { text: change.text } : {}),
      senderJids: change.senderJids,
      senderPhone: change.senderPhone,
    });
    const idle = await deps.whenFlushIdle(change.chatId);
    if (!idle) deps.log(`${tag}: an analysis of this group is still running; posting anyway`);
    const body: MessageChangeBody =
      change.kind === "edit" && change.text
        ? { kind: "edit", chatId: change.chatId, messageId: change.messageId, text: change.text, senderJids: change.senderJids, senderPhone: change.senderPhone }
        : { kind: "revoke", chatId: change.chatId, messageId: change.messageId };
    const r = await deps.post(body);
    if (!r || r.ok !== true) {
      deps.error(`${tag}: not applied on the server (the Pi's copies were: batch=${local.buffered} recent=${local.history})`);
      return "failed";
    }
    deps.log(
      `${tag}: batch=${local.buffered} recent=${local.history} analyzed=${r.analyzed ?? 0} archived=${r.archived ?? 0} ` +
        `hq=${r.hq ?? 0} mentions=${r.mentions ?? 0} editsRefused=${r.editsRefused ?? 0}`,
    );
    return "posted";
  } catch (err) {
    deps.error(`${tag}: not applied: ${err instanceof Error ? err.message : "failed"}`);
    return "failed";
  }
}
