/**
 * Block bookings — pure core (2026-07-20).
 *
 * Sutton FC (and clubs like it) book the pitch as a BLOCK: N consecutive
 * weekly matches paid up-front to the venue. A BlockBooking row represents
 * that real-world booking; every Match in it is created UP-FRONT so the
 * whole season is visible and manageable (bulk cancel for holidays, bulk
 * restore, delete-as-a-set).
 *
 * This module is the pure logic, following the repo's pure-core convention
 * (match-slot.ts, next-upcoming-match.ts): no DB, unit-tested. The server
 * actions in src/app/actions/block-bookings.ts load rows and delegate every
 * decision here.
 *
 * Key invariants:
 *
 * - DST: kickoff times are LONDON WALL CLOCK. Each occurrence is resolved
 *   to UTC PER DATE via `londonDateTimeToUtc` — never a fixed offset. The
 *   real 2026 booking straddles the BST→GMT change (Sun 25 Oct 2026):
 *   20 Oct 21:30 BST = 20:30 UTC, 27 Oct 21:30 GMT = 21:30 UTC.
 *
 * - Idempotency: generation dedupes on the recurring SLOT — (orgId, venue,
 *   dayOfWeek) + instant proximity (±90 min) — exactly the notion the
 *   weekly generate-matches cron uses (src/lib/match-slot.ts). Re-running
 *   generation, or the cron running after a block exists, creates nothing.
 *
 * - Posting: nothing here posts. The "don't announce a block match until
 *   it's ON (not cancelled AND the previous match in the fixture has
 *   finished)" rule is `isNextUpcomingForPosting` in
 *   src/lib/next-upcoming-match.ts — an earlier LIVE match in the same
 *   fixture suppresses later ones; COMPLETED/CANCELLED matches stop
 *   blocking. Tests in __tests__/block-booking.test.ts pin that this holds
 *   over a 10-match horizon.
 *
 * - History is sacred: deleting a block never deletes a match that was
 *   played or carries any attendance/rating/vote/team data — those are
 *   DETACHED (blockBookingId → null) instead.
 */
import { londonDateTimeToUtc, formatLondon } from "./london-time";
import {
  hasMatchForSlot,
  type RecurringFixtureKey,
} from "./match-slot";

/** Hard cap on matches in one block — guards runaway date ranges. */
export const MAX_BLOCK_MATCHES = 60;

/** Match statuses that may be bulk-cancelled (the "live" statuses). */
const CANCELLABLE_STATUSES = new Set([
  "UPCOMING",
  "TEAMS_GENERATED",
  "TEAMS_PUBLISHED",
]);

export interface BlockSpec {
  /** First candidate calendar day (London), "YYYY-MM-DD". Rolled forward
   *  to the first occurrence of `dayOfWeek` if it isn't one. */
  startDate: string;
  /** Last calendar day (London), INCLUSIVE. Exactly one of endDate/count. */
  endDate?: string;
  /** Number of matches to generate. Exactly one of endDate/count. */
  count?: number;
  /** 0=Sun..6=Sat — the Activity's weekly day. */
  dayOfWeek: number;
  /** London wall-clock kickoff, "HH:mm". */
  time: string;
  /** Attendance deadline = kickoff − deadlineHours. */
  deadlineHours: number;
}

