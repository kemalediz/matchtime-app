/**
 * DO NOT POST THE SAME SQUAD TWICE (2026-10-06).
 *
 * Sutton FC, Tue 6 Oct 2026, match day. At 07:28 London an admin wrote
 * "@David is out due to minor injury ... Can we have more players
 * please". MatchTime answered with the squad (13/14, need 1 more) and
 * "On it, DM'd 8 recent players". At 08:00 the match-day morning chase
 * posted the same thirteen names again, with the same need.
 *
 * The scheduler could not have known. Its only memory is the set of
 * `SentNotification` keys it has claimed itself, and a reply from the
 * analyze route left no row behind: the reply text travels back to the
 * Pi in the HTTP response and is stored nowhere. The outbound text log
 * (`txtlog:` rows) covers scheduler posts only, and holds a hash of the
 * whole text, which cannot say "this was a roster for this squad".
 *
 * So both writers leave a small marker in the table they already write
 * to, the way a monthly club's list does (`recordWeekListShown`). No
 * schema change:
 *
 *   key  = <matchId>:roster-shown:<squad fingerprint>:<ms>
 *   kind = roster-shown
 *     written by the analyze route when its reply carries the squad
 *     post, and by /api/whatsapp/due-posts when it hands out a scheduler
 *     post that carries the roster (`DueInstruction.rosterShown`).
 *
 *   key  = <matchId>:recruit-ack:<need>:<ms>
 *   kind = recruit-ack
 *     written by the analyze route when its reply says the recruit DMs
 *     went out.
 *
 * The scheduler reads them back for the last three hours and:
 *   - sends a scheduled post WITHOUT its roster block when the same
 *     squad was shown inside that window (the need, the kickoff and the
 *     format-switch line stay);
 *   - skips the match-day morning chase altogether when the group was
 *     told about the recruit DMs for the same need inside that window.
 *     The chase's key is left unclaimed, so a later poll in the same
 *     morning window sends it if the need has changed.
 *
 * Everything here is pure: no database, no model, no clock.
 */
import { createHash } from "node:crypto";

export const ROSTER_SHOWN_KIND = "roster-shown";
export const RECRUIT_ACK_KIND = "recruit-ack";

/** How long a posted roster (or recruit ack) keeps the next one quiet. */
export const ROSTER_QUIET_MS = 3 * 60 * 60 * 1000;

/** Is `at` inside the quiet window before `now`? The one test of "shown
 *  a moment ago", for the weekly roster's markers below and for a monthly
 *  club's list rows (`<matchId>:month-list:<hash>:<n>`, which carry their
 *  own hash and time, so they need no second marker). */
export function shownInQuietWindow(at: Date | null | undefined, now: Date): boolean {
  return !!at && at.getTime() >= now.getTime() - ROSTER_QUIET_MS;
}

/** The fields the checks read off a `SentNotification` row. */
export interface QuietMarkerRow {
  key: string;
  kind?: string | null;
  createdAt?: Date | null;
}

/**
 * One squad, as a short hex string: who is confirmed, who is on the
 * bench and how many places there are. The same people in a different
 * order are the same squad; the need is `maxPlayers` minus the confirmed
 * count, so it is covered by the two together.
 */
export function squadFingerprint(args: {
  confirmedUserIds: readonly string[];
  benchUserIds: readonly string[];
  maxPlayers: number;
}): string {
  const body = [
    args.maxPlayers,
    [...args.confirmedUserIds].sort().join(","),
    [...args.benchUserIds].sort().join(","),
  ].join("|");
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

export function rosterShownKey(matchId: string, fingerprint: string, at: Date): string {
  return `${matchId}:${ROSTER_SHOWN_KIND}:${fingerprint}:${at.getTime()}`;
}

export function recruitAckKey(matchId: string, need: number, at: Date): string {
  return `${matchId}:${RECRUIT_ACK_KIND}:${need}:${at.getTime()}`;
}

/** The value a marker key carries (the fingerprint, or the need), or
 *  null when the key is not a marker of this kind for this match. */
function markerValue(row: QuietMarkerRow, matchId: string, kind: string, now: Date): string | null {
  if (row.kind !== kind) return null;
  const prefix = `${matchId}:${kind}:`;
  if (!row.key.startsWith(prefix)) return null;
  if (!shownInQuietWindow(row.createdAt, now)) return null;
  return row.key.slice(prefix.length).split(":")[0] || null;
}

/** Was this exact squad posted to the group in the last three hours? */
export function rosterShownRecently(
  rows: readonly QuietMarkerRow[],
  args: { matchId: string; fingerprint: string; now: Date },
): boolean {
  return rows.some((r) => markerValue(r, args.matchId, ROSTER_SHOWN_KIND, args.now) === args.fingerprint);
}

/** Was the group told, in the last three hours, that recruit DMs went
 *  out for this same number of open places? */
export function recruitAckRecently(
  rows: readonly QuietMarkerRow[],
  args: { matchId: string; need: number; now: Date },
): boolean {
  return rows.some((r) => markerValue(r, args.matchId, RECRUIT_ACK_KIND, args.now) === String(args.need));
}

const NUMBERED_ROW = /^\s*\d+[.)]\s+\S/;
/** "*Playing tonight:*", "*Bench (1):*", "*Confirmed (13/14):*", and
 *  the same in any language: a short line that ends with a colon. */
const BLOCK_HEADER = /^\s*[*_]*[^\n]{1,60}:[*_]*\s*$/;

/**
 * A group post without its roster: the numbered rows and the header
 * above each run are removed, every other line is kept as written.
 *
 * Language-free on purpose. A run is two or more numbered rows, or a
 * single one that sits directly under a header line (a bench of one).
 * A numbered sentence on its own in the middle of a message is left
 * alone.
 */
export function stripRosterBlock(text: string): string {
  const lines = text.split("\n");
  const drop = new Set<number>();
  let i = 0;
  while (i < lines.length) {
    if (!NUMBERED_ROW.test(lines[i])) {
      i++;
      continue;
    }
    let end = i;
    while (end + 1 < lines.length && NUMBERED_ROW.test(lines[end + 1])) end++;
    const headed = i > 0 && BLOCK_HEADER.test(lines[i - 1]) && !NUMBERED_ROW.test(lines[i - 1]);
    if (end > i || headed) {
      for (let k = i; k <= end; k++) drop.add(k);
      if (headed) drop.add(i - 1);
    }
    i = end + 1;
  }
  if (drop.size === 0) return text;
  return lines
    .filter((_, idx) => !drop.has(idx))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function hasRosterBlock(text: string): boolean {
  return stripRosterBlock(text) !== text;
}
