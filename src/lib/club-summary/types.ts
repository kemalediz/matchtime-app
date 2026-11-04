/**
 * ONE SUMMARY OF THE CLUB (slice A0, MDs/club-summary-design-2026-11-04.md,
 * section 3). The TYPE only: no Prisma, no runtime code, so a client
 * component, `compose.ts` and the Playwright worker can import it.
 *
 * A plain list of FACTS about one club at one instant. Every field is
 * something a person could check on the admin screens. Two rules keep it
 * that way, and `__tests__/shape-guard.test.ts` enforces both:
 *   - no field is a function (and a built summary survives a JSON round
 *     trip unchanged: no Date, Map, Set or class instance);
 *   - no field names an action (`should*`, `skip*`, `send*`, `allow*`,
 *     `can*`). A consumer decides; it decides from a fact named here.
 *
 * Where two consumers disagree today about one fact (the plan's section
 * 2.3, D1 to D15), Phase A must stay byte-identical, so the summary carries
 * EACH of today's values under its own name and picks no winner. The
 * comment on each field says which existing rule it comes from. Phase B
 * removes the duplicates, one disagreement per PR.
 *
 * Counts (`confirmed`, `bench`, the month's `paid`) are as of `asOf`, i.e.
 * BEFORE any write the request makes after loading it (plan 3.4, 5.1).
 */
import type { OrgFeatures } from "../org-features";
import type { Lang } from "../i18n/lang";
import type { QuietHours } from "../message-hours";
import type { ListAnnouncer } from "../list-announcer";
import type { MomChooser } from "../mom-chooser";
import type { BenchPickFallback, BenchPickMode } from "../squad-capacity";
import type { MonthCreditRule, SquadMode } from "../squad-month-rules";

export interface ClubSummary {
  orgId: string;
  name: string;
  /** The instant it describes, ISO. Every derived fact is "as of" this. */
  asOf: string;
  /** `Organisation.language` through `normaliseLang` (same as `features.language`). */
  language: Lang;

  lifecycle: LifecycleFacts;
  groups: GroupFacts;

  /** The switches, exactly as `getOrgFeatures` returns them (it IS that call). */
  features: OrgFeatures;

  routine: RoutineFacts;
  payments: PaymentFacts;
  squad: SquadFacts;

  /** Every Activity of the club, active and inactive, oldest first. Today's
   *  "smaller formats" rules (D12) read active-only in one place and all in
   *  two, so both are here and `active` says which. */
  games: GameFacts[];

  /**
   * The club's matches the scheduler looks at (`getMatchesForScheduler`,
   * bot-scheduler.ts): every live match of any date, the COMPLETED ones of
   * the last `POST_MATCH_LOOKBACK_DAYS`, the CANCELLED ones of the last 24
   * hours (kept for the cancelled-day hold only). Never `isHistorical`.
   * Oldest first.
   */
  matches: MatchFacts[];
  /** THE registration match, where an IN lands: `selectRegistrationMatch`
   *  over `matches` at `asOf`. Null when none, or blocked by a match still
   *  in flight. */
  nextMatchId: string | null;
  /** The last match actually played: `loadSquadState`'s rule (the ten most
   *  recent TEAMS_GENERATED, TEAMS_PUBLISHED or COMPLETED kicked off by
   *  `asOf`, the first whose kickoff plus duration has passed). Its own read:
   *  it may be older than `matches` reaches, and it may be historical. */
  lastPlayedMatchId: string | null;

  /** Null when loaded with `{ members: false }` (the scheduler's default). */
  members: MembersFacts | null;
}

export interface LifecycleFacts {
  /** `whatsappBotEnabled`: the mute switch. */
  botOn: boolean;
  /** `isOrgDormant` (org-lifecycle.ts): `dormantAt` set. */
  dormant: boolean;
  /** `approvalStatus` as stored ("draft", "pending", "approved", ...). */
  approvalStatus: string;
  /** `isClubApproved` (club-approval-state.ts). */
  approved: boolean;
  /** `setupStage` as stored ("live" or "setting-up"). */
  setupStage: string;
  /** `isClubSettingUp` (club-setup-rules.ts). */
  settingUp: boolean;
  /** `billingStatus` as stored. */
  billingStatus: string;
  /** `isBillingPaused` (club-billing-rules.ts): only while BILLING_ENABLED is on. */
  billingPaused: boolean;
  /** `isClubOperational` (club-approval-state.ts): approved, not dormant, not
   *  billing-paused. Blind to the mute switch by design. The other "is this
   *  club served" spellings (D10) combine `botOn`, `billingPaused`,
   *  `approved`, `dormant` and `settingUp`; each is here on its own. */
  operational: boolean;
  /** `liveAt`, ISO, or null. */
  liveAt: string | null;
}

