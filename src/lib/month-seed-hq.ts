/**
 * A1's WhatsApp door (2026-10-29): an organiser pastes the group's list for
 * the COMING month in the club's admin group, and MatchTime starts that
 * month from it after a YES. The same action as "Start <month> from your
 * list" on /admin/months (`startMonth` with the coming month), so the web
 * and WhatsApp can never disagree.
 *
 * How it stays inside the one pipeline, with no phrase reading:
 *   - the list is read by the monthly reader, a model step, in
 *     `month-seed-read.ts` (`proposeMonthSeedPaste`), reached in HQ only
 *     through the admin group's shared model door
 *     (`admin-group-understand.ts`). This file holds the YES, which reads
 *     nothing;
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
import { monthNameLabel } from "./i18n/dates";
import { monthSetupCopy } from "./i18n/month-setup";
import { nextMonthStart, seedTargets } from "./month-signup-rules";
import { startMonth } from "./squad-month";
import { monthPhaseOfGame } from "./club-summary/derive";
import type { NamelessRef, SeedUnmatchedEntry } from "./month-seed-match-rules";
import { gamesPlayedBy, londonMonthStart, monthFixtureDates, monthStartToDate, normaliseSquadMode, type SeedRowInput } from "./squad-month-rules";

/** As long as a weekly pasted list waits for its YES. */
export const SEED_PROPOSAL_TTL_MS = 30 * 60 * 1000;

export interface MonthSeedProposalData {
  activityId: string;
  games: number;
  /** Games already played when the list was read (a month started
   *  part-way). Absent on a proposal for a coming month, and on one stored
   *  before 2026-11-03. The YES counts them again at its own time. */
  gamesPlayed?: number;
  rows: SeedRowInput[];
  /** Names on the list that matched nobody, with what each line says, so
   *  the organiser can say who they are (2026-11-03, `month-seed-match.ts`).
   *  Absent on a proposal stored before then. */
  unmatched?: SeedUnmatchedEntry[];
  /** The members with no name as numbered in the DM he was last sent, so
   *  "Craig is 3" means the member he saw as 3. */
  nameless?: NamelessRef[];
  /** What the list was read as (`seedReadKey`): the same list read again
   *  is not offered again. */
  readKey?: string;
}

export interface MonthSeedReply {
  /** "month-seed-same": this very list is already waiting for his answer
   *  (`keepSameList`); nothing was written and nothing is to be sent. */
  outcome: "month-seed-proposed" | "month-seed-same" | "month-seed-applied" | "month-seed-failed";
  replyText: string;
  /** Why a YES did not start the month. */
  error?: string;
  /** What the proposal says, for a caller that words it differently (the
   *  players' group's DM to the organiser, `month-seed-group.ts`). */
  proposal?: { month: string; count: number; names: string; unknown: string | null; link: string };
}


/**
 * The months a pasted list may start, for this club, in the order they are
 * tried: THIS month (its first game still to come, or already under way and
 * never started: started part-way, 2026-11-03), then the next. Empty for a
 * club not on "monthly" or with more than one fixture.
 */
export async function seedableMonths(orgId: string, now: Date) {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { squadMode: true, seasonBreakMonths: true } });
  if (!org || normaliseSquadMode(org.squadMode) !== "monthly") return [];
  const activities = await db.activity.findMany({ where: { orgId, isActive: true }, select: { id: true, dayOfWeek: true, time: true } });
  // One fixture only: with two, which one the list is for is the page's question.
  if (activities.length !== 1) return [];
  const a = activities[0];
  const current = londonMonthStart(now);
  const candidates = [current, nextMonthStart(current)];
  const rows = await db.squadMonth.findMany({
    where: { orgId, activityId: a.id, monthStart: { in: candidates.map(monthStartToDate) } },
    select: { id: true, activityId: true, status: true, monthStart: true },
  });
  // The one month phase (club summary B2): a month this game has a row for
  // (in sign-up, running or closed) is not started again from a list; one
  // with no month yet, or held for its organiser, may be. The game's own
  // Activity, never another club month of the same London month (D5).
  const months = rows.map((m) => ({ ...m, monthStart: m.monthStart.toISOString().slice(0, 10) }));
  const started = new Set(
    candidates.filter((monthStart) => {
      const { phase } = monthPhaseOfGame({ orgId, activityId: a.id, monthStart, months, heldKeys: [] });
      return phase !== "none" && phase !== "held";
    }),
  );
  return seedTargets({ now, dayOfWeek: a.dayOfWeek, time: a.time, breakMonths: org.seasonBreakMonths, started }).map((t) => ({ activity: a, ...t }));
}

/** The first month a pasted list could start, or null. */
export async function comingMonth(orgId: string, now: Date) {
  return (await seedableMonths(orgId, now))[0] ?? null;
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
  // A month under way: the games played by NOW, the YES's own time (a game
  // may have been played since the list was read). A coming month: none.
  const activity = await db.activity.findFirst({ where: { id: data.activityId, orgId: args.orgId }, select: { dayOfWeek: true, time: true } });
  const gamesPlayed = activity
    ? gamesPlayedBy(monthFixtureDates(args.proposal.monthStart, activity.dayOfWeek), activity.time, args.now)
    : (data.gamesPlayed ?? 0);
  const res = await startMonth(
    args.orgId,
    args.senderUserId,
    { activityId: data.activityId, gamesScheduled: data.games, gamesPlayed, source: "seed-list", rows: data.rows },
    args.now,
    { monthStart: args.proposal.monthStart },
  );
  if (!res.ok) return { outcome: "month-seed-failed", replyText: c.hq_seed_failed({ month, key: res.error }), error: res.error };
  return { outcome: "month-seed-applied", replyText: c.hq_seed_applied({ month, count: data.rows.length }) };
}
