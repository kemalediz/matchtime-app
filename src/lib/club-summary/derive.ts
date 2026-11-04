/**
 * THE CLUB SUMMARY'S DERIVE FUNCTIONS (slice A0). PURE: no Prisma, no
 * clock but the `now` passed in, no model.
 *
 * One function per derived fact. Each CALLS the existing rule module that
 * owns the fact and stores its answer; none re-implements a rule. Where no
 * rule module exists today and the fact is computed inline at its call
 * sites, the function cites those lines, and the slice that moves those
 * call sites onto the summary deletes the inline copies (plan section 4.2).
 *
 * `buildClubSummary(rows, now)` assembles a `ClubSummary` from the raw rows
 * `load.ts` reads, so the whole summary is testable from fixtures.
 */
import type { OrgFeatures } from "../org-features";
import type {
  ClubRowFacts,
  ClubSummary,
  GameFacts,
  LifecycleFacts,
  MatchFacts,
  MatchMonthFacts,
  MatchStatus,
  MembersFacts,
  MonthFacts,
  MonthPhase,
  PaymentFacts,
  RoutineFacts,
  SquadFacts,
} from "./types";
import { normaliseLang } from "../i18n/lang";
import { isOrgDormant } from "../org-lifecycle";
import { isClubApproved, isClubOperational } from "../club-approval-state";
import { isBillingPaused } from "../club-billing-rules";
import { isClubSettingUp, type SetupStageColumns } from "../club-setup-rules";
import { paymentMessagesOn } from "../payment-messages";
import { availablePayMethods } from "../payments";
import { normaliseListAnnouncer, organisersAnnounce } from "../list-announcer";
import { normaliseMomChooser } from "../mom-chooser";
import { normaliseBenchPickFallback, normaliseBenchPickMode } from "../squad-capacity";
import { effectiveTeamsReadyTime } from "../team-proposal-rules";
import { quietHoursOf } from "../message-hours";
import { hasWeeklyRhythm, weeklyDeadlinesFor } from "../weekly-deadlines";
import { londonMonthStart, normaliseCreditRule, normaliseSquadMode } from "../squad-month-rules";
import { londonDateTimeToUtc } from "../london-time";
import { formatMinimum, minimumToPlay } from "../min-players";
import { playerRange } from "../flex-format-rules";
import { totalPlayersFor } from "../format-switch";
import { isSquadShort, shortBelow } from "../squad-short";
import { selectRegistrationMatch } from "../registration-match-select";
import { isNextUpcomingForPosting, type SchedulerMatch } from "../next-upcoming-match";
import { isSameRecurringFixture } from "../match-slot";

// ── The raw rows (what load.ts selects) ────────────────────────────────

/** The Organisation columns the summary reads (the setup stage through
 *  `SetupStageColumns`, the only way club-setup-rules.ts lets it be read). */
export interface OrgRow extends SetupStageColumns {
  id: string;
  name: string;
  language: string;
  whatsappGroupId: string | null;
  whatsappBotEnabled: boolean;
  dormantAt: Date | null;
  approvedAt: Date | null;
  approvalStatus: string;
  billingStatus: string;
  liveAt: Date | null;
  adminGroupId: string | null;
  adminChannelMode: string;
  adminChannelUserId: string | null;
  listAnnouncer: string;
  momChosenBy: string;
  benchPickMode: string;
  benchPickFallback: string;
  teamsReadyTime: string | null;
  quietHoursEnabled: boolean;
  quietHoursFrom: string;
  quietHoursTo: string;
  dropOutDeadlineDay: number | null;
  dropOutDeadlineTime: string | null;
  listPublishDay: number | null;
  listPublishTime: string | null;
  seasonBreakMonths: string[];
  monthListOpensDaysBefore: number;
  paymentTrackingEnabled: boolean;
  paymentCollectionEnabled: boolean;
  stripeConnectAccountId: string | null;
  stripeChargesEnabled: boolean;
  payMethodPayByBank: boolean;
  payMethodCard: boolean;
  payMethodDirect: boolean;
  paymentHolderId: string | null;
  paymentInstructions: string | null;
  squadMode: string;
  rollingSquadEnabled: boolean;
  paygPricePence: number | null;
  monthCreditRule: string;
  /** The club's own names for the two sides, as stored. */
  teamLabels: string[];
}

