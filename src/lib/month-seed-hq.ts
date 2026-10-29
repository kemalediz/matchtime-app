/**
 * A1's WhatsApp door (2026-10-29): an organiser pastes the group's list for
 * the COMING month in the club's admin group, and MatchTime starts that
 * month from it after a YES. The same action as "Start <month> from your
 * list" on /admin/months (`startMonth` with the coming month), so the web
 * and WhatsApp can never disagree.
 *
 * How it stays inside the one pipeline, with no phrase reading:
 *   - the list is read by the month list reader, `readListForSeed` (agent
 *     B is replacing what sits behind it with a model step; this file only
 *     uses its structured output: names matched to players, PAYG, paid,
 *     "4 only", and whether it is headed with a month);
 *   - the proposal is stored as an `AdminSquadProposal` with `monthSeed`
 *     set, so the admin group's existing "a pasted list waits for YES"
 *     question is what the router sees (`loadPending` kind "list"), and the
 *     YES goes through `answerSquadPasteYes`, which hands it here.
 *
 * Only for a club on "monthly", an organiser (OWNER or ADMIN), one active
 * fixture, a coming month that has not been started and is not a break
 * month, and a list headed with that month. Anything else returns null and
 * the admin group carries on as before.
 */
import { db } from "./db";
import { appUrl } from "./app-url";
import { monthNameLabel } from "./i18n/dates";
import { monthSetupCopy } from "./i18n/month-setup";
import { firstKickoffOf, nextMonthStart } from "./month-signup-rules";
import { readListForSeed, startMonth } from "./squad-month";
import { isBreakMonth, londonMonthStart, monthFixtureDates, monthStartToDate, normaliseSquadMode, type SeedRowInput } from "./squad-month-rules";

/** As long as a weekly pasted list waits for its YES. */
const SEED_PROPOSAL_TTL_MS = 30 * 60 * 1000;

export interface MonthSeedProposalData {
  activityId: string;
  games: number;
  rows: SeedRowInput[];
}

export interface MonthSeedReply {
  outcome: "month-seed-proposed" | "month-seed-applied" | "month-seed-failed";
  replyText: string;
  /** Why a YES did not start the month. */
  error?: string;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/** The coming month a pasted list may start, for this club: the next
 *  month, or this one while its first game is still to come. */
async function comingMonth(orgId: string, now: Date) {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { squadMode: true, seasonBreakMonths: true } });
  if (!org || normaliseSquadMode(org.squadMode) !== "monthly") return null;
  const activities = await db.activity.findMany({ where: { orgId, isActive: true }, select: { id: true, dayOfWeek: true, time: true } });
  // One fixture only: with two, which one the list is for is the page's question.
  if (activities.length !== 1) return null;
  const a = activities[0];
  const current = londonMonthStart(now);
  for (const monthStart of [current, nextMonthStart(current)]) {
    if (isBreakMonth(org.seasonBreakMonths, monthStart)) continue;
    const first = firstKickoffOf(monthStart, a.dayOfWeek, a.time);
    if (!first || first.getTime() <= now.getTime()) continue;
    const exists = await db.squadMonth.findFirst({ where: { orgId, monthStart: monthStartToDate(monthStart) }, select: { id: true } });
    if (exists) continue;
    return { activity: a, monthStart, first, games: monthFixtureDates(monthStart, a.dayOfWeek).length };
  }
  return null;
}

/**
 * A list pasted in the admin group by an organiser. Null when it is not a
 * list for a coming month this club has not started: the caller does what
 * it did before.
 */
export async function proposeMonthSeedPaste(args: {
  orgId: string;
  lang: string | null | undefined;
  messageId: string;
  /** An OWNER or ADMIN. Nobody else starts a month. */
  organiserUserId: string;
  text: string;
  now: Date;
}): Promise<MonthSeedReply | null> {
  const { orgId, now } = args;
  const target = await comingMonth(orgId, now);
  if (!target) return null;
  const read = await readListForSeed(orgId, args.text, now, target.monthStart);
  if (!read.ok || !read.headed || read.monthMismatch || read.rows.length === 0) return null;

  const rows: SeedRowInput[] = read.rows.map((r) => ({
    userId: r.userId,
    kind: r.kind,
    tier: r.tier,
    slot: r.slot,
    paid: r.paid,
    paidAmountPence: r.paidAmountPence,
    gamesCommitted: r.gamesCommitted,
    listName: r.listName,
  }));
  const data: MonthSeedProposalData = { activityId: target.activity.id, games: target.games, rows };
  try {
    await db.adminSquadProposal.updateMany({ where: { orgId, resolvedAt: null }, data: { resolvedAt: now, outcome: "superseded" } });
    await db.adminSquadProposal.create({
      data: {
        orgId,
        // A month's list is about no one match.
        matchId: "",
        waMessageId: args.messageId,
        proposedByUserId: args.organiserUserId,
        playingUserIds: rows.map((r) => r.userId),
        monthStart: target.monthStart,
        monthSeed: data as unknown as object,
        expiresAt: new Date(now.getTime() + SEED_PROPOSAL_TTL_MS),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
  const c = monthSetupCopy(args.lang);
  const month = monthNameLabel(args.lang, target.first);
  console.log(`[month-seed-hq] ${args.messageId}: ${target.monthStart} proposed for ${orgId}: ${rows.length} matched, ${read.unmatched.length} not known`);
  return {
    outcome: "month-seed-proposed",
    replyText: c.hq_seed_proposal({
      month,
      count: rows.length,
      names: read.rows.map((r) => r.listName || r.name).join(", "),
      unknown: read.unmatched.length > 0 ? read.unmatched.map((u) => u.name).join(", ") : null,
      link: appUrl("/admin/months"),
    }),
  };
}

/**
 * The YES to a month's list, after `answerSquadPasteYes` claimed the
 * proposal (so two YES messages start it once). Only an organiser's YES
 * starts a month; the caller passes who said it.
 */
export async function applyMonthSeedYes(args: {
  orgId: string;
  lang: string | null | undefined;
  proposal: { monthStart: string; monthSeed: unknown };
  senderUserId: string;
  now: Date;
}): Promise<MonthSeedReply> {
  const c = monthSetupCopy(args.lang);
  const data = args.proposal.monthSeed as MonthSeedProposalData;
  const monthDate = new Date(`${args.proposal.monthStart}T12:00:00.000Z`);
  const month = monthNameLabel(args.lang, monthDate);
  const admin = await db.membership.findFirst({
    where: { orgId: args.orgId, userId: args.senderUserId, leftAt: null, role: { in: ["OWNER", "ADMIN"] }, guestMatchId: null },
    select: { id: true },
  });
  if (!admin || !data || !Array.isArray(data.rows)) return { outcome: "month-seed-failed", replyText: c.hq_seed_failed({ month, key: "failed" }) };
  const res = await startMonth(
    args.orgId,
    args.senderUserId,
    { activityId: data.activityId, gamesScheduled: data.games, gamesPlayed: 0, source: "seed-list", rows: data.rows },
    args.now,
    { monthStart: args.proposal.monthStart },
  );
  if (!res.ok) return { outcome: "month-seed-failed", replyText: c.hq_seed_failed({ month, key: res.error }), error: res.error };
  return { outcome: "month-seed-applied", replyText: c.hq_seed_applied({ month, count: data.rows.length }) };
}
