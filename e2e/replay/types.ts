/**
 * History replay — shared types.
 *
 * WHY THIS EXISTS
 * ---------------
 * MDs/analyzer-redesign-2026-08-31.md §10 step 3: "Run two weeks; read
 * the diff. Criteria fixed in advance: zero cases where the new pipeline
 * would write and the old correctly did not; ≤2% where it would miss a
 * write the old one correctly made."
 *
 * We do not have to wait two weeks. `AnalyzedMessage` already holds
 * 1,723 real production messages with bodies going back to 2026-04-20 —
 * 4.5 months of the same traffic a fortnight would sample. This harness
 * replays that history through ANY two pipelines and diffs them.
 *
 * The unit of replay is the BATCH, not the message: the Pi flushes a
 * buffer to `/api/whatsapp/analyze` and the route reasons over the whole
 * window at once, so replaying messages one at a time would compare a
 * world production never analysed.
 *
 * Everything here is data. The reconstruction rules live in
 * `reconstruct.ts`, the classification in `diff.ts` — both PURE and
 * unit-tested, no DB, no model, no Playwright.
 */
import type { CorpusCase } from "../corpus/grade";

// ── Raw production rows (read-only extract) ────────────────────────────
//
// Field-for-field subsets of the Prisma models, with every phone number
// and @lid JID already dropped by the extractor. `hasPhone` is a boolean
// precisely so a number can never reach a file.

export interface RawMessage {
  waMessageId: string;
  orgId: string;
  groupId: string;
  authorUserId: string | null;
  authorName: string | null;
  /** TRUE when WhatsApp delivered a phone (an @c.us sender). The number
   *  itself is never extracted. */
  authorHadPhone: boolean;
  body: string | null;
  /** What the LIVE analyzer did at the time. Triage signal ONLY — the
   *  incumbent is not ground truth (§10 step 3). Never asserted. */
  intent: string | null;
  action: string | null;
  handledBy: string;
  /** ISO. Analysis time, which is also the batch instant. */
  createdAt: string;
  /** The analyze REQUEST this message was reasoned about in. Null for
   *  every message written before `AnalyzedMessage.batchId` shipped
   *  (2026-09-01) — which is all 1,723 in the measured extract — so the
   *  batcher falls back to inferring from write timing for those, and
   *  only for those. See `batchMessages`. */
  batchId?: string | null;
}

/**
 * One row of the append-only attendance log (`AttendanceEvent`).
 *
 * This is the record that did not exist when the 2026-09-01 extract was
 * taken, and whose absence excluded 1,149 of 1,723 messages. Optional
 * on `ReplaySource` so an OLD extract still reconstructs exactly as it
 * did — the 447 has to stay comparable.
 */
export interface RawAttendanceEvent {
  matchId: string;
  userId: string;
  orgId: string;
  fromStatus: AttStatus | null;
  /** Null = the Attendance row was DELETED. */
  toStatus: AttStatus | null;
  fromPosition?: number | null;
  toPosition?: number | null;
  /** WHY it happened — see ATTENDANCE_EVENT_CAUSES in
   *  `src/lib/attendance-events.ts`. Triage and clustering only; the
   *  reconstruction itself never branches on it. */
  cause: string;
  actorKind: string;
  actorUserId?: string | null;
  /** ISO. */
  at: string;
}

export interface RawMatch {
  id: string;
  orgId: string;
  activityId: string;
  /** ISO kickoff. */
  date: string;
  maxPlayers: number;
  status: string;
  attendanceDeadline: string;
  redScore: number | null;
  yellowScore: number | null;
  createdAt: string;
  updatedAt: string;
}

export type AttStatus = "CONFIRMED" | "BENCH" | "DROPPED";