export interface GroupFacts {
  /** `whatsappGroupId`: the players' group. */
  playersGroupId: string | null;
  hq: {
    /** `adminGroupId`: the linked admin group (HQ). */
    groupId: string | null;
    /** `adminChannelMode` as stored. */
    channelMode: string;
    /** `adminChannelUserId`. */
    channelUserId: string | null;
  };
}

export interface RoutineFacts {
  /** `normaliseListAnnouncer` (list-announcer.ts). */
  listAnnouncer: ListAnnouncer;
  /** `normaliseMomChooser` (mom-chooser.ts). */
  momChosenBy: MomChooser;
  /** `normaliseBenchPickMode` (squad-capacity.ts). */
  benchPickMode: BenchPickMode;
  /** `normaliseBenchPickFallback` (squad-capacity.ts). */
  benchPickFallback: BenchPickFallback;
  /** `effectiveTeamsReadyTime(teamsReadyTime, organisersAnnounce)`
   *  (team-proposal-rules.ts): "HH:MM" or "off". */
  teamsReady: string;
  /** `quietHoursOf` (message-hours.ts). */
  quietHours: QuietHours;
  /** The four weekly-deadline columns, as stored (weekly-deadlines.ts reads
   *  them per match: see `MatchFacts.weeklyDeadlines`). */
  weeklyDeadlineSettings: {
    dropOutDeadlineDay: number | null;
    dropOutDeadlineTime: string | null;
    listPublishDay: number | null;
    listPublishTime: string | null;
  };
  /** `hasWeeklyRhythm` (weekly-deadlines.ts): both a drop-out deadline and a
   *  publish time are set. */
  weeklyRhythm: boolean;
  /** `seasonBreakMonths` as stored, "YYYY-MM-01". */
  seasonBreakMonths: string[];
  /** `monthListOpensDaysBefore`. */
  monthListOpensDaysBefore: number;
}

export interface PaymentFacts {
  /** `paymentTrackingEnabled`: the poll, the unpaid lists. */
  tracking: boolean;
  /** `paymentCollectionEnabled`: fee asks, pay links, pay chases. */
  collection: boolean;
  /** `paymentMessagesOn` (payment-messages.ts): the outer gate for ANY
   *  payment message. The narrower gates of D3 read `tracking` or
   *  `collection` on their own. */
  messagesOn: boolean;
  stripe: {
    /** `stripeConnectAccountId` set. */
    accountConnected: boolean;
    /** `stripeChargesEnabled`. */
    chargesEnabled: boolean;
  };
  /** `isPaymentCollectionLive` (payments-live-announce.ts): collection on, a
   *  connected account, charges enabled. One of D4's four spellings of "can
   *  this club take a card"; `methods.card` is another. */
  collectionLive: boolean;
  /** `availablePayMethods` (payments.ts): the ways a player can actually pay. */
  methods: { payByBank: boolean; card: boolean; direct: boolean };
  /** `paymentHolderId` and that user's `User.name` (as `loadClubSnapshot`). */
  collector: { userId: string; name: string | null } | null;
  /** `paymentInstructions` as stored (not trimmed: `directPayInstructions`
   *  decides when and how it is shown). */
  instructions: string | null;
}

export interface SquadFacts {
  /** `normaliseSquadMode` (squad-month-rules.ts). */
  mode: SquadMode;
  /** `rollingSquadEnabled`. */
  rolling: boolean;
  /** `paygPricePence`: what one pay as you go place costs, whatever the
   *  payment flags (bot-scheduler.ts reads it the same way). */
  paygPricePence: number | null;
  /** `normaliseCreditRule` (squad-month-rules.ts). */
  creditRule: MonthCreditRule;
  /** Monthly clubs only (empty for a weekly club, which reads none): the
   *  club's SquadMonth rows the consumers look at today. See `MonthFacts`. */
  months: MonthFacts[];
}

