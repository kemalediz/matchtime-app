/**
 * Folding one User into another: the pure planner (2026-11-03).
 *
 * WHY: the same real person can exist as two Users. "Uncle Najib" at FNF
 * (created from a pasted list, no phone) is "Najib" at Sutton Football
 * Club (+44 7944 434018). The FNF row has no phone, so MatchTime never
 * DMs him there. More of these will come (the Vets' "Nabz" and "Luca").
 *
 * WHAT IT DOES: given a SNAPSHOT of every row that names the source or
 * the target (read by `user-merge.ts`), it returns the exact list of
 * writes that move the source's rows onto the target, how every unique
 * key collision is settled, and anything that must stop the merge. It
 * reads nothing and writes nothing, so every rule here is unit-tested
 * table by table (src/lib/__tests__/user-merge-plan.test.ts).
 *
 * THE RULES, in one place:
 *   - The target keeps its id, its name and its phone. The source's phone
 *     moves only when the target has none. Two different numbers block.
 *   - The source is DEACTIVATED (`isActive = false`), never deleted, and
 *     a `UserMerge` row per club records source -> target, so ids
 *     captured before the merge are remapped by the existing readers.
 *   - Club-scoped data stays at its club. A membership at a club only the
 *     source is in moves WHOLE (its seed, its Elo, its role). The target's
 *     memberships at other clubs are never read for numbers or written.
 *     Only where BOTH are members of the same club are the two rows
 *     combined, by the same rules `mergePlayersCore` uses.
 *   - The source's name becomes an alias for the target at every club the
 *     source was in ("uncle najib" at FNF), unless another person already
 *     holds that alias there (reported, skipped).
 *   - A collision on a (thing, user) unique key keeps the TARGET's row
 *     (the record with the real history) and deletes the source's, except
 *     where a rule below says otherwise. Every collision is reported.
 *   - "AttendanceEvent" is append-only (a database trigger refuses UPDATE
 *     and DELETE). Its rows are never touched. Readers derive state from
 *     the CURRENT user's events (squad-reclaim's newest DROPPED, the
 *     month's chose-bench note and out-at time, organiser-pick drops,
 *     rolling-squad intents, admin-added), so the target INHERITS the
 *     source's history: every source event is appended again for the
 *     target with its original time, cause, actor, sourceRef and note.
 *     Every reader then sees for the target exactly what it saw for the
 *     source. Two exceptions: "rolling-squad" events are not copied (the
 *     scheduler COUNTS them per match, and a copy would count the same
 *     carry twice; no per-player reader uses them), and a match where
 *     the TARGET has a place keeps the target's own history (plus the
 *     merge's transition when the two rows are combined). The source gets one "player-merge" event closing each
 *     place it loses ("player-merge" is ignored as a statement).
 *   - Money is never deleted: two payment records on one match or one
 *     month's list, or a source with a checkout still in flight (the
 *     Stripe webhook finds the row by the SOURCE id), stop the merge.
 *   - Elo stays consistent: when both have played Elo at the same club the
 *     merge stops (the kept number and the re-pointed match deltas would
 *     disagree). JSON naming both people stops it too (two entries for one
 *     person, or one key overwriting the other).
 *   - Idempotent: planning over an already-merged state yields no ops.
 */
import { higherRole, isMemberRole } from "./role-change-rules";
import { isPlaceholderEmail } from "./cross-club-link-rules";
import { CLEAR_GUEST_MARKS, isGuestMembership } from "./guest-membership";
import {
  emptyPoolMergeRows,
  planPoolProfile,
  planPoolRekeys,
  POOL_USER_REF_COLUMNS,
  type PoolMergeRows,
} from "./pool/user-merge";

export const USER_MERGE_REASON = "duplicate-person-merge";
const ELO_DEFAULT = 1000;
const ATT_RANK: Record<string, number> = { CONFIRMED: 3, BENCH: 2, DROPPED: 1 };
/** Generic auto-provision names that must never become an alias. Same set
 *  as `mergePlayersCore`. */
const GENERIC_ALIASES = new Set(["player", "guest", "unknown", "member", "someone"]);

