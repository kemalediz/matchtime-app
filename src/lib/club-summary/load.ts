/**
 * LOAD ONE CLUB SUMMARY (slice A0). The summary's only I/O: a fixed set of
 * indexed reads, then `buildClubSummary` (derive.ts) over what they return.
 *
 * The reads, in parallel where they do not depend on each other:
 *   1. the Organisation row, one select (lifecycle, groups, routine,
 *      payments, squad);
 *   2. `getOrgFeatures(orgId)`: the switches, through its own `fromRow`, so
 *      `summary.features` and `getOrgFeatures` can never differ (its select
 *      and `fromRow` are private to org-features.ts; exporting them would let
 *      read 1 carry them and save this read, see the plan's section 3.3);
 *   3. only with a collector set: the collector's `User.name`
 *      (`loadClubSnapshot`'s read);
 *   4. every Activity of the club, with its sport;
 *   5. the scheduler's match window (`getMatchesForScheduler`'s where), with
 *      attendance statuses and a team-assignment count;
 *   6. the last-played candidates (`loadSquadState`'s read);
 *   7. monthly clubs only: the SquadMonth rows the consumers look at, with
 *      each month's member rows still on it;
 *   8. monthly clubs only: the held-month `SentNotification` keys.
 * So 5 (weekly, no collector) to 8 (monthly with a collector) reads.
 *
 * `{ members: true }` adds the roster: one membership read, then
 * `loadPlayerNames` (two to five reads of its own) and `withAliases` (one).
 * The scheduler does not need names for most jobs, so it is off by default.
 *
 * Two ways to read less (slice A1, the due-posts poll), each for rows the
 * caller has already read IN THIS REQUEST:
 *   - `org`: the club's row, read with `CLUB_ORG_SELECT` (the poll finds
 *     the club by its WhatsApp group with it), so read 1 is not repeated;
 *   - `features` with `org` (slice A2, the analyze route): the switches of
 *     that same row, `orgFeaturesFromRow` over it, so read 2 is not either;
 *   - `keep`: the switches, the collector's name, the games and the
 *     last-played candidates of an earlier summary of the same poll, which
 *     the writes since cannot have changed (the month sweeps write months,
 *     attendance and matches still to be played, never the club's row, its
 *     switches, its collector, its games or a match already played). Only
 *     the matches, the months and the held keys are read again.
 *
 * No cache here: `scope.ts` memoises a summary for one request or one poll.
 */
import { db } from "../db";
import { getOrgFeatures, type OrgFeatures } from "../org-features";
import { SETUP_STAGE_SELECT } from "../club-setup-rules";
import { loadPlayerNames } from "../player-display-name";
import { withAliases } from "../member-aliases";
import { normaliseLang } from "../i18n/lang";
import { londonMonthStart, monthStartToDate, normaliseSquadMode } from "../squad-month-rules";
import { nextMonthStart } from "../month-signup-rules";
import { closedLatelyWhere, schedulerMatchWhere } from "../scheduler-windows";
import { buildClubSummary, type ClubRows, type MemberRows, type OrgRow } from "./derive";
import type { ClubSummary } from "./types";

/**
 * The Organisation columns the summary reads: its read 1. Exported so a
 * caller that must find the club itself (the due-posts poll, by its
 * WhatsApp group) reads them in that one query and hands the row in.
 */
export const CLUB_ORG_SELECT = {
  id: true,
  name: true,
  language: true,
  whatsappGroupId: true,
  whatsappBotEnabled: true,
  dormantAt: true,
  approvedAt: true,
  ...SETUP_STAGE_SELECT,
  billingStatus: true,
  liveAt: true,
  adminGroupId: true,
  adminChannelMode: true,
  adminChannelUserId: true,
  listAnnouncer: true,
  momChosenBy: true,
  benchPickMode: true,
  benchPickFallback: true,
  teamsReadyTime: true,
  quietHoursEnabled: true,
  quietHoursFrom: true,
  quietHoursTo: true,
  dropOutDeadlineDay: true,
  dropOutDeadlineTime: true,
  listPublishDay: true,
  listPublishTime: true,
  seasonBreakMonths: true,
  monthListOpensDaysBefore: true,
  paymentTrackingEnabled: true,
  paymentCollectionEnabled: true,
  stripeConnectAccountId: true,
  stripeChargesEnabled: true,
  payMethodPayByBank: true,
  payMethodCard: true,
  payMethodDirect: true,
  paymentHolderId: true,
  paymentInstructions: true,
  squadMode: true,
  rollingSquadEnabled: true,
  paygPricePence: true,
  monthCreditRule: true,
  teamLabels: true,
} as const;

export interface LoadClubOptions {
  /** With the roster (`members`); off by default. */
  members?: boolean;
  /** The club's row, already read in this request with `CLUB_ORG_SELECT`. */
  org?: OrgRow | null;
  /** The switches of that same row (`orgFeaturesFromRow` over it, read with
   *  `ORG_FEATURES_SELECT` too): the analyze route reads both in the one
   *  query that finds the club by its group, so read 2 is not repeated.
   *  Only with `org`, and only for that club. */
  features?: OrgFeatures;
  /** An earlier summary's rows of this club in this request that the
   *  writes since cannot have changed (see the header). */
  keep?: Pick<ClubRows, "features" | "collectorName" | "activities" | "lastPlayed">;
}

export async function loadClubSummary(orgId: string, now: Date, opts: LoadClubOptions = {}): Promise<ClubSummary | null> {
  const rows = await loadClubRows(orgId, now, opts);
  return rows ? buildClubSummary(rows, now) : null;
}