export interface RawAttendance {
  matchId: string;
  userId: string;
  status: AttStatus;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface RawMembership {
  orgId: string;
  userId: string;
  role: "OWNER" | "ADMIN" | "PLAYER";
  createdAt: string;
  leftAt: string | null;
}

export interface RawUser {
  id: string;
  name: string | null;
  hasPhone: boolean;
}

export interface RawOrg {
  id: string;
  name: string;
  /** The `feature*` columns, keyed the way `CreateGroupOpts.features`
   *  wants them. Assumed stable — see ASSUMPTIONS in reconstruct.ts. */
  features: Record<string, boolean>;
}

export interface RawTeamAssignment {
  matchId: string;
  userId: string;
  team: "RED" | "YELLOW";
}

export interface RawBenchOffer {
  matchId: string;
  replacingUserId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/**
 * An open question MatchTime asked and had not yet been answered.
 *
 * Added for the router's open-question context (`awaiting-answer.ts`).
 * `BenchSlotOffer` was already extracted for world reconstruction; these
 * two were not, and without them the recall sweep cannot reproduce
 * either of the two thumbs-up cases PR #42 found.
 */
export interface RawPendingBenchConfirmation {
  matchId: string;
  userId: string;
  createdAt: string;
  resolvedAt: string | null;
  expiresAt: string;
}

export interface RawTentativeAvailability {
  matchId: string;
  userId: string;
  notifiedAt: string | null;
  resolvedAt: string | null;
}

export interface ReplaySource {
  messages: RawMessage[];
  matches: RawMatch[];
  attendance: RawAttendance[];
  memberships: RawMembership[];
  users: RawUser[];
  orgs: RawOrg[];
  teamAssignments: RawTeamAssignment[];
  benchOffers: RawBenchOffer[];
  /** OPTIONAL, like `attendanceEvents`: an extract taken before the
   *  router's open-question context existed simply has none, and every
   *  batch then routes exactly as it did on `b03d96b`. */
  pendingBenchConfirmations?: RawPendingBenchConfirmation[];
  tentativeAvailabilities?: RawTentativeAvailability[];
  /** The append-only attendance log. OPTIONAL: an extract taken before
   *  the table existed simply has none, and reconstructs exactly as it
   *  did before. */
  attendanceEvents?: RawAttendanceEvent[];
  /** When the extract was taken, and against which schema revision. */
  extractedAt?: string;
}

// ── Reconstruction output ──────────────────────────────────────────────

/**
 * Why a batch could NOT be replayed. A fabricated world produces a
 * fabricated diff, so every one of these is an exclusion, never a guess.
 */
export type ExclusionReason =
  /** A message in the batch has no body — nothing to send. */
  | "no-body"
  /** No upcoming match at that instant, and a deleted Match row leaves
   *  no trace, so "there was no match" cannot be distinguished from
   *  "the match row was later deleted". */
  | "no-upcoming-match"
  /** An Attendance row existed before the batch and changed after it.
   *  There is no attendance audit log, so its status AT the batch
   *  instant is unknowable. THE BIG ONE. */
  | "attendance-state-unknown"
  /** The gap to the neighbouring message falls in the band where two
   *  flushes and one slow flush are indistinguishable, so the batch
   *  composition itself is a guess. */
  | "batch-boundary-ambiguous"
  /** The batch's org has no reconstructable roster (no memberships
   *  predating the batch). */
  | "no-roster"
  /** The sender is neither a resolved user nor a usable pushname. */
  | "sender-unknown";

export interface Exclusion {
  batchKey: string;
  orgId: string;
  at: string;
  waMessageIds: string[];
  reason: ExclusionReason;
  detail: string;
}

/**
 * How solid the reconstruction is.
 *  - "strict": every element of the replayed world was PROVEN at the
 *    batch instant from row timestamps. The headline §10 criteria are
 *    computed on these and only these.
 *  - "wide": the same, but the world is knowingly IMPOVERISHED in a way
 *    that is stated per case (see `caveats`) — currently only "a
 *    previous completed match existed and was left out because its
 *    state at that instant is unrecoverable". An impoverished world is
 *    symmetric across the two pipelines being diffed, so the comparison
 *    still holds; what it weakens is the claim that this is exactly
 *    what production saw. Reported separately so any number can be
 *    recomputed without them.
 */
export type ReplayTier = "strict" | "wide";

/**
 * WHERE the replayed squad came from.
 *  - "event-log": folded from `AttendanceEvent`, which RECORDS every
 *    transition. The status at the batch instant is a fact.
 *  - "row-timestamps": inferred from `Attendance.createdAt/updatedAt`,
 *    which only works when a row was already settled — the rule that
 *    excluded 1,149 messages. Every case in the 2026-09-01 extract is
 *    this, and always will be; the log only helps from the day it is
 *    applied.
 * Reported per case so the two can never be silently mixed in a number.
 */
export type SquadSource = "event-log" | "row-timestamps";

export interface ReplayMeta {
  batchKey: string;
  orgId: string;
  /** Pseudonymous group handle — never the real @g.us JID. */
  groupRef: string;
  /** ISO instant the batch was analysed in production. */
  at: string;
  tier: ReplayTier;
  /** Documented assumptions this particular case leans on. */
  assumptions: string[];
  /** Ways this world is knowingly thinner than the real one. Any
   *  non-empty list makes the case tier "wide". */
  caveats: string[];
  hoursToKickoff: number;
  maxPlayers: number;
  /** Whether the squad below was PROVEN from the event log or inferred
   *  from row timestamps. */
  squadSource: SquadSource;
  squadBefore: { confirmed: number; bench: number; dropped: number };
  /** What production's live analyzer did, per message. TRIAGE ONLY. */
  prodOutcomes: Array<{
    waMessageId: string;
    intent: string | null;
    action: string | null;
    handledBy: string;
  }>;
  /** Senders production could not resolve to a user. */
  unresolvedSenders: string[];
}

/** A reconstructed batch, ready to hand to any `CorpusPipeline`. */
export interface ReplayCase {
  key: string;
  meta: ReplayMeta;
  /** The corpus's own case shape — so the EXISTING adapter runs it. */
  case: CorpusCase;
}

export interface ReconstructionStats {
  messagesInSource: number;
  messagesReplayable: number;
  messagesExcluded: number;
  batchesInSource: number;
  batchesReplayable: number;
  batchesExcluded: number;
  byTier: Record<ReplayTier, number>;
  /** How many replayable batches had their squad PROVEN from the event
   *  log vs inferred from row timestamps. The honest way to report the
   *  fix: this is 0 / N until the log has been live for a while, and
   *  saying so is the point. */
  bySquadSource: Record<SquadSource, number>;
  /** How many batches were grouped by a RECORDED `batchId` rather than
   *  by write timing. Same story, same reason for reporting it. */
  batchesFromRecordedId: number;
  byReason: Record<ExclusionReason, { batches: number; messages: number }>;
  /** Production's own intent labels over the REPLAYABLE messages. Not
   *  ground truth; the 69%-is-noise economic claim reads off this. */
  intentDistribution: Record<string, number>;
  intentDistributionAll: Record<string, number>;
}

export interface Reconstruction {
  cases: ReplayCase[];
  excluded: Exclusion[];
  stats: ReconstructionStats;
}
