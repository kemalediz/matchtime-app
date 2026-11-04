/**
 * FIVE CLUB SHAPES FOR THE INBOUND DM CHARACTERISATION (Cloud API plan
 * C3, MDs/whatsapp-cloud-api-plan-2026-11-04.md section 5.3).
 *
 * A copy, for main, of the club summary branch's fixtures
 * (`refactor/club-summary`: `src/lib/club-summary/__tests__/fixtures.ts`
 * and the row types of `src/lib/club-summary/derive.ts`), so the DM
 * route's characterisation runs on main without that branch. The rows are
 * plain data; nothing here reads the database or calls a model.
 *
 *   - SUTTON: weekly, Stripe pay links (collection on, tracking off), Kemal
 *     collects, a 7-a-side with an inactive 5-a-side of the same fixture.
 *   - FNF: weekly, payments off, an admin group (HQ), the organisers
 *     announce, nameless members, 12 to 18 players.
 *   - VETS: monthly, November running (13 regulars, 13 paid), pay as you go
 *     at 800p, payments off, Davide collects, 7-a-side played with 12 to 16.
 *   - RATINGS: ratings only (attendance off).
 *   - MUTED: the mute switch on (bot off) and its own minimum (8 of 10).
 *
 * The clock is Wednesday 4 November 2026, 12:00 London (GMT).
 */
import type { OrgFeatures } from "../../org-features";
import type { SetupStageColumns } from "../../club-setup-rules";

// ── The raw rows ───────────────────────────────────────────────────────

/** The Organisation columns the shapes carry. */
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
  activities: ActivityRow[];
  matches: MatchRow[];
  lastPlayed: LastPlayedRow[];
  /** Monthly clubs only; [] for a weekly club. */
  months: MonthRow[];
  /** The club's held-month `SentNotification` keys; [] for a weekly club. */
  heldKeys: string[];
  members: MemberRows | null;
}

export const NOW = new Date("2026-11-04T12:00:00.000Z");

const d = (iso: string) => new Date(iso);

/** Every Organisation column the summary reads, at the schema's defaults. */
export function orgRow(over: Partial<OrgRow> & { id: string; name: string }): OrgRow {
  return {
    language: "en",
    whatsappGroupId: `${over.id}@g.us`,
    whatsappBotEnabled: true,
    dormantAt: null,
    approvedAt: null,
    approvalStatus: "approved",
    setupStage: "live",
    billingStatus: "exempt",
    liveAt: null,
    adminGroupId: null,
    adminChannelMode: "one-person",
    adminChannelUserId: null,
    listAnnouncer: "matchtime",
    momChosenBy: "players",
    benchPickMode: "first-come",
    benchPickFallback: "bench-offer",
    teamsReadyTime: null,
    quietHoursEnabled: false,
    quietHoursFrom: "23:00",
    quietHoursTo: "09:00",
    dropOutDeadlineDay: null,
    dropOutDeadlineTime: null,
    listPublishDay: null,
    listPublishTime: null,
    seasonBreakMonths: [],
    monthListOpensDaysBefore: 7,
    paymentTrackingEnabled: false,
    paymentCollectionEnabled: false,
    stripeConnectAccountId: null,
    stripeChargesEnabled: false,
    payMethodPayByBank: true,
    payMethodCard: true,
    payMethodDirect: true,
    paymentHolderId: null,
    paymentInstructions: null,
    squadMode: "weekly",
    rollingSquadEnabled: false,
    paygPricePence: null,
    monthCreditRule: "any-miss",
    teamLabels: [],
    ...over,
  };
}

