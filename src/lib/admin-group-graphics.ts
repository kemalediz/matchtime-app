/**
 * THE LIST POSTER AND THE TEAM SHEET IN A CLUB'S ADMIN GROUP (2026-10-14).
 *
 * Clubs like FNF reveal their weekly list and their teams as designed
 * graphics in an announcements group. MatchTime makes those graphics and
 * drops them in the club's ADMIN group, captioned "Ready to post: ...",
 * for the admins to forward.
 *
 *   answerGraphicRequest(...)           an owner's or admin's request in the
 *                                       admin group, in their own words: the
 *                                       shared router's `poster` and
 *                                       `team_sheet` routes
 *                                       (`admin-group-understand.ts`);
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
 * Nothing here calls a model: the request was read before it got here.
 */
import { db } from "./db";
import { isGroupPostable } from "./group-postability-store";
import { loadGraphicData, nextGraphicMatch } from "./match-graphics";
import { graphicCaption, graphicsCopy, type GraphicKind } from "./match-graphics-copy";
import { graphicJobOptions } from "./graphic-job";

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

// ── The admin's request ─────────────────────────────────────────────

/**
 * An owner's or admin's request for the list poster or the team sheet in
 * the admin group of a live club. The caller has proven the sender and
 * claimed the message id. The graphic itself is the answer: no text when
 * it is queued. After the teams are approved a team sheet request sends it
 * again (no once-key here).
 */
export async function answerGraphicRequest(args: {
  orgId: string;
  lang: string | null;
  kind: GraphicKind;
  now: Date;
}): Promise<{ outcome: string; replyText: string | null }> {
  const s = graphicsCopy(args.lang);
  const matchId = await nextGraphicMatch(args.orgId, args.now);
  if (!matchId) return { outcome: "graphic-no-match", replyText: s.noMatch };
  const r = await sendGraphicToAdminChannel(args.orgId, matchId, args.kind, { asked: true });
  if (r.queued) return { outcome: "graphic-queued", replyText: null };
  if (r.reason === "no-teams") return { outcome: "graphic-no-teams", replyText: s.noTeams };
  if (r.reason === "no-match") return { outcome: "graphic-no-match", replyText: s.noMatch };
  // No group MatchTime can post in: a reply would not reach it either.
  return { outcome: `graphic-${r.reason}`, replyText: null };
}
