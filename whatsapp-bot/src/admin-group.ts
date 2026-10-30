/**
 * ADMIN GROUPS ON THE PI (slice 2a, 2026-09-30).
 * Plan: MDs/friday-group-features-plan-2026-09-30.md, section 2.5.
 *
 * Two kinds of group message never go near the analysis pipeline:
 *
 *   1. Anything in a club's linked ADMIN group. Forwarded at once (no
 *      10-minute batch) to /api/whatsapp/admin-group, flagged as the admin
 *      channel, and NEVER recorded in the analysis history or enqueued for
 *      analyze. The server answers with an optional reply, posted in the
 *      same group, and an optional reaction (✅ on a message it acted on,
 *      2026-10-16), placed on the admin's message.
 *   2. A message that TAGS MatchTime (the mention flag, never the words
 *      "Match Time" typed) and holds a code-shaped token (six characters
 *      of the code alphabet), in any other group, a silent one included.
 *      This is the one narrow exception to the silence rail: only such a
 *      message leaves the Pi, and the server decides by facts (a code it
 *      issued, sent by that club's owner or admin). On `adminGroup` in the
 *      answer the group becomes an admin group here at once. When the
 *      server answers "not-a-link-command" (no code it issued, and the
 *      group is not waiting for one), or does not answer, the message
 *      carries on as any other ("not-handled"): in a players' group the
 *      pipeline reads it, in a silent group it is dropped as before.
 *
 * Everything else returns "not-handled" and index.ts carries on exactly
 * as before. The message is read (`read`) only once the raw body holds a
 * code-shaped token, so an ordinary message costs nothing extra.
 *
 * Until 2026-10-30 a phrase decided it ("@Match Time admin group CODE" or
 * "yönetici grubu"), a copy of the server's `parseAdminGroupLinkMessage`.
 * Kemal: no string parsing. The code shape is a copy of the server's
 * `adminGroupCodeCandidates` (src/lib/admin-channel-rules.ts); keep the
 * alphabet in step.
 */
import type { AdminGroupAnswer, AdminGroupForward } from "./api.js";
import { describeReactionFailure, planReaction, type ReactionOutcome } from "./react-with-id.js";

/** The server's ADMIN_GROUP_CODE_ALPHABET: no 0/O, 1/I/L. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_TOKEN = new RegExp(`(?<![\\p{L}\\p{N}])[${CODE_ALPHABET}${CODE_ALPHABET.toLowerCase()}]{6}(?![\\p{L}\\p{N}])`, "u");

/** Cheap pre-check on the raw body, before anything is read: a code-shaped token. */
export function mightBeAdminGroupLink(rawBody: string): boolean {
  return typeof rawBody === "string" && CODE_TOKEN.test(rawBody);
}

/** What may be the link message: a REAL tag and a code-shaped token. */
export function looksLikeAdminGroupLink(body: string, botMentioned: boolean): boolean {
  return botMentioned === true && typeof body === "string" && CODE_TOKEN.test(body);
}

export interface AdminGroupInboundDeps {
  isAdminGroup(groupId: string): boolean;
  addAdminGroup(groupId: string, orgId: string): void;
  /** Read the message for the server (identity, text, mentions). */
  read(): Promise<AdminGroupForward | null>;
  postAdminGroupMessage(msg: AdminGroupForward): Promise<AdminGroupAnswer | null>;
  postAdminGroupLink(msg: AdminGroupForward): Promise<AdminGroupAnswer | null>;
  /** Post a reply in the same group; resolves to the driver's send result. */
  reply(text: string): Promise<unknown>;
  /** Ack a sent reply the server claimed (`answer.replyKey`, slice S4 review). */
  ackReply?(key: string, kind: string, sent: unknown): Promise<void>;
  /** Place an emoji on a message by its id: the driver's `sendReaction`,
   *  the same path the players' group reacts through. Never throws. */
  sendReaction?(waMessageId: string, emoji: string): Promise<ReactionOutcome>;
  log?(line: string): void;
}

