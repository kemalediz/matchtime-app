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
import { messageHoursSendAfter } from "./message-hours";
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
  /** The game's places (`Match.maxPlayers`). Read only by `hasSquadToCarry`. */
  maxPlayers?: number | null;
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
  membership: { leftAt: Date | null; provisionallyAddedAt: Date | null; guestFromOrgId?: string | null } | null;
  /** An admin has put this player on a squad of this club (an admin-group
   *  paste or squad change, an admin screen): see `admin-added.ts`.
   *  Missing means no. */
  addedByAdmin?: boolean;
}

export type CarryOverExclusion = "did not play" | "left the group" | "deactivated" | "guest without a phone" | "partner club guest";

/**
 * Why a source row is NOT carried over, or null when it is (plan 1.3).
 *
 *   BENCH or DROPPED       did not play (D2: the bench is not carried)
 *   left / no membership   left the group or was removed
 *   User.isActive false    deactivated
 *   phoneless placeholder  a one-off guest someone else registered
 *                          (`provisional+` email or `provisionallyAddedAt`,
 *                          and no phone, and never added by an admin):
 *                          cannot be DMed, never asked
 *
 * A phoneless member an admin added (`addedByAdmin`: a name pasted in the
 * admin group and confirmed, an admin squad change), a phoneless member
 * who is no placeholder, and a provisional member WITH a phone, are real
 * regulars and are carried.
 */
