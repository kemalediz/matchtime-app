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
 * No cache here: `scope.ts` memoises a summary for one request or one poll.
 */
import { db } from "../db";
import { getOrgFeatures } from "../org-features";
import { isPaymentCollectionLive } from "../payments-live-announce";
import { loadPlayerNames } from "../player-display-name";
import { withAliases } from "../member-aliases";
import { normaliseLang } from "../i18n/lang";
import { londonMonthStart, monthStartToDate, normaliseSquadMode } from "../squad-month-rules";
import { nextMonthStart } from "../month-signup-rules";
import { buildClubSummary, type MemberRows } from "./derive";
import type { ClubSummary } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The scheduler's windows. Mirrors of bot-scheduler.ts's
 * `POST_MATCH_LOOKBACK_DAYS` (`MOM_ANNOUNCE_MAX_AGE_DAYS + 1`) and
 * `CANCELLED_HOLD_LOOKBACK_MS`, kept here so this module does not import
 * the scheduler; `__tests__/load-windows.test.ts` fails if they drift. A1
 * makes the scheduler read these instead.
 */
export const POST_MATCH_LOOKBACK_DAYS = 10;
export const CANCELLED_HOLD_LOOKBACK_MS = DAY_MS;
/** monthly-week.ts `CLOSED_MONTH_GATE_DAYS`: how long a closed month still
 *  answers for its played games (`loadSchedulerMonths`). */
export const CLOSED_MONTH_GATE_DAYS = 14;

const ORG_SELECT = {
  id: true,
  name: true,
  language: true,
  whatsappGroupId: true,
  whatsappBotEnabled: true,
  dormantAt: true,
  approvalStatus: true,
  setupStage: true,
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
} as const;

const LIVE_STATUSES = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;

export async function loadClubSummary(orgId: string, now: Date, opts: { members?: boolean } = {}): Promise<ClubSummary | null> {
  const [org, features] = await Promise.all([
    db.organisation.findUnique({ where: { id: orgId }, select: ORG_SELECT }),
    getOrgFeatures(orgId),
  ]);
  if (!org) return null;

  const [collector, activities, matches, lastPlayed] = await Promise.all([
    org.paymentHolderId ? db.user.findUnique({ where: { id: org.paymentHolderId }, select: { name: true } }) : Promise.resolve(null),
    db.activity.findMany({
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
    // getMatchesForScheduler's where (bot-scheduler.ts).
    db.match.findMany({
      where: {
        activity: { orgId },
        isHistorical: false,
        OR: [
          { status: { in: [...LIVE_STATUSES] } },
          { status: "COMPLETED", date: { gte: new Date(now.getTime() - POST_MATCH_LOOKBACK_DAYS * DAY_MS) } },
          { status: "CANCELLED", date: { gte: new Date(now.getTime() - CANCELLED_HOLD_LOOKBACK_MS) } },
        ],
      },
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
    db.match.findMany({
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

  return buildClubSummary(
    {
      org,
      features,
      collectorName: collector?.name ?? null,
      collectionLive: isPaymentCollectionLive(org),
      activities,
      matches,
      lastPlayed,
      months,
      heldKeys: held.map((h) => h.key),
      members,
    },
    now,
  );
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
        { status: "closed", closedAt: { gte: new Date(now.getTime() - CLOSED_MONTH_GATE_DAYS * DAY_MS) } },
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