/** `getOrgFeatures` for a row: what the loader passes through untouched. */
export function featuresFor(org: OrgRow, over: Partial<OrgFeatures> = {}): OrgFeatures {
  return {
    botEnabled: org.whatsappBotEnabled,
    attendance: true,
    bench: true,
    teamBalancing: true,
    momVoting: true,
    playerRating: true,
    reminders: true,
    statsQa: true,
    paymentTracking: org.paymentTrackingEnabled,
    paymentCollection: org.paymentCollectionEnabled,
    squadFromList: false,
    language: org.language === "tr" ? "tr" : "en",
    rollingSquad: org.rollingSquadEnabled,
    benchPickMode: org.benchPickMode === "organiser" ? "organiser" : "first-come",
    badgeAnnouncements: true,
    squadMode: org.squadMode === "monthly" ? "monthly" : "weekly",
    listAnnouncer: org.listAnnouncer === "organisers" ? "organisers" : "matchtime",
    momChosenBy: org.momChosenBy === "organisers" ? "organisers" : "players",
    gearReminder: true,
    quietHours: { enabled: org.quietHoursEnabled, from: org.quietHoursFrom, to: org.quietHoursTo },
    ...over,
  };
}

export function activity(over: Partial<ActivityRow> & { id: string; sport: ActivityRow["sport"] }): ActivityRow {
  return {
    name: over.id,
    isActive: true,
    dayOfWeek: 2,
    time: "21:30",
    venue: "Venue",
    matchDurationMins: 60,
    minPlayers: null,
    maxPlayers: null,
    feePerPlayer: null,
    feeSplitTotal: false,
    createdAt: d("2026-01-01T00:00:00Z"),
    ...over,
  };
}

/** A match row with `confirmed` CONFIRMED and `bench` BENCH attendances. */
export function match(
  over: Partial<Omit<MatchRow, "attendances" | "_count">> & { id: string; activityId: string; date: Date; maxPlayers: number },
  counts: { confirmed?: number; bench?: number; dropped?: number; teams?: number } = {},
): MatchRow {
  return {
    status: "UPCOMING",
    attendanceDeadline: new Date(over.date.getTime() - 5 * 3600_000),
    feePerPlayer: null,
    feePendingConfirm: null,
    paymentLinksReleasedAt: null,
    rollingSeededAt: null,
    ...over,
    attendances: [
      ...Array.from({ length: counts.confirmed ?? 0 }, () => ({ status: "CONFIRMED" })),
      ...Array.from({ length: counts.bench ?? 0 }, () => ({ status: "BENCH" })),
      ...Array.from({ length: counts.dropped ?? 0 }, () => ({ status: "DROPPED" })),
    ],
    _count: { teamAssignments: counts.teams ?? 0 },
  };
}

export function month(over: Partial<Omit<MonthRow, "members">> & { id: string; activityId: string; monthStart: Date }, members: { regulars?: number; paid?: number; claimed?: number; payg?: number } = {}): MonthRow {
  const regulars = members.regulars ?? 0;
  const paid = members.paid ?? 0;
  const claimed = members.claimed ?? 0;
  return {
    status: "running",
    listOpenedAt: null,
    pricedAt: null,
    closedAt: null,
    createdAt: d("2026-10-20T10:00:00Z"),
    startedMidMonthAt: null,
    ...over,
    members: [
      ...Array.from({ length: regulars }, (_, i) => ({
        kind: "regular",
        paidAt: i < paid ? d("2026-10-30T10:00:00Z") : null,
        paidClaimedAt: i < paid + claimed ? d("2026-10-29T10:00:00Z") : null,
      })),
      ...Array.from({ length: members.payg ?? 0 }, () => ({ kind: "payg", paidAt: null, paidClaimedAt: null })),
    ],
  };
}

export function member(id: string, over: { name?: string | null; phone?: string | null; role?: MemberRow["role"]; createdAt?: string } = {}): MemberRow {
  return {
    id: `mem-${id}`,
    createdAt: d(over.createdAt ?? "2026-01-01T00:00:00Z"),
    role: over.role ?? "PLAYER",
    user: { id, name: over.name === undefined ? id : over.name, phoneNumber: over.phone === undefined ? `+4477${id.length}` : over.phone },
  };
}

// ── Sutton FC ───────────────────────────────────────────────────────────

