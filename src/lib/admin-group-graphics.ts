/**
 * THE LIST POSTER AND THE TEAM SHEET IN A CLUB'S ADMIN GROUP (2026-10-14).
 *
 * Clubs like FNF reveal their weekly list and their teams as designed
 * graphics in an announcements group. MatchTime makes those graphics and
 * drops them in the club's ADMIN group, captioned "Ready to post: ...",
 * for the admins to forward.
 *
 *   parseGraphicsCommand(text)          the command, whole message only,
 *                                       English and Turkish, no model;
 *   handleAdminGraphicsCommand(...)     an owner's or admin's command in the
 *                                       admin group (hooked into
 *                                       `admin-group.ts`);
 *   sendGraphicToAdminChannel(...)      queue one graphic for the admin
 *                                       group. The command calls it, and so
 *                                       will the final-list and the
 *                                       approved-teams triggers.
 *
 * A graphic is queued as an `admin-group` BotJob (`graphic-job.ts`) and
 * goes out on the club's next due-posts poll, where its image URL is
 * signed (`admin-channel.ts`, `adminGroupJobInstruction`). The Pi fetches
 * the PNG from `/api/graphics/<token>` and posts it with the caption.
 *
 * NO MODEL. Nothing here or below it calls one
 * (`admin-group-no-model.source.test.ts`).
 */
import { db } from "./db";
import { resolveSenderUserIds } from "./admin-group-link";
import { isGroupPostable } from "./group-postability-store";
import { loadGraphicData, nextGraphicMatch } from "./match-graphics";
import { graphicCaption, graphicsCopy, type GraphicKind } from "./match-graphics-copy";
import { graphicJobOptions } from "./graphic-job";
import type { AdminGroupMessage, AdminGroupMessageResult } from "./admin-group";

// ── The command ─────────────────────────────────────────────────────────

const LIST_COMMANDS = new Set(["poster", "list poster", "squad poster", "liste", "liste posteri", "kadro posteri"]);
const TEAM_COMMANDS = new Set(["teams poster", "team poster", "team sheet", "teamsheet", "takim listesi", "takimlar posteri"]);

/** Lower case in Turkish, dotless and dotted i folded to "i", Turkish letters to ASCII. */
function fold(text: string): string {
  return text
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i");
}

/** "@Match Time", "MatchTime," or a raw tag ("@447700900999", "@<lid digits>") in front. */
const ADDRESS = /^(?:@?match\s*time\b|@[\p{L}\p{N}_]+)[\s,:]*/u;

/**
 * Which graphic an admin's message asks for, or null. The WHOLE message
 * must be the command (after an optional tag of MatchTime and trailing
 * punctuation), so chat that merely mentions a list is never read as one.
 */
export function parseGraphicsCommand(text: string): GraphicKind | null {
  if (typeof text !== "string") return null;
  let t = fold(text).trim();
  for (let i = 0; i < 3 && ADDRESS.test(t); i++) t = t.replace(ADDRESS, "");
  t = t.replace(/[\s.!?]+$/u, "").replace(/\s+/g, " ").trim();
  if (LIST_COMMANDS.has(t)) return "list";
  if (TEAM_COMMANDS.has(t)) return "teams";
  return null;
}

// ── Queue one graphic ───────────────────────────────────────────────────

export type SendGraphicResult =
  | { queued: true; jobId: string }
  | { queued: false; reason: "no-admin-group" | "not-postable" | "no-match" | "no-teams" | "already-sent" };

/**
 * Queue the list poster or the team sheet for `matchId` in the club's
 * linked admin group, captioned "Ready to post: FNF list for Fri 16 Oct".
 *
 * FOR THE TRIGGERS (not wired yet): call it once the final list is ready
 * (`kind: "list"`) and once an admin approves the teams (`kind: "teams"`),
 * with an `onceKey` such as `${matchId}:final-list`, so a re-run never
 * posts twice. A trigger's graphic waits for the admin group's posting
 * hours (09:00 to 22:59 London); `asked: true` (the command) goes at once.
 *
 * Queued only when the club has a linked admin group MatchTime can post in
 * and the graphic has something to show; otherwise a reason, and nothing.
 */
