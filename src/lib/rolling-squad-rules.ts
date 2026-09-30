/**
 * ROLLING SQUAD, THE PURE RULES (2026-09-30).
 *
 * Slice 1 of MDs/friday-group-features-plan-2026-09-30.md. A club with
 * `Organisation.rollingSquadEnabled` works the way Hamzah's Friday group
 * works by hand: if you played last week you are in this week unless you
 * say OUT. At 08:00 London the morning after a match, everyone who was
 * CONFIRMED on it when it completed is written CONFIRMED on the next
 * match of the same fixture.
 *
 * Everything here is a decision on facts already loaded: no database, no
 * clock, no model. `rolling-squad.ts` loads the rows and writes the
 * result.
 */
import { formatLondon, londonDateTimeToUtc } from "./london-time";
import { isSameRecurringFixture, type RecurringFixtureKey } from "./match-slot";

/** How far back "last week" may be (decision D1). A cancelled week is
 *  skipped and the one before it used; a longer gap (a summer break)
 *  seeds nothing, and the admin can press "Carry over last squad". */
export const ROLLING_LOOKBACK_DAYS = 21;

/** The London hour the squad is carried over (decision D3): the night
 *  after the match is the admins' window to remove a no-show first. */
export const ROLLING_SEED_HOUR = "08:00";

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE = new Set(["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"]);

export interface FixtureMatch {
  id: string;
  date: Date;
  status: string;
  isHistorical?: boolean;
  activityId?: string;
  /** The recurring-fixture identity. NOT `activityId`: a format switch
   *  re-points a match to the other activity (see `match-slot.ts`). */
  activity: RecurringFixtureKey;
  rollingSeededAt?: Date | null;
}

/**
 * "Last week's match" for `target`: the most recent COMPLETED,
 * non-historical match of the same fixture strictly before it, within
 * `lookbackDays` of the target. A CANCELLED week is never a source, so
 * after one the week before it is used (D1).
 */
export function pickSeedSource<T extends FixtureMatch>(
  target: FixtureMatch,
  candidates: T[],
  opts: { lookbackDays?: number } = {},
): T | null {
  const lookbackMs = (opts.lookbackDays ?? ROLLING_LOOKBACK_DAYS) * DAY_MS;
  const t = target.date.getTime();
  let best: T | null = null;
  for (const c of candidates) {
    if (c.id === target.id) continue;
    if (c.status !== "COMPLETED" || c.isHistorical) continue;
    if (!isSameRecurringFixture(c.activity, target.activity)) continue;
    const d = c.date.getTime();
    if (d >= t) continue;
    if (t - d > lookbackMs) continue;
    if (!best || d > best.date.getTime()) best = c;
  }
  return best;
}

/**
 * The match of `fixture` that is seeded next: the SOONEST live,
 * non-historical match of the fixture. Null when that match has already
 * kicked off (it is still in flight, and seeding the one after it would
 * skip a week) or has already been seeded (never skip ahead to the week
 * after).
 */
export function pickSeedTarget<T extends FixtureMatch>(
  matches: T[],
  fixture: RecurringFixtureKey,
  now: Date,
): T | null {
  let soonest: T | null = null;
  for (const m of matches) {
    if (m.isHistorical || !LIVE.has(m.status)) continue;
    if (!isSameRecurringFixture(m.activity, fixture)) continue;
    if (!soonest || m.date.getTime() < soonest.date.getTime()) soonest = m;
  }
  if (!soonest) return null;
  if (soonest.date.getTime() <= now.getTime()) return null;
  if (soonest.rollingSeededAt) return null;
  return soonest;
}

/** "YYYY-MM-DD" one calendar day after `ymd`. Calendar arithmetic, so a
 *  23- or 25-hour DST day cannot move it. */
function nextDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

/** The first 08:00 London strictly after `sourceEnd`. DST-safe. */
export function rollingSeedDueAt(sourceEnd: Date): Date {
  const day = formatLondon(sourceEnd, "yyyy-MM-dd");
  const sameDay = londonDateTimeToUtc(day, ROLLING_SEED_HOUR);
  if (sameDay.getTime() > sourceEnd.getTime()) return sameDay;
  return londonDateTimeToUtc(nextDay(day), ROLLING_SEED_HOUR);
}

export function rollingSeedDue(sourceEnd: Date, now: Date): boolean {
  return now.getTime() >= rollingSeedDueAt(sourceEnd).getTime();
}

/** One Attendance row on the SOURCE match, with what is needed to decide
 *  whether its player is carried over. */
