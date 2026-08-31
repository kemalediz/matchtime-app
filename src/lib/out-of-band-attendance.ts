/**
 * OUT-OF-BAND attendance announcements — pure copy + guards (2026-08-31).
 *
 * WHY (owner): the WhatsApp group is the social source of truth. When a
 * player signs up by replying to a DM, or taps IN in the web app, nobody
 * else can see it — so the group keeps recruiting, or never realises the
 * squad filled. MatchTime now posts one short line to the group for those
 * OUT-OF-BAND paths.
 *
 * DELIBERATELY NOT announced: registrations made IN the group. The group
 * already saw the message and MatchTime reacts to it there; announcing it
 * again would be noise. Nothing in the analyze route calls this.
 */

/**
 * How the player told us. "reaction" is a 👍 or 👎 tapped on the invite
 * DM (2026-08-31) — a distinct route worth naming in the group line,
 * because "replied by DM" would be a small lie about a message that was
 * never typed.
 */
export type OutOfBandSource = "dm" | "app" | "reaction";

/** The attendance states an out-of-band write can land on. */
export type OutOfBandStatus = "CONFIRMED" | "BENCH" | "DROPPED";

/** Prior state, or null when the player had no attendance row at all. */
export type AttendanceStatusLike = OutOfBandStatus | null;

/**
 * Per-org cap on out-of-band announcements in a rolling hour.
 *
 * The org's outbound circuit breaker allows 10 GROUP messages an hour
 * (MAX_GROUP_MESSAGES_PER_HOUR in src/lib/dispatch-claim.ts) and trips hard
 * once exceeded, suppressing ALL group dispatch — including the roster post
 * and the pre-match reminder. A recruit blast can produce a burst of DM
 * replies, so these announcements must never be able to eat that budget.
 * Four leaves six for the scheduled posts that actually run the match.
 *
 * Beyond the cap the REGISTRATION still happens and the player still gets
 * their personal confirmation; only the group line is dropped, and the
 * squad post covers it.
 */
export const MAX_OUT_OF_BAND_ANNOUNCEMENTS_PER_HOUR = 4;

/** Pure predicate: may we post another one this hour? */
export function withinOutOfBandAnnouncementCap(
  recentCount: number,
  cap: number = MAX_OUT_OF_BAND_ANNOUNCEMENTS_PER_HOUR,
): boolean {
  return recentCount < cap;
}

/**
 * Did anything actually change? A player replying "IN" twice must not
 * produce a second announcement — nothing happened the second time.
 * `registerAttendance` is idempotent, so an unchanged status is exactly the
 * signal that the write was a no-op.
 */
export function shouldAnnounceAttendanceChange(
  before: AttendanceStatusLike,
  after: AttendanceStatusLike,
): boolean {
  if (!after) return false;
  return before !== after;
}

export interface OutOfBandLineInput {
  playerName: string | null;
  status: OutOfBandStatus;
  source: OutOfBandSource;
  /** CONFIRMED count read from the DB AFTER the write. Never an estimate,
   *  never an LLM count. */
  confirmedCount: number;
  maxPlayers: number;
}

function sourceLabel(source: OutOfBandSource, status: OutOfBandStatus): string {
  if (source === "reaction") return status === "DROPPED" ? "👎 on their invite" : "👍 on their invite";
  return source === "dm" ? "replied by DM" : "from the app";
}

/**
 * One short, factual line for the group. House style: no em dashes, bold
 * name and bold count. The "N/M" is a squad ratio, not prose punctuation.
 */
export function buildOutOfBandAttendanceLine(input: OutOfBandLineInput): string {
  const name = input.playerName?.trim() || "A player";
  const squad = `Squad *${input.confirmedCount}/${input.maxPlayers}*.`;

  if (input.status === "BENCH") {
    const how =
      input.source === "reaction"
        ? "gave a 👍 on their invite"
        : input.source === "dm"
          ? "replied IN by DM"
          : "marked IN on the app";
    return `📋 *${name}* ${how} and goes to the bench. ${squad}`;
  }
  if (input.status === "DROPPED") {
    return `❌ *${name}* is OUT (${sourceLabel(input.source, input.status)}). ${squad}`;
  }
  return `✅ *${name}* is IN (${sourceLabel(input.source, input.status)}). ${squad}`;
}
