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

export interface ReplaySource {
  messages: RawMessage[];
  matches: RawMatch[];
  attendance: RawAttendance[];
  memberships: RawMembership[];
  users: RawUser[];
  orgs: RawOrg[];
  teamAssignments: RawTeamAssignment[];
  benchOffers: RawBenchOffer[];
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