/** The rows `buildClubSummary` is built from, as read now. */
export async function loadClubRows(orgId: string, now: Date, opts: LoadClubOptions = {}): Promise<ClubRows | null> {
  const given = opts.org && opts.org.id === orgId ? opts.org : null;
  const [org, features] = await Promise.all([
    given ? Promise.resolve(given) : db.organisation.findUnique({ where: { id: orgId }, select: CLUB_ORG_SELECT }),
    opts.keep ? Promise.resolve(opts.keep.features) : given && opts.features ? Promise.resolve(opts.features) : getOrgFeatures(orgId),
  ]);
  if (!org) return null;

  const [collectorName, activities, matches, lastPlayed] = await Promise.all([
    opts.keep
      ? Promise.resolve(opts.keep.collectorName)
      : org.paymentHolderId
        ? db.user.findUnique({ where: { id: org.paymentHolderId }, select: { name: true } }).then((u) => u?.name ?? null)
        : Promise.resolve(null),
    opts.keep ? Promise.resolve(opts.keep.activities) : db.activity.findMany({
      where: { orgId },
      select: {
        id: true,
        name: true,
        isActive: true,
        dayOfWeek: true,
        time: true,
        venue: true,
        matchDurationMins: true,
        minPlayers: true,
        maxPlayers: true,
        feePerPlayer: true,
        feeSplitTotal: true,
        createdAt: true,
        sport: { select: { name: true, playersPerTeam: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    // The scheduler's own `where` (scheduler-windows.ts, getMatchesForScheduler's).
    db.match.findMany({
      where: schedulerMatchWhere(orgId, now),
      select: {
        id: true,
        activityId: true,
        date: true,
        status: true,
        maxPlayers: true,
        attendanceDeadline: true,
        feePerPlayer: true,
        feePendingConfirm: true,
        paymentLinksReleasedAt: true,
        rollingSeededAt: true,
        attendances: { select: { status: true } },
        _count: { select: { teamAssignments: true } },
      },
      orderBy: { date: "asc" },
    }),
    // loadSquadState's "last match actually played" read (pipeline/load-state.ts).
    opts.keep ? Promise.resolve(opts.keep.lastPlayed) : db.match.findMany({
      where: { activity: { orgId }, status: { in: ["TEAMS_GENERATED", "TEAMS_PUBLISHED", "COMPLETED"] }, date: { lte: now } },
      select: { id: true, date: true, activity: { select: { matchDurationMins: true } } },
      orderBy: { date: "desc" },
      take: 10,
    }),
  ]);

  const monthly = normaliseSquadMode(org.squadMode) === "monthly";
  const [months, held, members] = await Promise.all([
    monthly ? loadMonths(orgId, now, matches.map((m) => m.date)) : Promise.resolve([]),
    monthly
      ? db.sentNotification.findMany({ where: { key: { startsWith: `org-${orgId}:msu:held:` } }, select: { key: true } })
      : Promise.resolve([] as Array<{ key: string }>),
    opts.members ? loadMembers(orgId, org.language) : Promise.resolve(null),
  ]);

  return {
    org,
    features,
    collectorName,
    activities,
    matches,
    lastPlayed,
    months,
    heldKeys: held.map((h) => h.key),
    members,
  };
}

/**
 * The SquadMonth rows today's consumers look at, in one read:
 *   - running, and closed in the last two weeks (`loadSchedulerMonths`);
 *   - any status, for the London month of every loaded match and for this
 *     and next month (`loadLiveMonths`' open, priced or running of this and
 *     next month; `monthNotStartedFor`'s any-status row for a match's month;
 *     the seed door's any month of this or next month).
 */
async function loadMonths(orgId: string, now: Date, matchDates: Date[]) {
  const current = londonMonthStart(now);
  const starts = [...new Set([current, nextMonthStart(current), ...matchDates.map(londonMonthStart)])].sort();
  return db.squadMonth.findMany({
    where: {
      orgId,
      OR: [
        { status: "running" },
        closedLatelyWhere(now),
        { monthStart: { in: starts.map(monthStartToDate) } },
      ],
    },
    select: {
      id: true,
      activityId: true,
      monthStart: true,
      status: true,
      listOpenedAt: true,
      pricedAt: true,
      closedAt: true,
      createdAt: true,
      startedMidMonthAt: true,
      members: { where: { leftAt: null }, select: { kind: true, paidAt: true, paidClaimedAt: true } },
    },
    orderBy: [{ monthStart: "asc" }, { id: "asc" }],
  });
}

/** `loadSquadState`'s roster read, in one stable order, with the printed
 *  line (`loadPlayerNames`) and the club's aliases (`withAliases`). */
async function loadMembers(orgId: string, language: string): Promise<MemberRows> {
  const rows = await db.membership.findMany({
    where: { orgId, leftAt: null },
    select: { id: true, createdAt: true, role: true, user: { select: { id: true, name: true, phoneNumber: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const ids = rows.map((r) => r.user.id);
  const [names, aliased] = await Promise.all([
    loadPlayerNames(orgId, ids, normaliseLang(language)),
    withAliases(orgId, ids.map((userId) => ({ userId }))),
  ]);
  return {
    rows,
    displayNames: Object.fromEntries([...names].map(([id, n]) => [id, n.display])),
    aliases: Object.fromEntries(aliased.flatMap((a) => (a.aliases ? [[a.userId, a.aliases]] : []))),
  };
}
