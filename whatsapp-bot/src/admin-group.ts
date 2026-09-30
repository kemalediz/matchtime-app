/**
 * ADMIN GROUPS ON THE PI (slice 2a, 2026-09-30).
 * Plan: MDs/friday-group-features-plan-2026-09-30.md, section 2.5.
 *
 * Two kinds of group message never go near the analysis pipeline:
 *
 *   1. Anything in a club's linked ADMIN group. Forwarded at once (no
 *      10-minute batch) to /api/whatsapp/admin-group, flagged as the admin
 *      channel, and NEVER recorded in the analysis history or enqueued for
 *      analyze. That route has no model path. The server answers with an
 *      optional reply, posted in the same group.
 *   2. "@Match Time admin group CODE" (or "yönetici grubu") in any other
 *      group, a silent one included. This is the one narrow exception to
 *      the silence rail: only a message shaped exactly like the command
 *      leaves the Pi, and the server decides (it answers only a real
 *      admin). On `adminGroup` in the answer the group becomes an admin
 *      group here at once.
 *
 * Everything else returns "not-handled" and index.ts carries on exactly
 * as before. The message is read (`read`) only once we know it is one of
 * the two, so an ordinary message costs nothing extra.
 *
 * The command shape is a copy of `parseAdminGroupLinkMessage` in the
 * server's src/lib/admin-channel-rules.ts; keep the two in step.
 */
import type { AdminGroupAnswer, AdminGroupForward } from "./api.js";

const LINK_COMMAND =
  /(?<![\p{L}\p{N}])(?:admin\s+group|y[oö]netici\s+grub[uü])\s*[:\-]?\s*([a-z0-9]{6})(?![\p{L}\p{N}])/u;

function fold(text: string): string {
  return text.toLocaleLowerCase("tr").replace(/ı/g, "i");
}

/** Cheap pre-check on the raw body, before anything is read. */
export function mightBeAdminGroupLink(rawBody: string): boolean {
  return typeof rawBody === "string" && LINK_COMMAND.test(fold(rawBody));
}

/** The full shape: addressed to MatchTime (a real tag or the words), then the command. */
export function looksLikeAdminGroupLink(body: string, botMentioned: boolean): boolean {
  if (typeof body !== "string" || !body.trim()) return false;
  const folded = fold(body);
  if (!botMentioned && !/match\s*time/.test(folded)) return false;
  return LINK_COMMAND.test(folded);
}

export interface AdminGroupInboundDeps {
  isAdminGroup(groupId: string): boolean;
  addAdminGroup(groupId: string, orgId: string): void;
  /** Read the message for the server (identity, text, mentions). */
  read(): Promise<AdminGroupForward | null>;
  postAdminGroupMessage(msg: AdminGroupForward): Promise<AdminGroupAnswer | null>;
  postAdminGroupLink(msg: AdminGroupForward): Promise<AdminGroupAnswer | null>;
  /** Post a reply in the same group. */
  reply(text: string): Promise<unknown>;
  log?(line: string): void;
}

export type AdminGroupRoute = "admin-group" | "link-command" | "not-handled";

async function postReply(deps: AdminGroupInboundDeps, answer: AdminGroupAnswer | null): Promise<void> {
  const text = typeof answer?.replyText === "string" ? answer.replyText.trim() : "";
  if (!text) return;
  try {
    await deps.reply(text);
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
    await postReply(deps, answer);
    return "admin-group";
  }

  if (!mightBeAdminGroupLink(head.body)) return "not-handled";
  const msg = await deps.read();
  if (!msg || !looksLikeAdminGroupLink(msg.text, msg.botMentioned)) return "not-handled";
  const answer = await deps.postAdminGroupLink(msg);
  log(`[admin-group] link command in ${head.from} forwarded (${answer?.outcome ?? "no answer"})`);
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