export interface BlockOccurrence {
  /** London calendar date, "YYYY-MM-DD". */
  date: string;
  /** DST-correct UTC kickoff instant for that date. */
  kickoffUtc: Date;
  /** kickoffUtc − deadlineHours. */
  attendanceDeadline: Date;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Weekday (0=Sun..6=Sat) of a calendar date — tz-independent. */
function weekdayOf(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Add `days` to a calendar date string (pure calendar arithmetic). */
function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * One occurrence per week on `dayOfWeek` at London wall-clock `time`, from
 * startDate to endDate inclusive (or `count` occurrences). Each kickoff is
 * resolved to UTC per calendar date so DST transitions inside the block
 * are handled correctly.
 */
export function generateBlockOccurrences(spec: BlockSpec): BlockOccurrence[] {
  const { startDate, endDate, count, dayOfWeek, time, deadlineHours } = spec;

  if (!DATE_RE.test(startDate)) {
    throw new Error(`Bad startDate "${startDate}" — expected YYYY-MM-DD`);
  }
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    throw new Error(`Bad dayOfWeek ${dayOfWeek} — expected 0 (Sun) … 6 (Sat)`);
  }
  const hasEnd = endDate !== undefined;
  const hasCount = count !== undefined;
  if (hasEnd === hasCount) {
    throw new Error("Provide exactly one of endDate or count");
  }
  if (hasEnd) {
    if (!DATE_RE.test(endDate!)) {
      throw new Error(`Bad endDate "${endDate}" — expected YYYY-MM-DD`);
    }
    if (endDate! < startDate) {
      throw new Error("endDate is before startDate");
    }
  }
  if (hasCount) {
    if (!Number.isInteger(count!) || count! < 1 || count! > MAX_BLOCK_MATCHES) {
      throw new Error(`count must be 1…${MAX_BLOCK_MATCHES}`);
    }
  }

  // Roll the start forward to the first occurrence of the weekday.
  let cursor = startDate;
  const delta = (dayOfWeek - weekdayOf(startDate) + 7) % 7;
  if (delta > 0) cursor = addDays(startDate, delta);

  const out: BlockOccurrence[] = [];
  while (true) {
    if (hasEnd && cursor > endDate!) break;
    if (hasCount && out.length >= count!) break;
    if (out.length >= MAX_BLOCK_MATCHES) {
      throw new Error(
        `Block would exceed ${MAX_BLOCK_MATCHES} matches — narrow the date range`,
      );
    }
    // londonDateTimeToUtc validates the "HH:mm" and is DST-safe PER DATE.
    const kickoffUtc = londonDateTimeToUtc(cursor, time);
    out.push({
      date: cursor,
      kickoffUtc,
      attendanceDeadline: new Date(
        kickoffUtc.getTime() - deadlineHours * 60 * 60 * 1000,
      ),
    });
    cursor = addDays(cursor, 7);
  }
  return out;
}

export interface ExistingMatchForDedupe {
  /** The existing Match's real UTC kickoff instant. */
  date: Date;
  /** Its Activity's recurring-fixture identity. */
  activity: RecurringFixtureKey;
}

export interface BlockGenerationPlan {
  /** Occurrences with no existing match in their slot — safe to create. */
  toCreate: BlockOccurrence[];
  /** Occurrences already covered by an existing match (cron-created, a
   *  previous run of this block, or a format-tweaked co-slot match). */
  duplicates: BlockOccurrence[];
}

/**
 * Which occurrences actually need a Match row? Dedupes on the recurring
 * slot — same (orgId, venue, dayOfWeek) + kickoff instant within ±90 min —
 * the exact notion the weekly generate-matches cron uses, so re-running
 * block generation is idempotent and a block never collides with matches
 * the cron already made.
 */
export function planBlockGeneration(
  occurrences: BlockOccurrence[],
  fixture: RecurringFixtureKey,
  existing: ExistingMatchForDedupe[],
): BlockGenerationPlan {
  const existingSlots = existing.map((m) => ({
    orgId: m.activity.orgId,
    venue: m.activity.venue,
    dayOfWeek: m.activity.dayOfWeek,
    instant: m.date,
  }));
  const toCreate: BlockOccurrence[] = [];
  const duplicates: BlockOccurrence[] = [];
  for (const occ of occurrences) {
    const slot = { ...fixture, instant: occ.kickoffUtc };
    (hasMatchForSlot(slot, existingSlots) ? duplicates : toCreate).push(occ);
  }
  return { toCreate, duplicates };
}

// ─────────────────────────── Bulk cancel / restore ────────────────────────

export interface BulkSelectableMatch {
  id: string;
  date: Date;
  status: string;
  isHistorical?: boolean;
}

export interface DateRange {
  /** Inclusive lower bound on Match.date. */
  from: Date;
  /** Inclusive upper bound on Match.date. */
  to: Date;
}

const inRange = (m: BulkSelectableMatch, r: DateRange): boolean =>
  m.date.getTime() >= r.from.getTime() && m.date.getTime() <= r.to.getTime();

const byDate = (a: BulkSelectableMatch, b: BulkSelectableMatch) =>
  a.date.getTime() - b.date.getTime();

/**
 * The matches a bulk-cancel over `range` may touch: live (UPCOMING /
 * TEAMS_GENERATED / TEAMS_PUBLISHED), non-historical, inside the range.
 * COMPLETED and already-CANCELLED matches are never selected — history is
 * untouchable and cancelling twice is a no-op.
 */
export function selectCancellable<T extends BulkSelectableMatch>(
  matches: T[],
  range: DateRange,
): T[] {
  return matches
    .filter(
      (m) =>
        !m.isHistorical && CANCELLABLE_STATUSES.has(m.status) && inRange(m, range),
    )
    .sort(byDate);
}

/**
 * The matches a bulk-restore over `range` may touch: CANCELLED,
 * non-historical, inside the range. Restore flips them back to UPCOMING.
 */
export function selectRestorable<T extends BulkSelectableMatch>(
  matches: T[],
  range: DateRange,
): T[] {
  return matches
    .filter(
      (m) => !m.isHistorical && m.status === "CANCELLED" && inRange(m, range),
    )
    .sort(byDate);
}

/**
 * The ONLY way the bulk-cancel path produces a group message. Silent by
 * default: returns null unless the admin EXPLICITLY opted in (`announce`)
 * AND something was actually cancelled. When it fires it is ONE summary
 * message for the whole batch — never one message per match.
 */
export function buildBulkCancelAnnouncement(args: {
  activityName: string;
  dates: Date[];
  announce: boolean;
}): string | null {
  const { activityName, dates, announce } = args;
  if (!announce || dates.length === 0) return null;
  const list = [...dates]
    .sort((a, b) => a.getTime() - b.getTime())
    .map((d) => `• ${formatLondon(d, "EEE d MMM")}`)
    .join("\n");
  const plural = dates.length === 1 ? "match is" : "matches are";
  return (
    `❌ *Schedule update* — the following *${activityName}* ${plural} OFF:\n\n` +
    `${list}\n\n` +
    `See you at the next one! 👋`
  );
}

// ─────────────────────────── Block deletion ───────────────────────────────

export interface BlockMatchForDeletion {
  id: string;
  status: string;
  isHistorical?: boolean;
  attendanceCount: number;
  ratingCount: number;
  momVoteCount: number;
  teamAssignmentCount: number;
}

export interface BlockDeletionPartition {
  /** Empty, unplayed shells (UPCOMING/CANCELLED with zero linked data) —
   *  safe to hard-delete alongside the block. */
  deleteIds: string[];
  /** Matches carrying history (COMPLETED, historical, or any attendances/
   *  ratings/MoM votes/team assignments) — NEVER deleted; the block link
   *  is detached instead. */
  detachIds: string[];
}

/**
 * Never destroy history. A match is only deletable when it was never
 * played (not COMPLETED, not historical) and nothing hangs off it.
 * Everything else survives the block's deletion with blockBookingId
 * detached.
 */
export function partitionBlockMatchesForDeletion(
  matches: BlockMatchForDeletion[],
): BlockDeletionPartition {
  const deleteIds: string[] = [];
  const detachIds: string[] = [];
  for (const m of matches) {
    const hasHistory =
      m.status === "COMPLETED" ||
      m.isHistorical === true ||
      m.attendanceCount > 0 ||
      m.ratingCount > 0 ||
      m.momVoteCount > 0 ||
      m.teamAssignmentCount > 0;
    (hasHistory ? detachIds : deleteIds).push(m.id);
  }
  return { deleteIds, detachIds };
}