/**
 * The server's tick on an admin's message it acted on (2026-10-16), placed
 * by the id the Pi forwarded, exactly as the players' group reacts
 * (`planReaction`, then the driver's `sendReaction`). A reaction that does
 * not land is logged and nothing is said in the group.
 */
async function postReaction(deps: AdminGroupInboundDeps, messageId: string, answer: AdminGroupAnswer | null): Promise<void> {
  const emoji = typeof answer?.react === "string" ? answer.react : "";
  if (!emoji || !deps.sendReaction) return;
  const log = deps.log ?? console.error;
  const plan = planReaction(messageId, emoji);
  if (plan.action === "skip") {
    log(`[admin-group] react ${emoji} skipped for ${messageId}: ${plan.reason}`);
    return;
  }
  const outcome = await deps.sendReaction(plan.messageId, plan.emoji);
  if (!outcome.ok) {
    log(`[admin-group] react ${plan.emoji} failed for ${plan.messageId}: ${outcome.reason} (${describeReactionFailure(outcome.reason)})`);
  }
}

export type AdminGroupRoute = "admin-group" | "link-command" | "not-handled";

async function postReply(deps: AdminGroupInboundDeps, answer: AdminGroupAnswer | null): Promise<void> {
  const text = typeof answer?.replyText === "string" ? answer.replyText.trim() : "";
  if (!text) return;
  try {
    const sent = await deps.reply(text);
    // Claimed by the server: ack it with its sent id, so an HQ reply quoting
    // it (a YES to the teams) is decided by that id.
    if (answer?.replyKey && deps.ackReply) await deps.ackReply(answer.replyKey, "admin-group-reply", sent);
  } catch (err) {
    (deps.log ?? console.error)(`[admin-group] reply failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function routeAdminGroupInbound(
  deps: AdminGroupInboundDeps,
  head: { from: string; body: string },
): Promise<AdminGroupRoute> {
  const log = deps.log ?? console.log;
  if (!head.from.endsWith("@g.us")) return "not-handled";

  if (deps.isAdminGroup(head.from)) {
    const msg = await deps.read();
    if (!msg) return "admin-group";
    const answer = await deps.postAdminGroupMessage(msg);
    log(`[admin-group] forwarded ${msg.messageId} from ${head.from}`);
    await postReaction(deps, msg.messageId, answer);
    await postReply(deps, answer);
    return "admin-group";
  }

  if (!mightBeAdminGroupLink(head.body)) return "not-handled";
  const msg = await deps.read();
  if (!msg || !looksLikeAdminGroupLink(msg.text, msg.botMentioned)) return "not-handled";
  const answer = await deps.postAdminGroupLink(msg);
  log(`[admin-group] link command in ${head.from} forwarded (${answer?.outcome ?? "no answer"}${answer?.reason ? `: ${answer.reason}` : ""})`);
  // Not the link message, or no answer: the message carries on as any other.
  if (!answer || (answer.outcome === "ignored" && answer.reason === "not-a-link-command")) return "not-handled";
  const link = answer?.adminGroup;
  if (link && link.groupId === head.from && typeof link.orgId === "string" && link.orgId) {
    deps.addAdminGroup(head.from, link.orgId);
  }
  await postReply(deps, answer);
  return "link-command";
}

/**
 * Which chat a reaction happened in, when the payload says. whatsapp-web.js
 * carries `msgId.remote`; both drivers serialise the id as
 * "<fromMe>_<chat>_<id>". Unknown: null, and the caller forwards as before.
 */
export function reactionChatId(reaction: unknown): string | null {
  try {
    const msgId = (reaction as { msgId?: { remote?: unknown; _serialized?: unknown } })?.msgId;
    if (typeof msgId?.remote === "string" && msgId.remote) return msgId.remote;
    const ser = msgId?._serialized;
    if (typeof ser === "string") {
      const m = /^(?:true|false)_([^_]+@g\.us)_/.exec(ser);
      if (m) return m[1];
    }
  } catch {
    /* a throwing getter on a broken build: unknown */
  }
  return null;
}