const SUTTON_ORG = orgRow({
  id: "org-sutton",
  name: "Sutton FC",
  paymentCollectionEnabled: true,
  paymentTrackingEnabled: false,
  stripeConnectAccountId: "acct_sutton",
  stripeChargesEnabled: true,
  paymentHolderId: "u-kemal",
  quietHoursEnabled: true,
});
const SUTTON_A7 = activity({ id: "a-sutton-7", name: "Tuesday 7-a-side", venue: "Goals Sutton", dayOfWeek: 2, time: "21:30", feePerPlayer: 6, sport: { name: "Football 7-a-side", playersPerTeam: 7 } });
const SUTTON_A5 = activity({ id: "a-sutton-5", name: "Tuesday 5-a-side", venue: "Goals Sutton", dayOfWeek: 2, time: "21:15", isActive: false, createdAt: d("2026-02-01T00:00:00Z"), sport: { name: "Football 5-a-side", playersPerTeam: 5 } });

export const SUTTON: ClubRows = {
  org: SUTTON_ORG,
  features: featuresFor(SUTTON_ORG),
  collectorName: "Kemal",
  activities: [SUTTON_A7, SUTTON_A5],
  matches: [
    match({ id: "m-sutton-3nov", activityId: SUTTON_A7.id, date: d("2026-11-03T21:30:00Z"), maxPlayers: 14, status: "COMPLETED", feePerPlayer: 6 }, { confirmed: 14, teams: 14 }),
    match({ id: "m-sutton-10nov", activityId: SUTTON_A7.id, date: d("2026-11-10T21:30:00Z"), maxPlayers: 14 }, { confirmed: 12, bench: 2 }),
  ],
  lastPlayed: [{ id: "m-sutton-3nov", date: d("2026-11-03T21:30:00Z"), activity: { matchDurationMins: 60 } }],
  months: [],
  heldKeys: [],
  members: {
    rows: [
      member("u-kemal", { name: "Kemal", role: "OWNER", createdAt: "2026-01-01T00:00:00Z" }),
      member("u-zed", { name: "Zed", createdAt: "2026-03-01T00:00:00Z" }),
      member("u-amir", { name: "Amir", createdAt: "2026-02-01T00:00:00Z" }),
    ],
    displayNames: { "u-kemal": "Kemal", "u-zed": "Zed", "u-amir": "Amir" },
    aliases: { "u-amir": ["Amo", "AK"] },
  },
};

// ── FNF ─────────────────────────────────────────────────────────────────

const FNF_ORG = orgRow({
  id: "org-fnf",
  name: "FNF",
  adminGroupId: "hq-fnf@g.us",
  adminChannelMode: "admin-group",
  listAnnouncer: "organisers",
});
const FNF_A = activity({ id: "a-fnf", name: "Friday Night Football", venue: "Powerleague", dayOfWeek: 5, time: "20:00", minPlayers: 12, maxPlayers: 18, sport: { name: "Football 7-a-side", playersPerTeam: 7 } });

export const FNF: ClubRows = {
  org: FNF_ORG,
  features: featuresFor(FNF_ORG),
  collectorName: null,
  activities: [FNF_A],
  matches: [match({ id: "m-fnf-6nov", activityId: FNF_A.id, date: d("2026-11-06T20:00:00Z"), maxPlayers: 14 }, { confirmed: 12, bench: 1 })],
  lastPlayed: [],
  months: [],
  heldKeys: [],
  members: {
    rows: [
      member("u-fnf-b", { name: null, phone: "+447700900002", createdAt: "2026-10-01T10:00:00Z" }),
      member("u-fnf-a", { name: null, phone: "+447700900001", createdAt: "2026-10-01T10:00:00Z" }),
      member("u-fnf-org", { name: "Rafi", role: "ADMIN", createdAt: "2026-09-01T10:00:00Z" }),
    ],
    // The printed line of a nameless member is whatever loadPlayerNames says.
    displayNames: { "u-fnf-a": "Smiler", "u-fnf-org": "Rafi" },
    aliases: { "u-fnf-a": ["Smiler"] },
  },
};

// ── The Vets (monthly) ──────────────────────────────────────────────────