export interface GameFacts {
  activityId: string;
  name: string;
  /** `Activity.isActive`. */
  active: boolean;
  dayOfWeek: number;
  /** "HH:MM" London. */
  time: string;
  venue: string;
  /** `Activity.matchDurationMins`. */
  matchDurationMins: number;
  sport: {
    name: string;
    /** The first word of the sport's name ("Football"), as the three
     *  same-sport readers in bot-scheduler.ts and message-analyzer.ts
     *  compute it inline. */
    family: string;
    playersPerTeam: number;
  };
  /** `totalPlayersFor(playersPerTeam)` (format-switch.ts): the format's places. */
  formatPlaces: number;
  /** `Activity.minPlayers` and `Activity.maxPlayers` as stored. */
  minPlayers: number | null;
  maxPlayers: number | null;
  /** `formatMinimum` (min-players.ts): the organiser's minimum, else two full
   *  sides. Not clamped to the places. */
  fewestToPlay: number;
  /** `playerRange` (flex-format-rules.ts): the sizes one match may be. Its
   *  `min` is clamped to the places, `fewestToPlay` is not; they differ only
   *  for a minimum above the places, which the range rules refuse to save. */
  range: { min: number; max: number; normal: number };
  /** `minimumToPlay` (min-players.ts) over every game of the same sport
   *  family, active or not, as `findMinimumToPlay` (bot-scheduler.ts) reads
   *  it: the 18:00 "Match in trouble" line. */
  fewestAnyFormat: number;
  fee: {
    /** `Activity.feePerPlayer`: the game's default fee. Never copied onto a
     *  match (generate-upcoming-matches.ts). */
    perPlayer: number | null;
    /** `Activity.feeSplitTotal`. */
    splitTotal: boolean;
  };
}

export type MatchStatus = "UPCOMING" | "TEAMS_GENERATED" | "TEAMS_PUBLISHED" | "COMPLETED" | "CANCELLED";

export interface MatchFacts {
  id: string;
  activityId: string;
  /** ISO. */
  kickoffAt: string;
  status: MatchStatus;
  /** `Match.maxPlayers`: this match's places (a size switch changes it). */
  places: number;
  /** Attendance rows CONFIRMED and BENCH, as of `asOf`. */
  confirmed: number;
  bench: number;
  /** `max(0, places - confirmed)`: the 17:00 post's and the recruit chase's
   *  `need` (bot-scheduler.ts). "Places open", never "short". The match-day
   *  chases ask while this is above zero. */
  placesOpen: number;
  /** `shortBelow` (squad-short.ts, #519): below the game's own minimum, else
   *  two full sides of the format, never above the places. What the
   *  scheduler tells the organisers is "short" (the 10:00 offer, the chase
   *  notices). */
  shortBelow: number;
  /** `isSquadShort` (squad-short.ts): `confirmed < shortBelow`. */
  short: boolean;
  /** The match's game's `fewestAnyFormat`: the 18:00 "Match in trouble"
   *  test is `confirmed < fewestAnyFormat` (D1's third meaning). */
  fewestAnyFormat: number;
  /** TeamAssignment rows exist. */
  teamsMade: boolean;
  fee: {
    /** `Match.feePerPlayer`: what the collector confirmed for this match. */
    matchFee: number | null;
    /** `Match.feePendingConfirm`: an amount awaiting the collector's yes. */
    pendingConfirm: number | null;
    /** `Match.paymentLinksReleasedAt` set (read by payment-answer.ts). */
    linksReleased: boolean;
  };
  /** `isNextUpcomingForPosting` (next-upcoming-match.ts). `withHold` passes
   *  the clock, so a cancelled match earlier in the fixture holds this one
   *  until its London day is over (the announcement and the 17:00 post);
   *  `withoutHold` does not (the deadline posts and the month's list). Both
   *  are today's values (D7, K5). */
  nextForPosting: { withHold: boolean; withoutHold: boolean };
  /** `weeklyDeadlinesFor` (weekly-deadlines.ts): this match's instants, ISO,
   *  null where the club has not set one. */
  weeklyDeadlines: { dropOut: string | null; listPublish: string | null };
  /** `Match.attendanceDeadline`, ISO. */
  attendanceDeadline: string;
  /** Monthly clubs only, else null. See `MatchMonthFacts`. */
  month: MatchMonthFacts | null;
}