export interface ActivityRow {
  id: string;
  name: string;
  isActive: boolean;
  dayOfWeek: number;
  time: string;
  venue: string;
  matchDurationMins: number;
  minPlayers: number | null;
  maxPlayers: number | null;
  feePerPlayer: number | null;
  feeSplitTotal: boolean;
  createdAt: Date;
  sport: { name: string; playersPerTeam: number };
}

export interface MatchRow {
  id: string;
  activityId: string;
  date: Date;
  status: string;
  maxPlayers: number;
  attendanceDeadline: Date;
  feePerPlayer: number | null;
  feePendingConfirm: number | null;
  paymentLinksReleasedAt: Date | null;
  rollingSeededAt: Date | null;
  attendances: Array<{ status: string }>;
  _count: { teamAssignments: number };
}

export interface LastPlayedRow {
  id: string;
  date: Date;
  activity: { matchDurationMins: number };
}

export interface MonthRow {
  id: string;
  activityId: string;
  monthStart: Date;
  status: string;
  listOpenedAt: Date | null;
  pricedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  startedMidMonthAt: Date | null;
  /** The month's member rows with `leftAt` null. */
  members: Array<{ kind: string; paidAt: Date | null; paidClaimedAt: Date | null }>;
}

export interface MemberRow {
  /** The membership's id (the tie-break of the roster order). */
  id: string;
  createdAt: Date;
  role: "OWNER" | "ADMIN" | "PLAYER" | string;
  user: { id: string; name: string | null; phoneNumber: string | null };
}

export interface MemberRows {
  rows: MemberRow[];
  /** `loadPlayerNames(...).get(userId)?.display`, by userId. */
  displayNames: Record<string, string>;
  /** This club's aliases (`withAliases`), by userId. */
  aliases: Record<string, string[]>;
}

