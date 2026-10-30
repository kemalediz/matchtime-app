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
 *                                       group: the command, and the
 *                                       final-list trigger;
 *   recordTeamSheetShown(...)           the graphics route drew a team
 *   teamSheetJobVerdict(...)            sheet; the due-posts poll asks if a
 *                                       queued one should still go
 *                                       (one team sheet per set of teams,
 *                                       2026-10-30).
 *
 * A graphic is queued as an `admin-group` BotJob (`graphic-job.ts`) and
 * goes out on the club's next due-posts poll, where its image URL is
 * signed (`admin-channel.ts`, `adminGroupJobInstruction`). The Pi fetches
 * the PNG from `/api/graphics/<token>` and posts it with the caption.
 *
 * THE TEAM SHEET ONLY WHEN ASKED (Kemal, 2026-10-30: "don't change poster
 * generation logic, however it can only be generated when they tag
 * matchtime while asking to generate"). Neither the approval nor a change
 * to the teams draws one any more; the request is answered only when it is
 * addressed to MatchTime by fact (`admin-group-understand.ts`). Teams not
 * approved yet are drawn as they are, and the caption says so.
 *
 * Nothing here calls a model: the request was read before it got here.
 */
import { db } from "./db";
import { isGroupPostable } from "./group-postability-store";
import { randomUUID } from "node:crypto";
import { loadGraphicData, nextGraphicMatch } from "./match-graphics";
import { graphicCaption, graphicsCopy, type GraphicKind } from "./match-graphics-copy";
import { graphicJobOptions, readGraphicJob } from "./graphic-job";

// ── Queue one graphic ───────────────────────────────────────────────────

export type SendGraphicResult =
  | { queued: true; jobId: string }
  | { queued: false; reason: "no-admin-group" | "not-postable" | "no-match" | "no-teams" | "already-sent" };

/**
 * Queue the list poster or the team sheet for `matchId` in the club's
 * linked admin group, captioned "Ready to post: FNF list for Fri 16 Oct".
 *
 * The final-list trigger calls it once the final list is ready
 * (`kind: "list"`), with an `onceKey` such as `${matchId}:final-list`, so a
 * re-run never posts twice. A trigger's graphic waits for the admin group's
 * posting hours (09:00 to 22:59 London); `asked: true` (the command) goes
 * at once. The team sheet has no trigger (2026-10-30).
 *
 * Queued only when the club has a linked admin group MatchTime can post in
 * and the graphic has something to show; otherwise a reason, and nothing.
 */
export async function sendGraphicToAdminChannel(
  orgId: string,
  matchId: string,
  kind: GraphicKind,
  opts: { asked?: boolean; onceKey?: string; sendAfter?: Date } = {},
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
      // Teams not approved yet say so (2026-10-30).
      text: graphicCaption(kind, org.language, org.name, data.matchDate, { notApproved: data.kind === "teams" && data.approved === false }),
      pollOptions: graphicJobOptions({ kind, matchId, asked: opts.asked === true }),
      ...(opts.sendAfter ? { sendAfter: opts.sendAfter } : {}),
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
 * again (no once-key here), unless one is still waiting to go, or the same
 * teams were drawn less than `SAME_SHEET_RESEND_MS` ago: then one short
 * line says they have not changed (2026-10-30), since a request answered
 * by nothing at all reads as MatchTime being broken.
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
  // ONE TEAM SHEET AT A TIME (2026-10-29, FNF HQ: the approval's team
  // sheet, then "Make a graphic" 20 seconds later, sent two identical
  // ones). A team sheet still waiting to go is drawn from the teams as
  // they are when it goes (`/api/graphics/<token>`), so it IS the answer:
  // it goes now, as an asked one, and no second one is queued.
  if (args.kind === "teams" && (await sameSheetShownWithin(args.orgId, matchId, args.now, SAME_SHEET_RESEND_MS))) {
    console.log(`[graphics] team sheet asked for org=${args.orgId} match=${matchId}: the same teams went out minutes ago, not sent again`);
    return { outcome: "graphic-unchanged", replyText: s.teamsUnchanged };
  }
  if (args.kind === "teams") {
    const waiting = await db.botJob.findFirst({
      where: { orgId: args.orgId, kind: "admin-group", sentAt: null, pollOptions: { hasEvery: graphicJobOptions({ kind: "teams", matchId, asked: false }).slice(0, 3) } },
      orderBy: { createdAt: "desc" },
      select: { id: true, sendAfter: true },
    });
    if (waiting) {
      const now = await db.botJob.updateMany({
        where: { id: waiting.id, sentAt: null },
        data: { sendAfter: null, pollOptions: graphicJobOptions({ kind: "teams", matchId, asked: true }) },
      });
      if (now.count > 0) {
        console.log(`[graphics] team sheet asked for org=${args.orgId} match=${matchId}: job=${waiting.id} already waiting, sent now`);
        return { outcome: "graphic-queued", replyText: null };
      }
    }
  }
  const r = await sendGraphicToAdminChannel(args.orgId, matchId, args.kind, { asked: true });
  if (r.queued) return { outcome: "graphic-queued", replyText: null };
  if (r.reason === "no-teams") return { outcome: "graphic-no-teams", replyText: s.noTeams };
  if (r.reason === "no-match") return { outcome: "graphic-no-match", replyText: s.noMatch };
  // No group MatchTime can post in: a reply would not reach it either.
  return { outcome: `graphic-${r.reason}`, replyText: null };
}

// ── One team sheet per set of teams (2026-10-30) ───────────────────────

/**
 * 29 Oct, FNF HQ: the team sheet image went out twice in a row with the
 * same teams (18:09, the approval's sheet and an asked one due on the same
 * poll; 19:25 and 19:26, an asked one and the redraw still in its quiet
 * period). So a team sheet whose teams are exactly those of the last one
 * DRAWN for that match is not sent again unasked, and a request for it
 * within `SAME_SHEET_RESEND_MS` is told the teams have not changed. (The
 * approval's sheet and the redraw were retired on 2026-10-30; the rule
 * stays for every sheet.)
 *
 * WHERE. The image is drawn when the Pi fetches it (`/api/graphics/<token>`),
 * from the teams as they are then; so that is where what a sheet showed is
 * recorded (`recordTeamSheetShown`), as `teamSheetFingerprint`. The Pi
 * fetches, posts and acks inside one tick before it polls again, so the
 * record is there on the next poll. The decision to send is taken where a
 * queued sheet is turned into an instruction (`bot-scheduler.ts`, through
 * `teamSheetJobVerdict`), before it is claimed: a sheet not sent is never
 * handed to the Pi at all. A fetch that fails posts nothing and records
 * nothing, so the next sheet still goes.
 *
 * The record is a SentNotification ledger row (kind `teamsheet-shown`, the
 * fingerprint in `text`, matchId left null so the scheduler's dedupe read
 * never sees it, as the outbound text log): no migration.
 */
export const SAME_SHEET_RESEND_MS = 10 * 60 * 1000;

const SHOWN_KIND = "teamsheet-shown";
const shownPrefix = (matchId: string) => `${SHOWN_KIND}:${matchId}:`;
/** Appended to a queued sheet's `pollOptions` when it was closed unsent. */
export const SKIPPED_SAME_TEAMS = "skipped:same-teams";

/** The graphics route drew the team sheet of `matchId` showing `fingerprint`. */
export async function recordTeamSheetShown(matchId: string, fingerprint: string, now: Date): Promise<void> {
  await db.sentNotification.create({
    data: { key: `${shownPrefix(matchId)}${now.getTime()}:${randomUUID()}`, kind: SHOWN_KIND, text: fingerprint },
  });
}

async function lastTeamSheetShown(matchId: string): Promise<{ fingerprint: string; at: Date } | null> {
  const row = await db.sentNotification.findFirst({
    where: { kind: SHOWN_KIND, key: { startsWith: shownPrefix(matchId) } },
    orderBy: { createdAt: "desc" },
    select: { text: true, createdAt: true },
  });
  return row?.text ? { fingerprint: row.text, at: row.createdAt } : null;
}

/**
 * The teams of `matchId` now are exactly those of the last team sheet drawn,
 * and that was drawn less than `withinMs` ago (Infinity: at any time).
 */
async function sameSheetShownWithin(orgId: string, matchId: string, now: Date, withinMs: number): Promise<boolean> {
  const last = await lastTeamSheetShown(matchId);
  if (!last || now.getTime() - last.at.getTime() >= withinMs) return false;
  const data = await loadGraphicData({ orgId, matchId, kind: "teams" });
  return !!data && data.kind === "teams" && !!data.fingerprint && data.fingerprint === last.fingerprint;
}

/**
 * Whether a queued admin-group job may go out on this poll:
 *
 *   "send"  anything that is not a team sheet; a team sheet showing teams
 *           not yet drawn; an asked one when the same sheet went out more
 *           than `SAME_SHEET_RESEND_MS` ago (it may have scrolled away).
 *   "hold"  another team sheet for the same match is already going out on
 *           this poll (`emitted`, match ids): it waits for the next poll,
 *           when that one's image is recorded and this one is decided.
 *   "skip"  the same teams as the last sheet drawn: closed unsent (`sentAt`
 *           stamped, `SKIPPED_SAME_TEAMS` appended) and never handed to the
 *           Pi. Quietly: an asked one skipped here was queued while the same
 *           sheet was on its way, so the image is just above it.
 */
export async function teamSheetJobVerdict(args: {
  job: { id: string; pollOptions: readonly string[] | null };
  orgId: string;
  now: Date;
  emitted: ReadonlySet<string>;
}): Promise<"send" | "hold" | "skip"> {
  const g = readGraphicJob(args.job.pollOptions);
  if (!g || g.kind !== "teams") return "send";
  if (args.emitted.has(g.matchId)) return "hold";
  const within = g.asked ? SAME_SHEET_RESEND_MS : Number.POSITIVE_INFINITY;
  if (!(await sameSheetShownWithin(args.orgId, g.matchId, args.now, within))) return "send";
  await db.botJob.updateMany({
    where: { id: args.job.id, sentAt: null },
    data: { sentAt: args.now, pollOptions: [...graphicJobOptions(g), SKIPPED_SAME_TEAMS] },
  });
  console.log(`[graphics] team sheet job=${args.job.id} match=${g.matchId} (${g.asked ? "asked" : "auto"}): same teams as the last sheet drawn, not sent`);
  return "skip";
}