/**
 * Where a SquadMonth row is in its life, as stored: "open" is "signup",
 * the others are their own status. "held" is a month MatchTime holds for
 * its organiser (a `SentNotification` key, not a row) with no row yet;
 * "none" is neither.
 */
export type MonthPhase = "none" | "held" | "signup" | "priced" | "running" | "closed";

export interface MatchMonthFacts {
  /** The London month the kickoff falls in (`londonMonthStart`), "YYYY-MM-01". */
  monthStart: string;
  /**
   * The month of this match's FIXTURE (same venue and weekday,
   * `isSameRecurringFixture`, the scheduler's key since a format switch
   * re-points a match to another Activity), by its row's status. With two
   * rows for one fixture (two formats, one month each), the one furthest
   * on: running, closed, open, priced.
   */
  phase: MonthPhase;
  /** That row's id, or null for "none" and "held". */
  monthId: string | null;
  /** That row's `listOpenedAt` is set. The scheduler treats an "open" month
   *  as in sign-up only once its list has opened (`signupListPosts`). */
  listOpened: boolean;
  /** A held key exists for this month and fixture, whatever the row says
   *  (the scheduler reads the two separately). */
  held: boolean;
  /** The kickoff is before the month's start here (`startedMidMonthAt`, else
   *  the London 1st): `monthForMatch` does not count it as the month's. */
  beforeStart: boolean;
  /** The month's regulars have been put on this match:
   *  `rollingSeededAt >= month.createdAt` of that row (bot-scheduler.ts,
   *  monthly-week.ts). The scheduler reads it only for a running or closed
   *  month; for a month in sign-up it passes false. */
  seeded: boolean;
  /**
   * `monthNotStartedFor`'s key (month-not-started.ts, the players' group IN
   * hold): a SquadMonth row exists, in any status, for this match's OWN
   * activity and London month. Differs from `phase !== "none"` after a
   * format switch (D5); both are today's values.
   */
  rowForOwnActivity: boolean;
}

export interface MonthFacts {
  id: string;
  activityId: string;
  /** The fixture of its activity (venue and weekday). */
  fixture: { venue: string; dayOfWeek: number };
  /** "YYYY-MM-01". */
  monthStart: string;
  /** As stored: "open", "priced", "running", "closed". */
  status: string;
  /** ISO, or null. */
  listOpenedAt: string | null;
  pricedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  /** `startedMidMonthAt`, else 00:00 London on the 1st (`RunningMonth.startsAt`). */
  startsAt: string;
  /** `startedMidMonthAt` set (plan 4.5). */
  startedPartWay: boolean;
  /** Regular rows not marked left on the month (`SquadMonthMember.leftAt`
   *  null). Does not check the WhatsApp group: `RunningMonth.left` needs a
   *  membership read the consumers that use it still make. */
  regulars: number;
  /** Of those regulars: `paidAt` set (confirmed), else `paidClaimedAt` set
   *  (claimed), the `RunningMonth.paid` mapping. */
  paid: { confirmed: number; claimed: number };
}

export interface MembersFacts {
  /**
   * Every membership with `leftAt` null (guests included, as
   * `loadSquadState` reads them), in ONE stable order: membership
   * `createdAt`, then its id (#520's rule for the HQ readers). No consumer
   * reads this order yet; moving a CONTEXT onto it is slice C2.
   */
  roster: MemberFacts[];
  /** OWNER or ADMIN, in roster order. */
  adminUserIds: string[];
}

export interface MemberFacts {
  userId: string;
  /** `User.name`, "" when unset: what the resolver matches people on. */
  name: string;
  /** `loadPlayerNames`' printed line (player-display-name.ts), else `name`. */
  displayName: string;
  /** This club's `UserAlias` rows (`withAliases`), sorted. */
  aliases: string[];
  /** Role OWNER or ADMIN. */
  isAdmin: boolean;
  /** `User.phoneNumber` set. */
  hasPhone: boolean;
}