export async function sendGraphicToAdminChannel(
  orgId: string,
  matchId: string,
  kind: GraphicKind,
  opts: { asked?: boolean; onceKey?: string } = {},
): Promise<SendGraphicResult> {
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, language: true, adminGroupId: true },
  });
  if (!org?.adminGroupId) return { queued: false, reason: "no-admin-group" };
  if (!(await isGroupPostable(org.adminGroupId))) return { queued: false, reason: "not-postable" };

  const data = await loadGraphicData({ orgId, matchId, kind });
  if (!data) return { queued: false, reason: kind === "teams" ? "no-teams" : "no-match" };

  if (opts.onceKey) {
    try {
      await db.sentNotification.create({ data: { key: `graphic:${opts.onceKey}`, kind: "admin-notice" } });
    } catch {
      return { queued: false, reason: "already-sent" };
    }
  }

  const job = await db.botJob.create({
    data: {
      orgId,
      kind: "admin-group",
      text: graphicCaption(kind, org.language, org.name, data.matchDate),
      pollOptions: graphicJobOptions({ kind, matchId, asked: opts.asked === true }),
    },
  });
  console.log(`[graphics] queued ${kind} org=${orgId} match=${matchId} job=${job.id}${opts.asked ? " (asked)" : ""}`);
  return { queued: true, jobId: job.id };
}

// ── The admin's command ─────────────────────────────────────────────────

/**
 * An owner's or admin's "poster" / "team sheet" in the admin group of a
 * live club. Null when the message is not the command, the club is not
 * live, or the sender is not an owner or admin: `admin-group.ts` then
 * carries on exactly as before. Claims the message id with the same key
 * the rest of the admin-group route uses, so a Pi retry queues nothing
 * twice.
 *
 * The graphic itself is the answer: there is no text reply when it is
 * queued. "No teams yet." when the team sheet is asked for too early.
 */
export async function handleAdminGraphicsCommand(args: {
  org: { id: string; language: string | null; whatsappBotEnabled: boolean | null };
  msg: Pick<AdminGroupMessage, "text" | "messageId" | "senderPhone" | "senderAltPhone" | "senderLid">;
  now: Date;
}): Promise<AdminGroupMessageResult | null> {
  const { org, msg, now } = args;
  const kind = parseGraphicsCommand(msg.text);
  if (!kind || org.whatsappBotEnabled !== true) return null;

  const senders = await resolveSenderUserIds({ phones: [msg.senderPhone, msg.senderAltPhone], lid: msg.senderLid ?? null });
  const admin = senders.length
    ? await db.membership.findFirst({
        where: { orgId: org.id, userId: { in: senders }, leftAt: null, role: { in: ["OWNER", "ADMIN"] } },
        select: { userId: true },
      })
    : null;
  if (!admin) return null;

  if (msg.messageId) {
    try {
      await db.sentNotification.create({ data: { key: `admin-group-msg:${msg.messageId}`, kind: "admin-notice" } });
    } catch {
      return { handled: false, ignored: "duplicate", orgId: org.id, replyText: null };
    }
  }

  const s = graphicsCopy(org.language);
  const matchId = await nextGraphicMatch(org.id, now);
  if (!matchId) return { handled: true, orgId: org.id, outcome: "graphic-no-match", replyText: s.noMatch };

  const r = await sendGraphicToAdminChannel(org.id, matchId, kind, { asked: true });
  if (r.queued) return { handled: true, orgId: org.id, outcome: "graphic-queued", replyText: null };
  if (r.reason === "no-teams") return { handled: true, orgId: org.id, outcome: "graphic-no-teams", replyText: s.noTeams };
  if (r.reason === "no-match") return { handled: true, orgId: org.id, outcome: "graphic-no-match", replyText: s.noMatch };
  // No group MatchTime can post in: a reply would not reach it either.
  return { handled: true, orgId: org.id, outcome: `graphic-${r.reason}`, replyText: null };
}