/** Everything `buildClubSummary` needs, as `loadClubSummary` reads it. */
export interface ClubRows {
  org: OrgRow;
  /** `getOrgFeatures(orgId)`, passed through untouched. */
  features: OrgFeatures;
  /** `User.name` of `paymentHolderId`, as `loadClubSnapshot` reads it. */
  collectorName: string | null;
  /** `isPaymentCollectionLive(org)`: computed by the loader because its
   *  module (payments-live-announce.ts) imports the database client. */
  collectionLive: boolean;
  activities: ActivityRow[];
  matches: MatchRow[];
  lastPlayed: LastPlayedRow[];
  /** Monthly clubs only; [] for a weekly club. */
  months: MonthRow[];
  /** The club's held-month `SentNotification` keys; [] for a weekly club. */
  heldKeys: string[];
  members: MemberRows | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

// ── Club-level facts ───────────────────────────────────────────────────

export function lifecycleFacts(org: OrgRow): LifecycleFacts {
  return {
    botOn: org.whatsappBotEnabled,
    dormant: isOrgDormant(org),
    approved: isClubApproved(org),
    settingUp: isClubSettingUp(org),
    billingPaused: isBillingPaused(org),
    operational: isClubOperational(org),
    liveAt: iso(org.liveAt),
    approvedAt: iso(org.approvedAt),
  };
}

export function paymentFacts(org: OrgRow, extra: { collectorName: string | null; collectionLive: boolean }): PaymentFacts {
  const methods = availablePayMethods(org);
  return {
    tracking: org.paymentTrackingEnabled,
    collection: org.paymentCollectionEnabled,
    messagesOn: paymentMessagesOn(org),
    stripe: { accountConnected: !!org.stripeConnectAccountId, chargesEnabled: org.stripeChargesEnabled },
    collectionLive: extra.collectionLive,
    methods: { payByBank: methods.includes("pay_by_bank"), card: methods.includes("card"), direct: methods.includes("direct") },
    collector: org.paymentHolderId ? { userId: org.paymentHolderId, name: extra.collectorName } : null,
    instructions: org.paymentInstructions,
  };
}

export function routineFacts(org: OrgRow): RoutineFacts {
  return {
    listAnnouncer: normaliseListAnnouncer(org.listAnnouncer),
    momChosenBy: normaliseMomChooser(org.momChosenBy),
    benchPickMode: normaliseBenchPickMode(org.benchPickMode),
    benchPickFallback: normaliseBenchPickFallback(org.benchPickFallback),
    teamsReady: effectiveTeamsReadyTime(org.teamsReadyTime, organisersAnnounce(org)),
    quietHours: quietHoursOf(org),
    weeklyDeadlineSettings: {
      dropOutDeadlineDay: org.dropOutDeadlineDay,
      dropOutDeadlineTime: org.dropOutDeadlineTime,
      listPublishDay: org.listPublishDay,
      listPublishTime: org.listPublishTime,
    },
    weeklyRhythm: hasWeeklyRhythm(org),
    seasonBreakMonths: [...org.seasonBreakMonths],
    monthListOpensDaysBefore: org.monthListOpensDaysBefore,
  };
}

export function squadFacts(org: OrgRow, months: MonthFacts[]): SquadFacts {
  return {
    mode: normaliseSquadMode(org.squadMode),
    rolling: org.rollingSquadEnabled,
    paygPricePence: org.paygPricePence ?? null,
    creditRule: normaliseCreditRule(org.monthCreditRule),
    months,
  };
}

/**
 * The summary's facts of the club's row alone (`ClubRowFacts`, slice A3):
 * the same derive functions `buildClubSummary` runs on the same row, with
 * the switches of that row, and no other read. `features` is
 * `orgFeaturesFromRow` of the row the caller read with
 * `ORG_FEATURES_SELECT`, exactly what `getOrgFeatures` would return.
 */
export function clubRowFacts(org: OrgRow, features: OrgFeatures): ClubRowFacts {
  const { months: _months, ...squad } = squadFacts(org, []);
  const { collector, collectionLive: _live, ...payments } = paymentFacts(org, { collectorName: null, collectionLive: false });
  return {
    orgId: org.id,
    name: org.name,
    language: normaliseLang(org.language),
    lifecycle: lifecycleFacts(org),
    groups: groupFacts(org),
    features,
    teamLabels: teamLabelsOf(org),
    routine: { ...routineFacts(org), teamsReadyChosen: org.teamsReadyTime != null },
    squad,
    payments: {
      ...payments,
      collector: collector ? { userId: collector.userId } : null,
      switches: { payByBank: org.payMethodPayByBank, card: org.payMethodCard, direct: org.payMethodDirect },
    },
  };
}

function groupFacts(org: OrgRow): ClubSummary["groups"] {
  return { playersGroupId: org.whatsappGroupId, hq: { groupId: org.adminGroupId, channelMode: org.adminChannelMode, channelUserId: org.adminChannelUserId } };
}

// A row read by an older select (a test's partial world) has none: [].
const teamLabelsOf = (org: OrgRow): string[] => [...(org.teamLabels ?? [])];

// ── Games ──────────────────────────────────────────────────────────────

/**
 * The sport family: the first word of the sport's name. Computed inline
 * today at bot-scheduler.ts (`findSmallerSameSportActivity`,
 * `findMinimumToPlay`) and message-analyzer.ts (the chase's smaller
 * formats); there is no rule module for it yet.
 */
function sportFamily(sportName: string): string {
  return sportName.split(" ")[0];
}

const gameFormat = (a: ActivityRow) => ({ minPlayers: a.minPlayers ?? null, playersPerTeam: a.sport.playersPerTeam });

export function gameFacts(activities: ActivityRow[]): GameFacts[] {
  return activities.map((a) => {
    const family = sportFamily(a.sport.name);
    const sameFamily = activities.filter((b) => sportFamily(b.sport.name) === family);
    return {
      activityId: a.id,
      name: a.name,
      active: a.isActive,
      dayOfWeek: a.dayOfWeek,
      time: a.time,
      venue: a.venue,
      matchDurationMins: a.matchDurationMins,
      sport: { name: a.sport.name, family, playersPerTeam: a.sport.playersPerTeam },
      formatPlaces: totalPlayersFor(a.sport.playersPerTeam),
      minPlayers: a.minPlayers ?? null,
      maxPlayers: a.maxPlayers ?? null,
      fewestToPlay: formatMinimum(gameFormat(a)),
      range: playerRange({ minPlayers: a.minPlayers ?? null, maxPlayers: a.maxPlayers ?? null, playersPerTeam: a.sport.playersPerTeam }),
      fewestAnyFormat: minimumToPlay(gameFormat(a), sameFamily.map(gameFormat)),
      fee: { perPlayer: a.feePerPlayer ?? null, splitTotal: a.feeSplitTotal },
    };
  });
}

// ── A match's numbers ──────────────────────────────────────────────────

/**
 * Places open and "short", two facts (D1). `placesOpen` is the scheduler's
 * `need`; `shortBelow` and `short` are squad-short.ts's.
 */
export function matchNumbers(p: { places: number; confirmed: number; minPlayers: number | null; playersPerTeam: number }): {
  placesOpen: number;
  shortBelow: number;
  short: boolean;
} {
  const g = { minPlayers: p.minPlayers, maxPlayers: p.places, playersPerTeam: p.playersPerTeam };
  return {
    placesOpen: Math.max(0, p.places - p.confirmed),
    shortBelow: shortBelow(g),
    short: isSquadShort(p.confirmed, g),
  };
}

// ── Months ─────────────────────────────────────────────────────────────

const monthStartOf = (d: Date) => d.toISOString().slice(0, 10);

export function monthFacts(months: MonthRow[], activities: ActivityRow[]): MonthFacts[] {
  return months.flatMap((m) => {
    const a = activities.find((x) => x.id === m.activityId);
    if (!a) return [];
    const monthStart = monthStartOf(m.monthStart);
    const regulars = m.members.filter((r) => r.kind !== "payg");
    return [
      {
        id: m.id,
        activityId: m.activityId,
        fixture: { venue: a.venue, dayOfWeek: a.dayOfWeek },
        monthStart,
        status: m.status,
        listOpenedAt: iso(m.listOpenedAt),
        pricedAt: iso(m.pricedAt),
        closedAt: iso(m.closedAt),
        createdAt: m.createdAt.toISOString(),
        // `RunningMonth.startsAt` (monthly-week.ts `loadMonthsWhere`).
        startsAt: (m.startedMidMonthAt ?? londonDateTimeToUtc(monthStart, "00:00")).toISOString(),
        startedPartWay: m.startedMidMonthAt !== null,
        regulars: regulars.length,
        // `RunningMonth.paid`: paidAt is confirmed, else paidClaimedAt is claimed.
        paid: {
          confirmed: regulars.filter((r) => r.paidAt).length,
          claimed: regulars.filter((r) => !r.paidAt && r.paidClaimedAt).length,
        },
      },
    ];
  });
}

/**
 * A held month's key: `org-<orgId>:msu:held:<YYYY-MM-01>:<activityId>`
 * (`signupKeyPrefix` in month-signup.ts plus "held:"), parsed the way the
 * scheduler parses it today (bot-scheduler.ts, the held read in
 * `computeDuePosts`).
 */
export function parseHeldKey(orgId: string, key: string): { monthStart: string; activityId: string } | null {
  const prefix = `org-${orgId}:msu:held:`;
  if (!key.startsWith(prefix)) return null;
  return { monthStart: key.slice(prefix.length, prefix.length + 10), activityId: key.slice(prefix.length + 11) };
}

const PHASE_OF_STATUS: Record<string, MonthPhase> = { open: "signup", priced: "priced", running: "running", closed: "closed" };
/** With two rows for one fixture and month, the one furthest on. */
const PHASE_RANK: Record<MonthPhase, number> = { running: 4, closed: 3, signup: 2, priced: 1, held: 0, none: 0 };

/** "Is this a month's game, and where is that month" for one match. */
export function monthPhaseFor(p: {
  orgId: string;
  match: Pick<MatchRow, "activityId" | "date" | "rollingSeededAt">;
  months: MonthFacts[];
  activities: ActivityRow[];
  heldKeys: string[];
}): MatchMonthFacts {
  const own = p.activities.find((a) => a.id === p.match.activityId);
  const fixture = own ? { orgId: p.orgId, venue: own.venue, dayOfWeek: own.dayOfWeek } : null;
  const monthStart = londonMonthStart(p.match.date);
  const sameFixture = (venue: string, dayOfWeek: number) => fixture !== null && isSameRecurringFixture(fixture, { orgId: p.orgId, venue, dayOfWeek });

  const rows = p.months
    .filter((m) => m.monthStart === monthStart && sameFixture(m.fixture.venue, m.fixture.dayOfWeek) && PHASE_OF_STATUS[m.status])
    .sort((a, b) => PHASE_RANK[PHASE_OF_STATUS[b.status]] - PHASE_RANK[PHASE_OF_STATUS[a.status]]);
  const row = rows[0] ?? null;

  const held = p.heldKeys.some((k) => {
    const h = parseHeldKey(p.orgId, k);
    if (!h || h.monthStart !== monthStart) return false;
    const a = p.activities.find((x) => x.id === h.activityId);
    return !!a && sameFixture(a.venue, a.dayOfWeek);
  });

  return {
    monthStart,
    phase: row ? PHASE_OF_STATUS[row.status] : held ? "held" : "none",
    monthId: row?.id ?? null,
    listOpened: row?.listOpenedAt != null,
    held,
    beforeStart: row ? p.match.date.getTime() < new Date(row.startsAt).getTime() : false,
    // bot-scheduler.ts and monthly-week.ts, inline: seeded after the month was made.
    seeded: !!row && p.match.rollingSeededAt != null && p.match.rollingSeededAt.getTime() >= new Date(row.createdAt).getTime(),
    rowForOwnActivity: p.months.some((m) => m.monthStart === monthStart && m.activityId === p.match.activityId),
  };
}

// ── Which match ────────────────────────────────────────────────────────

/**
 * The registration match (`selectRegistrationMatch`) and, per match, the
 * posting rule (`isNextUpcomingForPosting`) with and without the
 * cancelled-day hold.
 */
export function pickNextMatch(p: { orgId: string; matches: MatchRow[]; activities: ActivityRow[]; now: Date }): {
  nextMatchId: string | null;
  nextForPosting: Map<string, { withHold: boolean; withoutHold: boolean }>;
} {
  const asScheduler: SchedulerMatch[] = p.matches.map((m) => {
    const a = p.activities.find((x) => x.id === m.activityId);
    return {
      id: m.id,
      activityId: m.activityId,
      date: m.date,
      status: m.status,
      isHistorical: false,
      ...(a ? { activity: { orgId: p.orgId, venue: a.venue, dayOfWeek: a.dayOfWeek } } : {}),
    };
  });
  const nextForPosting = new Map(
    asScheduler.map((m) => [m.id, { withHold: isNextUpcomingForPosting(asScheduler, m, p.now), withoutHold: isNextUpcomingForPosting(asScheduler, m) }] as const),
  );
  const next = selectRegistrationMatch(p.matches.map((m) => ({ id: m.id, date: m.date, status: m.status })), p.now);
  return { nextMatchId: next?.id ?? null, nextForPosting };
}

/**
 * The last match actually played: of the candidates (most recent first),
 * the first whose kickoff plus duration has passed. `loadSquadState`'s rule
 * (pipeline/load-state.ts, "THE LAST MATCH ACTUALLY PLAYED"), inline there.
 */
export function lastPlayedMatchIdOf(candidates: LastPlayedRow[], now: Date): string | null {
  return candidates.find((m) => m.date.getTime() + m.activity.matchDurationMins * 60 * 1000 <= now.getTime())?.id ?? null;
}

// ── Members ────────────────────────────────────────────────────────────

/** One stable order: membership createdAt, then its id (#520's rule). */
export function sortRoster(m: MemberRows): MembersFacts {
  const rows = [...m.rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const roster = rows.map((r) => {
    const name = r.user.name ?? "";
    return {
      userId: r.user.id,
      name,
      displayName: m.displayNames[r.user.id] ?? name,
      aliases: [...(m.aliases[r.user.id] ?? [])].sort(),
      isAdmin: r.role === "OWNER" || r.role === "ADMIN",
      hasPhone: !!r.user.phoneNumber,
    };
  });
  return { roster, adminUserIds: roster.filter((r) => r.isAdmin).map((r) => r.userId) };
}

// ── The whole summary ──────────────────────────────────────────────────

export function buildClubSummary(rows: ClubRows, now: Date): ClubSummary {
  const { org } = rows;
  const squad = squadFacts(org, normaliseSquadMode(org.squadMode) === "monthly" ? monthFacts(rows.months, rows.activities) : []);
  const games = gameFacts(rows.activities);
  const picked = pickNextMatch({ orgId: org.id, matches: rows.matches, activities: rows.activities, now });

  const matches: MatchFacts[] = [...rows.matches]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((m) => {
      const game = games.find((g) => g.activityId === m.activityId);
      const ppt = game?.sport.playersPerTeam ?? Math.floor(m.maxPlayers / 2);
      const confirmed = m.attendances.filter((a) => a.status === "CONFIRMED").length;
      const deadlines = weeklyDeadlinesFor(m.date, org);
      return {
        id: m.id,
        activityId: m.activityId,
        kickoffAt: m.date.toISOString(),
        // The Prisma enum `MatchStatus`: always one of the five.
        status: m.status as MatchStatus,
        places: m.maxPlayers,
        confirmed,
        bench: m.attendances.filter((a) => a.status === "BENCH").length,
        ...matchNumbers({ places: m.maxPlayers, confirmed, minPlayers: game?.minPlayers ?? null, playersPerTeam: ppt }),
        fewestAnyFormat: game?.fewestAnyFormat ?? ppt * 2,
        teamsMade: m._count.teamAssignments > 0,
        fee: { matchFee: m.feePerPlayer ?? null, pendingConfirm: m.feePendingConfirm ?? null, linksReleased: m.paymentLinksReleasedAt !== null },
        nextForPosting: picked.nextForPosting.get(m.id) ?? { withHold: false, withoutHold: false },
        weeklyDeadlines: { dropOut: iso(deadlines.dropOut), listPublish: iso(deadlines.listPublish) },
        attendanceDeadline: m.attendanceDeadline.toISOString(),
        month:
          squad.mode === "monthly"
            ? monthPhaseFor({ orgId: org.id, match: m, months: squad.months, activities: rows.activities, heldKeys: rows.heldKeys })
            : null,
      };
    });

  return {
    orgId: org.id,
    name: org.name,
    asOf: now.toISOString(),
    language: normaliseLang(org.language),
    lifecycle: lifecycleFacts(org),
    groups: {
      playersGroupId: org.whatsappGroupId,
      hq: { groupId: org.adminGroupId, channelMode: org.adminChannelMode, channelUserId: org.adminChannelUserId },
    },
    features: rows.features,
    // A row read by an older select (a test's partial world) has none: [].
    teamLabels: [...(org.teamLabels ?? [])],
    routine: routineFacts(org),
    payments: paymentFacts(org, { collectorName: rows.collectorName, collectionLive: rows.collectionLive }),
    squad,
    games,
    matches,
    nextMatchId: picked.nextMatchId,
    lastPlayedMatchId: lastPlayedMatchIdOf(rows.lastPlayed, now),
    members: rows.members ? sortRoster(rows.members) : null,
  };
}