const VETS_ORG = orgRow({
  id: "org-vets",
  name: "Vets MNF",
  squadMode: "monthly",
  paygPricePence: 800,
  paymentHolderId: "u-davide",
});
export const VETS_A = activity({ id: "a-vets", name: "Monday Night Football", venue: "Vets Ground", dayOfWeek: 1, time: "20:00", minPlayers: 12, maxPlayers: 16, sport: { name: "Football 7-a-side", playersPerTeam: 7 } });
export const VETS_NOV = month({ id: "sm-vets-nov", activityId: VETS_A.id, monthStart: d("2026-11-01T00:00:00Z"), status: "running", createdAt: d("2026-10-28T10:00:00Z"), listOpenedAt: d("2026-10-25T10:00:00Z") }, { regulars: 13, paid: 13 });

export const VETS: ClubRows = {
  org: VETS_ORG,
  features: featuresFor(VETS_ORG),
  collectorName: "Davide",
  activities: [VETS_A],
  matches: [
    match({ id: "m-vets-2nov", activityId: VETS_A.id, date: d("2026-11-02T20:00:00Z"), maxPlayers: 14, status: "COMPLETED", rollingSeededAt: d("2026-10-28T11:00:00Z") }, { confirmed: 14, teams: 14 }),
    match({ id: "m-vets-9nov", activityId: VETS_A.id, date: d("2026-11-09T20:00:00Z"), maxPlayers: 14, rollingSeededAt: d("2026-11-03T09:00:00Z") }, { confirmed: 13, bench: 0 }),
    match({ id: "m-vets-16nov", activityId: VETS_A.id, date: d("2026-11-16T20:00:00Z"), maxPlayers: 14 }),
    match({ id: "m-vets-7dec", activityId: VETS_A.id, date: d("2026-12-07T20:00:00Z"), maxPlayers: 14 }),
  ],
  lastPlayed: [{ id: "m-vets-2nov", date: d("2026-11-02T20:00:00Z"), activity: { matchDurationMins: 60 } }],
  months: [VETS_NOV],
  heldKeys: [],
  members: {
    rows: [member("u-davide", { name: "Davide", role: "OWNER" }), member("u-nabz", { name: "Nabz", createdAt: "2026-05-01T00:00:00Z" })],
    displayNames: { "u-davide": "Davide", "u-nabz": "Nabz" },
    aliases: { "u-nabz": ["Smiler"] },
  },
};

// ── Ratings only (attendance off) ───────────────────────────────────────

const RATINGS_ORG = orgRow({ id: "org-ratings", name: "Thursday Ratings" });
const RATINGS_A = activity({ id: "a-ratings", name: "Thursday 6-a-side", venue: "Leisure Centre", dayOfWeek: 4, time: "19:00", sport: { name: "Football 6-a-side", playersPerTeam: 6 } });

export const RATINGS: ClubRows = {
  org: RATINGS_ORG,
  features: featuresFor(RATINGS_ORG, { attendance: false, bench: false, squadFromList: true }),
  collectorName: null,
  activities: [RATINGS_A],
  matches: [match({ id: "m-ratings-5nov", activityId: RATINGS_A.id, date: d("2026-11-05T19:00:00Z"), maxPlayers: 12 })],
  lastPlayed: [],
  months: [],
  heldKeys: [],
  members: null,
};

// ── Muted, with its own minimum ─────────────────────────────────────────

const MUTED_ORG = orgRow({ id: "org-muted", name: "Muted Five", whatsappBotEnabled: false, paymentTrackingEnabled: true });
const MUTED_A = activity({ id: "a-muted", name: "Saturday 5s", venue: "Park", dayOfWeek: 6, time: "10:00", minPlayers: 8, sport: { name: "Football 5-a-side", playersPerTeam: 5 } });

export const MUTED: ClubRows = {
  org: MUTED_ORG,
  features: featuresFor(MUTED_ORG),
  collectorName: null,
  activities: [MUTED_A],
  matches: [match({ id: "m-muted-7nov", activityId: MUTED_A.id, date: d("2026-11-07T10:00:00Z"), maxPlayers: 10 }, { confirmed: 7 })],
  lastPlayed: [],
  months: [],
  heldKeys: [],
  members: null,
};

export const SHAPES = { SUTTON, FNF, VETS, RATINGS, MUTED } as const;