export function aliasNorm(s: string): string {
  return s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// ─── The snapshot ────────────────────────────────────────────────────

export interface UserFacts {
  id: string;
  name: string | null;
  email: string | null;
  phoneNumber: string | null;
  isActive: boolean;
  isSuperadmin: boolean;
  onboarded: boolean;
  hasPassword: boolean;
  emailVerified: Date | null;
  accountCount: number;
  sessionCount: number;
}

export interface MembershipRow {
  id: string;
  userId: string;
  orgId: string;
  role: string;
  leftAt: Date | null;
  removedByOrganiserAt: Date | null;
  provisionallyAddedAt: Date | null;
  lastSeenInGroupAt: Date | null;
  seedRating: number | null;
  matchRating: number;
  guestFromOrgId: string | null;
  guestMatchId: string | null;
  guestVia: string | null;
  /** Per-category DM subscriptions (true = receives). Absent = true. */
  subMatchInviteDm?: boolean;
  subBenchOfferDm?: boolean;
  subTentativeDm?: boolean;
  subRatingDm?: boolean;
  subReminderDm?: boolean;
}

export const SUB_FLAGS = ["subMatchInviteDm", "subBenchOfferDm", "subTentativeDm", "subRatingDm", "subReminderDm"] as const;

/** One row of the append-only log, as read for the source. */
export interface AttendanceEventRow {
  id: string;
  matchId: string;
  userId: string;
  orgId: string;
  fromStatus: string | null;
  toStatus: string | null;
  fromPosition: number | null;
  toPosition: number | null;
  cause: string;
  actorKind: string;
  actorUserId: string | null;
  sourceRef: string | null;
  note: string | null;
  at: Date;
}

export interface AttendanceRow {
  id: string;
  matchId: string;
  userId: string;
  /** The match's club, for the events. */
  orgId: string;
  status: string;
  position: number;
  paidAt: Date | null;
  paidViaUserId: string | null;
  paymentMethod: string | null;
  paymentAmount: number | null;
  paymentQuantity: number;
  stripeSessionId: string | null;
  directPendingAt: Date | null;
  directConfirmedByUserId: string | null;
  feeWaivedAt: Date | null;
  feeWaivedReason: string | null;
  feeWaivedByUserId: string | null;
}

type U = { id: string; userId: string };

export interface RefRow {
  /** Prisma delegate name ("organiserPickRound"). */
  table: string;
  column: string;
  kind: "scalar" | "array" | "json";
  id: string;
  value: unknown;
}

/** The pool's rows (`poolProfiles`, `poolOffers`, `poolBlocks`) are read
 *  and planned by the pool's own module, `src/lib/pool/user-merge.ts`. */
export interface MergeSnapshot extends PoolMergeRows {
  source: UserFacts;
  target: UserFacts;
  /** UserMerge rows whose oldUserId is the source. */
  priorMerges: Array<{ survivorUserId: string; reason: string | null; createdAt?: Date }>;
  memberships: MembershipRow[];
  /** UserAlias rows at the source's clubs whose alias is one this merge
   *  would add (so a collision with another person is visible). */
  aliasesInSourceOrgs: Array<{ id: string; orgId: string; userId: string; alias: string }>;
  /** The source's rows and the target's rows on every match the source
   *  has a row or an event on. */
  attendance: AttendanceRow[];
  /** Every AttendanceEvent whose userId is the source. */
  sourceEvents: AttendanceEventRow[];
  teamAssignments: Array<U & { matchId: string }>;
  ratings: Array<{ id: string; matchId: string; raterId: string; playerId: string }>;
  momVotes: Array<{ id: string; matchId: string; voterId: string; playerId: string }>;
  activityPositions: Array<U & { activityId: string }>;
  ratingAdjustments: Array<U & { matchId: string }>;
  rosterSurveyDMs: Array<U & { surveyId: string }>;
  rosterSurveyResponses: Array<
    U & { surveyId: string; response: string; rawReply: string; classifiedAt: Date; adminOverride: boolean }
  >;
  tentatives: Array<U & { matchId: string }>;
  pendingBench: Array<U & { matchId: string }>;
  badges: Array<U & { orgId: string; badgeKey: string }>;
  squadMembers: Array<U & { monthId: string; paidAt: Date | null; paidClaimedAt: Date | null; stripeSessionId?: string | null }>;
  squadCredits: Array<U & { orgId: string; earnedMatchId: string | null; voidedAt: Date | null }>;
  guestPlaces: Array<U & { matchId: string }>;
  clubInvitations: Array<U & { orgId: string; status: string }>;
  /** Rows whose key or targetUser names the source. */
  sentNotifications: Array<{ id: string; key: string; targetUser: string | null }>;
  /** Keys that already exist among the source rows' rewritten keys. */
  occupiedNotificationKeys: string[];
  /** BillingNotice rows whose cycleKey names the source ("payer-changed"
   *  uses the payer's userId), and the `${orgId}|${kind}|${cycleKey}` keys
   *  their rewrite would land on that already exist. */
  billingNotices: Array<{ id: string; orgId: string; kind: string; cycleKey: string }>;
  occupiedBillingKeys: string[];
  /** The club of every match whose `eloApplied` names the source. */
  eloMatchOrgs: Record<string, string>;
  /** Plain "who / which ids" references (USER_REF_COLUMNS). */
  refs: RefRow[];
}

export function emptyMergeSnapshot(
  source: Partial<UserFacts> & { id: string },
  target: Partial<UserFacts> & { id: string },
): MergeSnapshot {
  const user = (u: Partial<UserFacts> & { id: string }): UserFacts => ({
    name: null,
    email: null,
    phoneNumber: null,
    isActive: true,
    isSuperadmin: false,
    onboarded: false,
    hasPassword: false,
    emailVerified: null,
    accountCount: 0,
    sessionCount: 0,
    ...u,
  });
  return {
    source: user(source),
    target: user(target),
    priorMerges: [],
    memberships: [],
    aliasesInSourceOrgs: [],
    attendance: [],
    sourceEvents: [],
    teamAssignments: [],
    ratings: [],
    momVotes: [],
    activityPositions: [],
    ratingAdjustments: [],
    rosterSurveyDMs: [],
    rosterSurveyResponses: [],
    tentatives: [],
    pendingBench: [],
    badges: [],
    squadMembers: [],
    squadCredits: [],
    ...emptyPoolMergeRows(),
    guestPlaces: [],
    clubInvitations: [],
    sentNotifications: [],
    occupiedNotificationKeys: [],
    billingNotices: [],
    occupiedBillingKeys: [],
    eloMatchOrgs: {},
    refs: [],
  };
}

// ─── Plain references: every column that names a user ─────────────────

export interface RefColumn {
  model: string;
  column: string;
  kind: "scalar" | "array" | "json";
}

const sc = (model: string, ...cols: string[]): RefColumn[] => cols.map((column) => ({ model, column, kind: "scalar" as const }));
const ar = (model: string, ...cols: string[]): RefColumn[] => cols.map((column) => ({ model, column, kind: "array" as const }));
const js = (model: string, ...cols: string[]): RefColumn[] => cols.map((column) => ({ model, column, kind: "json" as const }));

/**
 * Columns with no unique key involving the user: every value naming the
 * source is rewritten to the target. Scalars match exactly or as a whole
 * ':'-separated segment ("owner:<id>"); arrays are rewritten and
 * de-duplicated; JSON is rewritten deeply (values and keys).
 */
export const USER_REF_COLUMNS: RefColumn[] = [
  ...sc("Account", "userId"),
  ...sc("Session", "userId"),
  ...sc("Organisation", "paymentHolderId", "adminChannelUserId", "adminGroupLinkedByUserId", "discoverableById", "groupInviteLinkSetById", "approvalDecidedBy", "liveBy"),
  ...sc("OnboardingSession", "adminUserId"),
  ...js("OnboardingSession", "proposedRoster", "unresolvedMembers"),
  ...sc("Activity", "venueConfirmedById"),
  ...sc("Match", "feeSetByUserId"),
  ...js("Match", "eloApplied"),
  ...sc("ClubBilling", "cardHolderUserId"),
  ...sc("ClubPartnership", "createdByUserId", "askerAcceptedBy", "partnerAcceptedBy"),
  ...sc("ClubBlock", "createdByUserId"),
  ...sc("PartnerAsk", "requestedByUserId", "approvedByUserId"),
  ...ar("PartnerAsk", "volunteerUserIds", "pickedUserIds"),
  ...sc("RosterSurvey", "sentByUserId", "closedById"),
  ...sc("PendingBenchConfirmation", "replacingUserId"),
  ...sc("OrganiserPickRound", "pendingConfirmUserId", "pendingConfirmAskedByUserId", "lastPickedByUserId"),
  ...ar("OrganiserPickRound", "recipientUserIds", "listUserIds", "vacatedByUserIds", "lateDropUserIds", "pickedUserIds"),
  ...sc("AdminTeamProposal", "approvedByUserId"),
  ...js("AdminTeamProposal", "toldSheet"),
  ...js("AdminTeamSheet", "slots"),
  ...sc("AdminSquadProposal", "proposedByUserId", "resolvedByUserId"),
  ...ar("AdminSquadProposal", "playingUserIds", "reserveUserIds", "removeUserIds"),
  ...js("AdminSquadProposal", "monthSeed"),
  ...sc("AdminFeeProposal", "proposedByUserId", "resolvedByUserId"),
  ...ar("AdminFeeProposal", "userIds"),
  ...sc("AdminGroupMessage", "senderUserId"),
  ...sc("BenchSlotOffer", "replacingUserId", "claimedByUserId"),
  ...sc("Attendance", "paidViaUserId", "directConfirmedByUserId", "feeWaivedByUserId"),
  ...sc("PaymentCredit", "payerUserId", "recordedById"),
  ...sc("AnalyzedMessage", "authorUserId"),
  ...sc("UserAlias", "userId"),
  ...js("GroupPostState", "heldAdd"),
  ...sc("SquadMonth", "startedByUserId"),
  ...sc("SquadMonthMember", "paidConfirmedByUserId"),
  ...sc("SquadCredit", "voidedById", "createdById"),
  ...sc("PlatformSetting", "updatedById"),
  ...sc("ClubGraphicsChoice", "updatedById"),
  ...POOL_USER_REF_COLUMNS,
  ...sc("FriendLink", "issuedByUserId", "usedByUserId"),
  ...sc("GuestPlace", "resultById"),
  ...sc("ClubInvitation", "invitedByUserId", "clubYesById", "declinedBy"),
  ...sc("ClubConnect", "userId"),
];

/** Columns the planner handles with their own collision rules. */
export const SPECIAL_COLUMNS: string[] = [
  "User.phoneNumber",
  "Membership.userId",
  "Attendance.userId",
  "TeamAssignment.userId",
  "Rating.raterId",
  "Rating.playerId",
  "MoMVote.voterId",
  "MoMVote.playerId",
  "PlayerActivityPosition.userId",
  "RatingAdjustment.userId",
  "RosterSurveyDM.userId",
  "RosterSurveyResponse.userId",
  "TentativeAvailability.userId",
  "PendingBenchConfirmation.userId",
  "BadgeAnnouncement.userId",
  "SquadMonthMember.userId",
  "SquadCredit.userId",
  "PoolProfile.userId",
  "PoolOffer.userId",
  "PoolBlock.userId",
  "GuestPlace.userId",
  "ClubInvitation.userId",
  "SentNotification.key",
  "SentNotification.targetUser",
  "BillingNotice.cycleKey",
];

/** Columns deliberately left as they are, and why. */
export const UNTOUCHED_COLUMNS: Record<string, string> = {
  "AttendanceEvent.userId": "append-only (trigger refuses UPDATE); the merge appends new events instead",
  "AttendanceEvent.actorUserId": "append-only (trigger refuses UPDATE)",
  "UserMerge.oldUserId": "the merge map itself",
  "UserMerge.survivorUserId": "the merge map itself",
  "UserMerge.actorUserId": "the merge map itself",
  "UserMerge.detail": "the merge's own audit record",
  "RoleChange.userId": "audit log of what happened to that id; UserMerge maps it",
  "RoleChange.actorUserId": "audit log of who did it; UserMerge maps it",
  "PoolConsentRecord.userId": "legal consent evidence, append-only by design; UserMerge maps it",
  "VenueSuggestUsage.userId": "a rolling rate-limit counter, not the person's data",
  "Organisation.momChosenBy": "a setting ('players' | 'organisers'), not a user",
  "AnalyzedMessage.handledBy": "the name of the code path that handled a message, not a user",
  "OnboardingSession.participants": "phones and pushnames only",
  "OnboardingSession.pendingAdmins": "names and phones only",
  "OnboardingSession.capturedSchedule": "no user ids",
  "OnboardingSession.capturedHistory": "captured chat text",
  "ClubConnect.participants": "phones and pushnames only",
  "ClubConnect.capturedHistory": "captured chat text",
  "AnalyzedMessage.pipelineTrace": "diagnostic trace of what happened then",
  "AdminGroupMessage.pipelineTrace": "diagnostic trace of what happened then",
  "WindowVerdict.verdictJson": "a cached model verdict for one message window",
  "Sport.positionComposition": "no user ids",
  "ClubBillingMonth.games": "no user ids",
  "BotHealth.codeFirstSeenAt": "no user ids",
  "ClubSetupLearning.detected": "club settings, no user ids",
  "ClubSetupLearning.applied": "club settings, no user ids",
  "ClubSetupLearning.suggestions": "club settings, no user ids",
  "ClubSetupLearning.noted": "club settings, no user ids",
  "ClubSetupLearning.kept": "club settings, no user ids",
  "ClubGraphicsTemplate.layout": "no user ids",
  "ClubGraphicsTemplate.sharedLayout": "no user ids",
  // WhatsApp Cloud API, PR C2: keyed by phone, like the rest of PlatformJob.
  "PlatformJob.templateParams": "a Meta template's variables (text), no user ids",
  "WaInbound.payload": "the inbound message as parsed (text, sender name, quoted id), keyed by phone, no user ids",
  "WaInbound.waUserId": "Meta's business scoped user id, not a MatchTime User id",
};

export const delegateOf = (model: string): string => model.charAt(0).toLowerCase() + model.slice(1);

/** Primary keys of the referencing models that are not `id` (a ref's
 *  `id` holds this column's value). Every other model's key is `id`. */
export const PRIMARY_KEY_OF: Record<string, string> = {
  clubBilling: "orgId",
  groupPostState: "groupId",
  platformSetting: "key",
  clubGraphicsChoice: "orgId",
};
export const pkOf = (delegate: string): string => PRIMARY_KEY_OF[delegate] ?? "id";

// ─── Pure rewriting helpers ──────────────────────────────────────────

/** Replace whole ':'-separated segments equal to `from`. */
export function rewriteIdSegments(value: string, from: string, to: string): string {
  if (value === from) return to;
  if (!value.includes(from)) return value;
  return value
    .split(":")
    .map((seg) => (seg === from ? to : seg))
    .join(":");
}

/** Deep rewrite of a JSON value: string values and object keys. */
export function rewriteJsonIds(v: unknown, from: string, to: string): unknown {
  if (typeof v === "string") return rewriteIdSegments(v, from, to);
  if (Array.isArray(v)) return v.map((x) => rewriteJsonIds(x, from, to));
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[rewriteIdSegments(k, from, to)] = rewriteJsonIds(x, from, to);
    return out;
  }
  return v;
}

const jsonEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ─── The plan ────────────────────────────────────────────────────────

export interface AttendanceTransitionPlan {
  matchId: string;
  userId: string;
  orgId: string;
  fromStatus: string | null;
  toStatus: string | null;
  fromPosition: number | null;
  toPosition: number | null;
}

export type MergeOp =
  | { kind: "delete"; table: string; id: string; why: string }
  | { kind: "update"; table: string; id: string; set: Record<string, unknown>; why: string }
  | { kind: "create"; table: "userAlias" | "roleChange"; data: Record<string, unknown>; why: string }
  | { kind: "event"; transition: AttendanceTransitionPlan; why: string }
  /** The source's own event, appended again for the target with its
   *  original time, cause, actor, sourceRef and note. */
  | { kind: "copyEvent"; fromEventId: string; data: Omit<AttendanceEventRow, "id">; why: string };

export interface MergeConflict {
  table: string;
  rowId: string;
  rule: string;
}

export interface MergePlan {
  sourceId: string;
  targetId: string;
  blockers: string[];
  /** Already merged and nothing left to move. */
  noop: boolean;
  /** In execution order: deletes, the two User rows, other updates, then
   *  creates and attendance events. */
  ops: MergeOp[];
  conflicts: MergeConflict[];
  /** Clubs to write a UserMerge row for (empty when already recorded). */
  tombstoneOrgIds: string[];
  /** The alias this merge adds at each club (for the report). */
  alias: string | null;
}