export interface SeedSourceRow {
  userId: string;
  status: string;
  position: number;
  phoneNumber: string | null;
  email: string;
  isActive: boolean;
  /** The player's membership of THIS club, or null when there is none. */
  membership: { leftAt: Date | null; provisionallyAddedAt: Date | null } | null;
}

export type CarryOverExclusion = "did not play" | "left the group" | "deactivated" | "guest without a phone";

/**
 * Why a source row is NOT carried over, or null when it is (plan 1.3).
 *
 *   BENCH or DROPPED       did not play (D2: the bench is not carried)
 *   left / no membership   left the group or was removed
 *   User.isActive false    deactivated
 *   phoneless placeholder  a one-off guest someone else registered
 *                          (`provisional+` email or `provisionallyAddedAt`,
 *                          and no phone): cannot be DMed, never asked
 *
 * A phoneless member an admin confirmed, and a provisional member WITH a
 * phone, are real regulars and are carried.
 */
export function carryOverExclusion(row: SeedSourceRow): CarryOverExclusion | null {
  if (row.status !== "CONFIRMED") return "did not play";
  if (!row.membership || row.membership.leftAt) return "left the group";
  if (!row.isActive) return "deactivated";
  const placeholder = row.email.startsWith("provisional+") || row.membership.provisionallyAddedAt != null;
  if (!row.phoneNumber && placeholder) return "guest without a phone";
  return null;
}

export interface SeedDecision {
  userId: string;
  status: "CONFIRMED" | "BENCH";
  /** Written on the AttendanceEvent. Never parsed. */
  note: string;
}

export const SEED_NOTE_CARRIED = "carried over";
export const SEED_NOTE_OVERFLOW = "rolling overflow: no place left";

/**
 * Who is written onto the target, in order.
 *
 *   - the carried players keep last week's `position` order;
 *   - a player who already has ANY row on the target is untouched (his
 *     own statement wins: an early OUT stays OUT, an early IN is not
 *     duplicated);
 *   - when the carried players and the target's existing CONFIRMED rows
 *     exceed `maxPlayers` (a smaller format next week, or early INs), the
 *     first ones fill the squad and the rest go to BENCH in the same
 *     order. They are told nothing individually; the announcement lists
 *     them under the waiting list.
 */
export function decideSeed(args: {
  sourceRows: SeedSourceRow[];
  targetRows: Array<{ userId: string; status: string }>;
  maxPlayers: number;
}): SeedDecision[] {
  const onTarget = new Set(args.targetRows.map((r) => r.userId));
  const confirmedOnTarget = args.targetRows.filter((r) => r.status === "CONFIRMED").length;
  let room = Math.max(0, args.maxPlayers - confirmedOnTarget);
  const carried = args.sourceRows
    .filter((r) => carryOverExclusion(r) === null && !onTarget.has(r.userId))
    .sort((a, b) => a.position - b.position || a.userId.localeCompare(b.userId));
  const out: SeedDecision[] = [];
  for (const r of carried) {
    if (room > 0) {
      out.push({ userId: r.userId, status: "CONFIRMED", note: SEED_NOTE_CARRIED });
      room--;
    } else {
      out.push({ userId: r.userId, status: "BENCH", note: SEED_NOTE_OVERFLOW });
    }
  }
  return out;
}

/**
 * Is an OUT late? Judged by when the player SENT it, not when it reached
 * us (plan 1.6): "sorry can't make it" typed at 20:55 and delivered at
 * 21:40 is on time for a 21:00 deadline. Exactly at the deadline is on
 * time.
 */
export function isLateDrop(sentAt: Date, deadline: Date): boolean {
  return sentAt.getTime() > deadline.getTime();
}

/** Admin notices speak London 08:00 to 21:59. */
const NOTICE_FROM_HOUR = 8;
const NOTICE_QUIET_FROM_HOUR = 22;

/** When an admin notice queued `now` may go out: null for "now", else
 *  08:00 London next (plan R4). */
export function adminNoticeSendAfter(now: Date): Date | null {
  const hour = Number(formatLondon(now, "H"));
  const today = formatLondon(now, "yyyy-MM-dd");
  if (hour >= NOTICE_QUIET_FROM_HOUR) return londonDateTimeToUtc(nextDay(today), ROLLING_SEED_HOUR);
  if (hour < NOTICE_FROM_HOUR) return londonDateTimeToUtc(today, ROLLING_SEED_HOUR);
  return null;
}