export function carryOverExclusion(row: SeedSourceRow): CarryOverExclusion | null {
  if (row.status !== "CONFIRMED") return "did not play";
  if (!row.membership || row.membership.leftAt) return "left the group";
  // A guest from a partner club played one match (cross-club ask, S4).
  if (row.membership.guestFromOrgId) return "partner club guest";
  if (!row.isActive) return "deactivated";
  const placeholder = row.email.startsWith("provisional+") || row.membership.provisionallyAddedAt != null;
  if (!row.phoneNumber && placeholder && !row.addedByAdmin) return "guest without a phone";
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
 * WHERE A SQUAD TO CARRY WOULD COME FROM, AS THINGS STAND AT `now`
 * (2026-10-13). For the group hello of a club going live: it may only say
 * "if you played last time, you're in next time too" when the seeding will
 * really put somebody on the next game. So this asks the seeding's own
 * question, per weekly fixture, with the seeding's own functions:
 *
 *   - a live match that has ALREADY KICKED OFF is read as completed: that
 *     is what go-live does to it (`quietMatchesBeforeGoLive`), and the
 *     seeding does not look at `postMatchEndFlow`, so a quieted match with
 *     players on it IS a source;
 *   - the next game is the soonest live match still to come; its source
 *     is `pickSeedSource` (most recent completed, same fixture, within
 *     `ROLLING_LOOKBACK_DAYS`);
 *   - a next game that was seeded already is its own answer: it has a
 *     carried squad if it has players on it;
 *   - with no next game generated yet, one a week from `now` is assumed.
 *
 * `seeded` true: read the match's own CONFIRMED rows. False: read the
 * rows `carryOverExclusion` would let through.
 */
interface FixtureCarryPlan<T> {
  /** The match whose players are counted; null when there is no source. */
  match: T | null;
  seeded: boolean;
  /** A game of this fixture is still to come. */
  hasNext: boolean;
  /** The places the squad is measured against: the next game's, else
   *  (no next game generated yet) the source's own. 0 when unknown. */
  places: number;
}

function fixtureCarryPlans<T extends FixtureMatch>(matches: T[], now: Date): Array<FixtureCarryPlan<T>> {
  const t = now.getTime();
  const asAtGoLive = matches.map((m) => (LIVE.has(m.status) && m.date.getTime() <= t ? { ...m, status: "COMPLETED" } : m));
  const fixtures: RecurringFixtureKey[] = [];
  for (const m of asAtGoLive) {
    if (!fixtures.some((f) => isSameRecurringFixture(f, m.activity))) fixtures.push(m.activity);
  }
  const out: Array<FixtureCarryPlan<T>> = [];
  for (const fixture of fixtures) {
    let next: T | null = null;
    for (const m of asAtGoLive) {
      if (m.isHistorical || !LIVE.has(m.status)) continue;
      if (!isSameRecurringFixture(m.activity, fixture)) continue;
      if (!next || m.date.getTime() < next.date.getTime()) next = m;
    }
    if (next?.rollingSeededAt) {
      out.push({ match: next, seeded: true, hasNext: true, places: next.maxPlayers ?? 0 });
      continue;
    }
    const target: FixtureMatch = next ?? { id: "", date: new Date(t + 7 * DAY_MS), status: "UPCOMING", activity: fixture };
    const source = pickSeedSource(target, asAtGoLive);
    out.push({
      match: source,
      seeded: false,
      hasNext: next != null,
      places: (next ? next.maxPlayers : source?.maxPlayers) ?? 0,
    });
  }
  return out;
}

/** The matches whose players `hasSquadToCarry` needs, for the loader. */
export function carrySourcesAt<T extends FixtureMatch>(matches: T[], now: Date): Array<{ match: T; seeded: boolean }> {
  return fixtureCarryPlans(matches, now).flatMap((p) => (p.match ? [{ match: p.match, seeded: p.seeded }] : []));
}

/**
 * IS A CARRIED SQUAD "THE SQUAD"? (owner decision, 2026-10-13.) At least
 * HALF of the game's places (`Match.maxPlayers`, the number the
 * squad-full logic compares against). One player who tapped In on the
 * website before go-live is carried by the seeding, but a group told
 * "if you played last time, you're in next time too" on the strength of
 * him would be wrong about everybody else. Below half, most of the group
 * still has to say In, so the copy asks for it.
 *
 * The seeding itself does not use this: it carries whoever it carries.
 * This only chooses between two wordings, in the group hello and in the
 * 17:00 post's deadline line.
 */
export function isSubstantialSquad(carried: number, places: number): boolean {
  return carried > 0 && places > 0 && carried * 2 >= places;
}

/**
 * Does MatchTime already have a squad to carry over for this club? The
 * hello's standing wording ("if you played last time, you're in next time
 * too") is used only when this is true.
 *
 * Per weekly fixture: the players the seeding would write onto the next
 * game (or has written, when it was seeded already) are counted against
 * that game's places with `isSubstantialSquad`. Then:
 *   - EVERY fixture with a game coming up must have a substantial squad:
 *     one hello speaks to the whole group, and it would be false for the
 *     game that has none;
 *   - with no game coming up at all, one fixture with a substantial squad
 *     (measured against its own last game's places) is enough.
 *
 * The count is of carriable players on the source. Rows already on the
 * next game are not subtracted: an early In is in either way, and an early
 * Out before go-live is rare enough not to move a "half" threshold.
 *
 * `rows` holds the attendance of the matches `carrySourcesAt` named.
 */
export function hasSquadToCarry(args: {
  matches: FixtureMatch[];
  rows: Map<string, SeedSourceRow[]>;
  now: Date;
}): boolean {
  const plans = fixtureCarryPlans(args.matches, args.now).map((p) => {
    const carried = p.match
      ? (args.rows.get(p.match.id) ?? []).filter((r) => (p.seeded ? r.status === "CONFIRMED" : carryOverExclusion(r) === null)).length
      : 0;
    return { hasNext: p.hasNext, substantial: isSubstantialSquad(carried, p.places) };
  });
  const upcoming = plans.filter((p) => p.hasNext);
  if (upcoming.length > 0) return upcoming.every((p) => p.substantial);
  return plans.some((p) => p.substantial);
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

/**
 * When an admin notice queued `now` may go out: null for "now" (09:00 to
 * 22:59 London, the shared message hours), else the next 09:00 London
 * (plan R4). No longer tied to `ROLLING_SEED_HOUR`: the squad is still
 * carried over at 08:00, and a notice that seed queues waits for 09:00.
 */
export function adminNoticeSendAfter(now: Date): Date | null {
  return messageHoursSendAfter(now);
}