export function planUserMerge(snap: MergeSnapshot, opts: { now: Date }): MergePlan {
  const { source: src, target: tgt } = snap;
  const S = src.id;
  const T = tgt.id;
  const now = opts.now;
  const m = (id: string | null): string | null => (id === S ? T : id);

  const blank = (blockers: string[]): MergePlan => ({
    sourceId: S,
    targetId: T,
    blockers,
    noop: false,
    ops: [],
    conflicts: [],
    tombstoneOrgIds: [],
    alias: null,
  });

  // ── Blockers ──
  if (S === T) return blank(["source and target are the same user"]);
  const blockers: string[] = [];
  const mergedIntoTarget = snap.priorMerges.some((p) => p.survivorUserId === T && p.reason === USER_MERGE_REASON);
  const mergedElsewhere = snap.priorMerges.filter((p) => p.survivorUserId !== T);
  if (mergedElsewhere.length > 0) blockers.push(`source was already merged into ${mergedElsewhere.map((p) => p.survivorUserId).join(", ")}`);
  if (!src.isActive && !mergedIntoTarget && mergedElsewhere.length === 0) blockers.push("source is inactive and was not merged into this target");
  if (!tgt.isActive) blockers.push("target is inactive (merged away or deactivated)");
  if (src.isSuperadmin) blockers.push("source is a platform superadmin");
  const signIn: string[] = [];
  if (src.onboarded) signIn.push("onboarded");
  if (src.accountCount > 0) signIn.push(`${src.accountCount} OAuth account(s)`);
  if (src.sessionCount > 0) signIn.push(`${src.sessionCount} session(s)`);
  if (src.hasPassword) signIn.push("a password");
  if (src.emailVerified) signIn.push("a verified email");
  if (!isPlaceholderEmail(src.email)) signIn.push(`a real email (${src.email})`);
  if (signIn.length > 0) blockers.push(`source has its own sign in (${signIn.join(", ")}): merging it would graft a second login onto the target`);
  if (src.phoneNumber && tgt.phoneNumber && src.phoneNumber !== tgt.phoneNumber) {
    blockers.push(`both users have a phone number (${src.phoneNumber} and ${tgt.phoneNumber}): which one is his is a human decision`);
  }
  // ── Money: never delete a payment, never strand a checkout ──
  const paidEvidence = (r: AttendanceRow) => !!(r.paidAt || r.directPendingAt || r.stripeSessionId);
  for (const a of snap.attendance.filter((r) => r.userId === S)) {
    if (a.stripeSessionId && !a.paidAt) {
      blockers.push(`source has a Stripe checkout in flight on match ${a.matchId} (session ${a.stripeSessionId}, not paid): the webhook finds the row by the source id; merge after it settles`);
    }
    const t = snap.attendance.find((r) => r.userId === T && r.matchId === a.matchId);
    if (t && paidEvidence(a) && paidEvidence(t)) {
      blockers.push(`both have a payment record on match ${a.matchId} (source ${a.paidAt ? "paid" : "pending"}, target ${t.paidAt ? "paid" : "pending"}): which one stands, or a refund, is a human decision`);
    }
  }
  for (const r of snap.squadMembers.filter((x) => x.userId === S)) {
    if (r.stripeSessionId && !r.paidAt) blockers.push(`source has a Stripe checkout in flight for month list ${r.monthId}: merge after it settles`);
    const t = snap.squadMembers.find((x) => x.userId === T && x.monthId === r.monthId);
    if (t && (r.paidAt || r.paidClaimedAt) && (t.paidAt || t.paidClaimedAt)) {
      blockers.push(`both have a payment (paid or claimed) on month list ${r.monthId}: which one stands, or a refund, is a human decision`);
    }
  }

  // ── Elo: one club's number and its match deltas must agree ──
  for (const sm of snap.memberships.filter((r) => r.userId === S)) {
    const tm = snap.memberships.find((r) => r.userId === T && r.orgId === sm.orgId);
    if (!tm || tm.matchRating === ELO_DEFAULT) continue;
    const srcPlayedHere =
      sm.matchRating !== ELO_DEFAULT ||
      snap.refs.some((r) => r.table === "match" && r.column === "eloApplied" && snap.eloMatchOrgs[r.id] === sm.orgId);
    if (srcPlayedHere) {
      blockers.push(`both have played Elo at club ${sm.orgId} (source ${sm.matchRating}, target ${tm.matchRating}): keeping one number while re-pointing the other's match deltas would make a later score correction move the wrong amount`);
    }
  }

  // ── JSON naming both people: no silent combine ──
  const names = (v: unknown, id: string): boolean => JSON.stringify(v ?? null).split(/[":]/).includes(id);
  for (const r of snap.refs.filter((x) => x.kind === "json")) {
    if (names(r.value, S) && names(r.value, T)) {
      blockers.push(`${r.table}.${r.column} ${r.id} names both users: rewriting would give one person two entries (or one key would overwrite the other)`);
    }
  }

  if (blockers.length > 0) return blank(blockers);

  const ops: MergeOp[] = [];
  const conflicts: MergeConflict[] = [];
  const del = (table: string, id: string, why: string) => ops.push({ kind: "delete", table, id, why });
  const upd = (table: string, id: string, set: Record<string, unknown>, why: string) => ops.push({ kind: "update", table, id, set, why });
  const clash = (table: string, rowId: string, rule: string) => conflicts.push({ table, rowId, rule });

  // ── User rows ──
  if (src.isActive || (src.phoneNumber && !tgt.phoneNumber)) {
    const set: Record<string, unknown> = {};
    if (src.isActive) set.isActive = false;
    if (src.phoneNumber) set.phoneNumber = null;
    upd("user", S, set, "source deactivated (never deleted)");
  }
  if (src.phoneNumber && !tgt.phoneNumber) upd("user", T, { phoneNumber: src.phoneNumber }, "target had no phone; takes the source's");

  // ── Membership ──
  const srcMems = snap.memberships.filter((r) => r.userId === S);
  for (const sm of srcMems) {
    const tm = snap.memberships.find((r) => r.userId === T && r.orgId === sm.orgId);
    if (!tm) {
      upd("membership", sm.id, { userId: T }, "club only the source is in: membership moves whole (seed, Elo, role kept)");
      continue;
    }
    clash("membership", sm.id, "both are members of this club: rows combined onto the target's, source's deleted");
    const staysGuest = isGuestMembership(tm) && isGuestMembership(sm);
    const tRole = tm.role;
    const role = !staysGuest && isMemberRole(tm.role) && isMemberRole(sm.role) ? higherRole(tm.role, sm.role) : tm.role;
    const leftAt = tm.leftAt === null || sm.leftAt === null ? null : tm.leftAt > sm.leftAt ? tm.leftAt : sm.leftAt;
    const earlier = (a: Date | null, b: Date | null) => (a === null || b === null ? null : a < b ? a : b);
    const later = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));
    const set: Record<string, unknown> = {
      role,
      leftAt,
      removedByOrganiserAt: leftAt === null ? null : (tm.removedByOrganiserAt ?? sm.removedByOrganiserAt),
      provisionallyAddedAt: earlier(tm.provisionallyAddedAt, sm.provisionallyAddedAt),
      lastSeenInGroupAt: later(tm.lastSeenInGroupAt, sm.lastSeenInGroupAt),
      seedRating: tm.seedRating ?? sm.seedRating,
      matchRating: tm.matchRating === ELO_DEFAULT && sm.matchRating !== ELO_DEFAULT ? sm.matchRating : tm.matchRating,
    };
    // A DM opt-out on either row wins: he said no to it as one of them.
    for (const f of SUB_FLAGS) {
      const kept = (tm[f] ?? true) && (sm[f] ?? true);
      if (kept !== (tm[f] ?? true)) set[f] = kept;
    }
    if (!staysGuest && isGuestMembership(tm)) Object.assign(set, CLEAR_GUEST_MARKS);
    upd("membership", tm.id, set, "combined with the source's membership at the same club");
    del("membership", sm.id, "combined into the target's membership at the same club");
    if (role !== tRole) {
      ops.push({
        kind: "create",
        table: "roleChange",
        data: { orgId: sm.orgId, userId: T, actorUserId: null, fromRole: tRole, toRole: role, source: "merge" },
        why: "the source held the higher role at this club",
      });
    }
  }

  // ── Alias: the source's club name, at each of its clubs ──
  let alias: string | null = src.name ? aliasNorm(src.name) : null;
  if (alias && (alias.length < 2 || GENERIC_ALIASES.has(alias))) alias = null;
  if (alias && tgt.name && aliasNorm(tgt.name) === alias) alias = null;
  if (alias) {
    for (const orgId of [...new Set(srcMems.map((r) => r.orgId))]) {
      const held = snap.aliasesInSourceOrgs.find((a) => a.orgId === orgId && a.alias === alias);
      if (held && held.userId !== S && held.userId !== T) {
        clash("userAlias", held.id, `alias "${alias}" at ${orgId} already belongs to ${held.userId}: not added`);
        continue;
      }
      if (held) continue; // the target holds it, or the source's row is repointed below
      ops.push({ kind: "create", table: "userAlias", data: { orgId, userId: T, alias, source: "merge" }, why: "the source's club name, kept as an alias" });
    }
  }

  // ── Attendance + its events ──
  const payGroup = (r: AttendanceRow) => ({
    paidAt: r.paidAt,
    paidViaUserId: m(r.paidViaUserId),
    paymentMethod: r.paymentMethod,
    paymentAmount: r.paymentAmount,
    paymentQuantity: r.paymentQuantity,
    stripeSessionId: r.stripeSessionId,
    directPendingAt: r.directPendingAt,
    directConfirmedByUserId: m(r.directConfirmedByUserId),
  });
  const hasPay = (r: AttendanceRow) => !!(r.paidAt || r.directPendingAt || r.stripeSessionId);
  const events: MergeOp[] = [];
  const ev = (t: AttendanceTransitionPlan, why: string) => events.push({ kind: "event", transition: t, why });
  const byTime = (a: AttendanceEventRow, b: AttendanceEventRow) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id);
  const srcEvents = [...snap.sourceEvents].sort(byTime);
  // Matches where the target holds a row keep the target's own history:
  // interleaving the source's would make the target's fold disagree with
  // his row.
  const targetOn = new Set(snap.attendance.filter((r) => r.userId === T).map((r) => r.matchId));
  // The target inherits the source's history (see the header): every
  // source event, except rolling-squad carries and matches where the
  // target has a place, appended again for the target, original time kept.
  const copies: MergeOp[] = [];
  const lastCopied = new Map<string, AttendanceEventRow>();
  // A re-run inherits only what the source logged after the earlier merge.
  const inheritedUpTo = Math.max(
    -Infinity,
    ...snap.priorMerges.filter((p) => p.survivorUserId === T && p.reason === USER_MERGE_REASON && p.createdAt).map((p) => p.createdAt!.getTime()),
  );
  for (const e of srcEvents) {
    if (e.cause === "rolling-squad" || targetOn.has(e.matchId)) continue;
    if (e.at.getTime() <= inheritedUpTo) continue;
    if (e.sourceRef === `merge:${S}->${T}`) continue; // this merge's own closing events
    const { id: _id, ...rest } = e;
    void _id;
    copies.push({
      kind: "copyEvent",
      fromEventId: e.id,
      data: { ...rest, userId: T, actorUserId: m(e.actorUserId), sourceRef: e.sourceRef === null ? null : rewriteIdSegments(e.sourceRef, S, T) },
      why: "the source's history, inherited by the target",
    });
    lastCopied.set(e.matchId, e);
  }
  const lastSrcEvent = (matchId: string, toStatus: string) =>
    [...srcEvents].reverse().find((e) => e.matchId === matchId && e.toStatus === toStatus) ?? null;
  for (const a of snap.attendance.filter((r) => r.userId === S)) {
    const t = snap.attendance.find((r) => r.userId === T && r.matchId === a.matchId);
    const lose = { matchId: a.matchId, userId: S, orgId: a.orgId, fromStatus: a.status, toStatus: null, fromPosition: a.position, toPosition: null };
    if (!t) {
      upd("attendance", a.id, { userId: T }, "squad place moves to the target");
      ev(lose, "duplicate user merged; this squad place moved to the survivor");
      // The inherited history already ends where the row is: nothing to
      // add. A row the log never saw (written before the log, or by a
      // writer that skipped it) gets one event so the target's fold ends
      // at the row's status, as the source's would have.
      const last = lastCopied.get(a.matchId) ?? null;
      if (!last || last.toStatus !== a.status) {
        ev(
          { matchId: a.matchId, userId: T, orgId: a.orgId, fromStatus: last?.toStatus ?? null, toStatus: a.status, fromPosition: last?.toPosition ?? null, toPosition: a.position },
          `squad place inherited from merged-away user ${S}`,
        );
      }
      continue;
    }
    clash("attendance", a.id, "both have a place in this match: the higher status wins (CONFIRMED > BENCH > DROPPED, tie to the target); a payment or free place is never lost");
    const set: Record<string, unknown> = {};
    const srcWins = (ATT_RANK[a.status] ?? 0) > (ATT_RANK[t.status] ?? 0);
    if (srcWins) Object.assign(set, { status: a.status, position: a.position });
    if (!hasPay(t) && hasPay(a)) Object.assign(set, payGroup(a));
    const mergedPaid = hasPay(t) ? t.paidAt : (a.paidAt ?? null);
    if (!t.feeWaivedAt && a.feeWaivedAt && !mergedPaid) {
      Object.assign(set, { feeWaivedAt: a.feeWaivedAt, feeWaivedReason: a.feeWaivedReason, feeWaivedByUserId: m(a.feeWaivedByUserId) });
    }
    if (Object.keys(set).length > 0) upd("attendance", t.id, set, "combined with the source's place in the same match");
    if (srcWins) {
      // The note of the source's own move to this status travels (it says,
      // e.g., that he ASKED for the bench, which the month reads).
      const srcMove = lastSrcEvent(a.matchId, a.status);
      const why = `collision resolved in favour of the merged-away row (${a.status} beats ${t.status})`;
      ev(
        { matchId: a.matchId, userId: T, orgId: a.orgId, fromStatus: t.status, toStatus: a.status, fromPosition: t.position, toPosition: a.position },
        srcMove?.note ? `${srcMove.note} (${why})` : why,
      );
    }
    del("attendance", a.id, "duplicate place deleted; the target already held one in this match");
    ev(lose, "duplicate row deleted; the survivor already held a place in this match");
  }

  // ── Generic re-key: rows whose unique key holds a user id ──
  function rekey<R extends { id: string }>(
    table: string,
    rows: R[],
    userCols: Array<keyof R & string>,
    keyOf: (r: R) => string,
    opts2: { isSelf?: (r: R) => boolean; rule: string },
  ) {
    const touches = (r: R) => userCols.some((c) => r[c] === S);
    const occupied = new Set(rows.filter((r) => !touches(r)).map(keyOf));
    for (const r of [...rows].filter(touches).sort((a, b) => a.id.localeCompare(b.id))) {
      const mapped = { ...r } as R;
      const set: Record<string, unknown> = {};
      for (const c of userCols) {
        if (r[c] === S) {
          (mapped as Record<string, unknown>)[c] = T;
          set[c] = T;
        }
      }
      if (opts2.isSelf?.(mapped)) {
        del(table, r.id, "would become the target rating or voting for himself");
        clash(table, r.id, "a row between the two records would become self-referencing: deleted");
        continue;
      }
      const k = keyOf(mapped);
      if (occupied.has(k)) {
        del(table, r.id, "the target already has this row");
        clash(table, r.id, opts2.rule);
        continue;
      }
      occupied.add(k);
      upd(table, r.id, set, "moves to the target");
    }
  }
  const keepTarget = "the target already has one for the same key: the target's is kept, the source's deleted";
  rekey("teamAssignment", snap.teamAssignments, ["userId"], (r) => `${r.matchId}:${r.userId}`, { rule: keepTarget });
  rekey("rating", snap.ratings, ["raterId", "playerId"], (r) => `${r.matchId}:${r.raterId}:${r.playerId}`, {
    isSelf: (r) => r.raterId === r.playerId,
    rule: "the same rating already exists on the target (same match, rater and player): the target's is kept",
  });
  rekey("moMVote", snap.momVotes, ["voterId", "playerId"], (r) => `${r.matchId}:${r.voterId}`, {
    isSelf: (r) => r.voterId === r.playerId,
    rule: "the target already voted in this match: the target's vote is kept",
  });
  rekey("playerActivityPosition", snap.activityPositions, ["userId"], (r) => `${r.activityId}:${r.userId}`, { rule: keepTarget });
  rekey("ratingAdjustment", snap.ratingAdjustments, ["userId"], (r) => `${r.matchId}:${r.userId}`, { rule: keepTarget });
  rekey("rosterSurveyDM", snap.rosterSurveyDMs, ["userId"], (r) => `${r.surveyId}:${r.userId}`, { rule: keepTarget });
  rekey("tentativeAvailability", snap.tentatives, ["userId"], (r) => `${r.matchId}:${r.userId}`, { rule: keepTarget });
  rekey("pendingBenchConfirmation", snap.pendingBench, ["userId"], (r) => `${r.matchId}:${r.userId}`, { rule: keepTarget });
  rekey("badgeAnnouncement", snap.badges, ["userId"], (r) => `${r.orgId}:${r.userId}:${r.badgeKey}`, { rule: "badge already announced for the target: kept" });
  planPoolRekeys(snap, rekey, keepTarget);
  rekey("guestPlace", snap.guestPlaces, ["userId"], (r) => `${r.matchId}:${r.userId}`, { rule: keepTarget });

  // ── RosterSurveyResponse: the newer reply wins ──
  for (const r of snap.rosterSurveyResponses.filter((x) => x.userId === S)) {
    const t = snap.rosterSurveyResponses.find((x) => x.userId === T && x.surveyId === r.surveyId);
    if (!t) {
      upd("rosterSurveyResponse", r.id, { userId: T }, "moves to the target");
      continue;
    }
    clash("rosterSurveyResponse", r.id, "both answered this survey: the newer reply wins");
    if (r.classifiedAt > t.classifiedAt) {
      upd("rosterSurveyResponse", t.id, { response: r.response, rawReply: r.rawReply, classifiedAt: r.classifiedAt, adminOverride: r.adminOverride }, "the source's reply is newer");
    }
    del("rosterSurveyResponse", r.id, "folded into the target's reply");
  }

  // ── SquadMonthMember: more payment evidence wins (squad-month.ts) ──
  const weight = (r: { paidAt: Date | null; paidClaimedAt: Date | null }) => (r.paidAt ? 2 : r.paidClaimedAt ? 1 : 0);
  for (const r of snap.squadMembers.filter((x) => x.userId === S)) {
    const t = snap.squadMembers.find((x) => x.userId === T && x.monthId === r.monthId);
    if (!t) {
      upd("squadMonthMember", r.id, { userId: T }, "moves to the target");
      continue;
    }
    clash("squadMonthMember", r.id, "both are on this month's list: the row with more payment evidence wins (confirmed > claimed > none, tie to the target)");
    if (weight(t) >= weight(r)) {
      del("squadMonthMember", r.id, "the target's row has as much payment evidence");
    } else {
      del("squadMonthMember", t.id, "the source's row has more payment evidence");
      upd("squadMonthMember", r.id, { userId: T }, "the source's row has more payment evidence: it moves");
    }
  }

  // ── SquadCredit: one LIVE credit per (club, user, game) ──
  const liveKey = (r: MergeSnapshot["squadCredits"][number]) => (r.voidedAt === null && r.earnedMatchId ? `${r.orgId}:${r.earnedMatchId}` : null);
  const liveTarget = new Set(snap.squadCredits.filter((r) => r.userId === T).map(liveKey).filter(Boolean));
  for (const r of snap.squadCredits.filter((x) => x.userId === S)) {
    const k = liveKey(r);
    if (k && liveTarget.has(k)) {
      upd("squadCredit", r.id, { userId: T, voidedAt: now, voidedById: null, voidNote: "merged duplicate: the target already holds this game's credit" }, "second live credit for one game: voided, kept in the ledger");
      clash("squadCredit", r.id, "a second live credit for the same game: voided, not deleted");
      continue;
    }
    if (k) liveTarget.add(k);
    upd("squadCredit", r.id, { userId: T }, "moves to the target");
  }

  // ── PoolProfile: one per user (the pool's own module) ──
  planPoolProfile(snap, { S, T, now }, { upd, clash });

  // ── ClubInvitation: one OPEN per (club, user) ──
  const openTarget = new Set(snap.clubInvitations.filter((r) => r.userId === T && r.status === "open").map((r) => r.orgId));
  for (const r of snap.clubInvitations.filter((x) => x.userId === S)) {
    if (r.status === "open" && openTarget.has(r.orgId)) {
      upd("clubInvitation", r.id, { userId: T, status: "withdrawn", closedAt: now }, "a second open invitation at this club: withdrawn");
      clash("clubInvitation", r.id, "both have an open invitation at this club: the source's is withdrawn");
      continue;
    }
    if (r.status === "open") openTarget.add(r.orgId);
    upd("clubInvitation", r.id, { userId: T }, "moves to the target");
  }

  // ── SentNotification: the dedupe key carries the user id ──
  const occupiedKeys = new Set(snap.occupiedNotificationKeys);
  for (const n of [...snap.sentNotifications].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = rewriteIdSegments(n.key, S, T);
    const set: Record<string, unknown> = {};
    if (key !== n.key) {
      if (occupiedKeys.has(key)) {
        del("sentNotification", n.id, "the target already has this notification key");
        clash("sentNotification", n.id, `key "${key}" already sent for the target: the source's marker deleted`);
        continue;
      }
      occupiedKeys.add(key);
      set.key = key;
    }
    if (n.targetUser === S) set.targetUser = T;
    if (Object.keys(set).length > 0) upd("sentNotification", n.id, set, "dedupe marker now names the target");
  }

  // ── BillingNotice: (orgId, kind, cycleKey) unique; cycleKey can be a userId ──
  const occupiedBilling = new Set(snap.occupiedBillingKeys);
  for (const b of [...snap.billingNotices].sort((x, y) => x.id.localeCompare(y.id))) {
    const key = rewriteIdSegments(b.cycleKey, S, T);
    if (key === b.cycleKey) continue;
    const k = `${b.orgId}|${b.kind}|${key}`;
    if (occupiedBilling.has(k)) {
      del("billingNotice", b.id, "the target already has this billing notice");
      clash("billingNotice", b.id, `notice ${b.kind} for the target already recorded: the source's deleted`);
      continue;
    }
    occupiedBilling.add(k);
    upd("billingNotice", b.id, { cycleKey: key }, "billing notice key now names the target");
  }

  // ── Plain references ──
  for (const r of snap.refs) {
    let next: unknown = r.value;
    if (r.kind === "scalar" && typeof r.value === "string") next = rewriteIdSegments(r.value, S, T);
    else if (r.kind === "array" && Array.isArray(r.value)) next = [...new Set((r.value as string[]).map((x) => (x === S ? T : x)))];
    else if (r.kind === "json") next = rewriteJsonIds(r.value, S, T);
    if (jsonEq(next, r.value)) continue;
    upd(r.table, r.id, { [r.column]: next }, `${r.column} named the source`);
  }

  // ── Fold: delete wins over update on one row; updates on one row merge ──
  const deleted = new Set(ops.filter((o) => o.kind === "delete").map((o) => `${(o as { table: string }).table}:${(o as { id: string }).id}`));
  const merged = new Map<string, Extract<MergeOp, { kind: "update" }>>();
  const deletes: MergeOp[] = [];
  const seenDel = new Set<string>();
  const creates: MergeOp[] = [];
  for (const o of ops) {
    if (o.kind === "delete") {
      const k = `${o.table}:${o.id}`;
      if (!seenDel.has(k)) deletes.push(o);
      seenDel.add(k);
    } else if (o.kind === "update") {
      const k = `${o.table}:${o.id}`;
      if (deleted.has(k)) continue;
      const prev = merged.get(k);
      if (prev) prev.set = { ...prev.set, ...o.set };
      else merged.set(k, { ...o, set: { ...o.set } });
    } else creates.push(o);
  }
  const updates = [...merged.values()];
  const userUpdates = updates.filter((o) => o.table === "user").sort((a, b) => Number(b.id === S) - Number(a.id === S));
  const otherUpdates = updates.filter((o) => o.table !== "user");
  const finalOps: MergeOp[] = [...deletes, ...userUpdates, ...otherUpdates, ...creates, ...copies, ...events];

  // One per club the source was in; a source with no club still gets one
  // (orgId "", as `mergePlayersCore` does) so the chain is never broken.
  const srcOrgs = [...new Set(srcMems.map((r) => r.orgId))];
  const tombstoneOrgIds = mergedIntoTarget ? [] : srcOrgs.length > 0 ? srcOrgs : [""];
  const noop = finalOps.length === 0 && mergedIntoTarget;

  return { sourceId: S, targetId: T, blockers: [], noop, ops: finalOps, conflicts, tombstoneOrgIds, alias };
}

/** Counts per table and kind, for the report and the audit row. */
export function summarisePlan(plan: MergePlan): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const o of plan.ops) {
    const table = o.kind === "event" || o.kind === "copyEvent" ? "attendanceEvent" : o.table;
    const kind = o.kind === "event" ? "append" : o.kind === "copyEvent" ? "inherit" : o.kind;
    out[table] ??= {};
    out[table][kind] = (out[table][kind] ?? 0) + 1;
  }
  return out;
}
