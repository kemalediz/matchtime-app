/**
 * WHICH MATCH AN ORGANISER CANCELS, OR PUTS BACK ON, FROM HQ (2026-10-22).
 * Pure, so the choice is tested without a database (`match-cancel.ts` loads
 * the club's matches and writes).
 *
 *   cancel   a match still to come (kickoff after now) that is not
 *            COMPLETED or CANCELLED
 *   restore  a CANCELLED match whose kickoff is still to come
 *
 * The day named, as the admin extractor wrote it (`matchDay`, verbatim), is
 * read by the free places' own day reader (`readDayHint`): that day's match,
 * or none (never a different match). Words that name no day ("this week")
 * mean the next one.
 *
 * A GAME THAT DID NOT HAPPEN (2026-10-28, Kemal: Sutton FC's Tuesday was
 * never played and MatchTime asked for its score and ratings). When the
 * words point at the past, the choice is made among the club's matches
 * that have kicked off in the last `PAST_CANCEL_WINDOW_DAYS` days instead:
 *
 *   cancel   a past match not CANCELLED (COMPLETED included): it is then
 *            marked as not played (`match-cancel.ts`)
 *   restore  a past match marked as NOT PLAYED: back on the record as played
 *
 * The words point at the past when the extractor says the game's time has
 * gone (`pastGame`: "it didn't happen", "olmadı") or the day named is gone
 * by ("yesterday", "last Tuesday", "dün", "geçen salı"). Otherwise only a
 * match still to come is ever picked, as before. The window is the same
 * for the web page, HQ and the players' group.
 */
import { formatLondon } from "./london-time";
import { readDayHint } from "./fee-waiver-rules";

export type HqMatchMode = "cancel" | "restore";

/** How long after kickoff a game can still be marked as not played, or put
 *  back on the record. One number for every door. */
export const PAST_CANCEL_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE = new Set(["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"]);
/** A past game that can be marked as not played: any status but CANCELLED. */
const PAST_CANCELLABLE = new Set([...ACTIVE, "COMPLETED"]);
const ACTIVE_OR_DONE = PAST_CANCELLABLE;

/** Its kickoff has passed. */
export function isPastGame(kickoff: Date, now: Date): boolean {
  return kickoff.getTime() <= now.getTime();
}

/** Kicked off, and no more than `PAST_CANCEL_WINDOW_DAYS` ago. */
export function withinPastCancelWindow(kickoff: Date, now: Date): boolean {
  const since = now.getTime() - kickoff.getTime();
  return since >= 0 && since <= PAST_CANCEL_WINDOW_DAYS * DAY_MS;
}
const londonKey = (d: Date): string => formatLondon(d, "yyyy-MM-dd");
const addDays = (key: string, n: number): string => new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** 1 = Monday .. 7 = Sunday. */
const isoDow = (key: string): number => {
  const d = new Date(`${key}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

export function pickHqMatch<T extends { id: string; date: Date; status: string; notPlayed?: boolean }>(
  all: readonly T[],
  now: Date,
  mode: HqMatchMode,
  dayPhrase?: string | null,
  pastGame?: boolean,
): T | null {
  const hint = readDayHint(dayPhrase);
  if (pointsAtPast(dayPhrase, pastGame)) return pickPastMatch(all, now, mode, hint);
  const ahead = all
    .filter((m) => m.date.getTime() > now.getTime() && (mode === "cancel" ? ACTIVE.has(m.status) : m.status === "CANCELLED"))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const today = londonKey(now);
  const on = (key: string) => ahead.find((m) => londonKey(m.date) === key) ?? null;
  if (!hint) return ahead[0] ?? null;
  if (hint.kind === "offset") return hint.days < 0 ? null : on(addDays(today, hint.days));
  if (hint.kind === "next-week") {
    const monday = addDays(today, 8 - isoDow(today));
    return ahead.find((m) => londonKey(m.date) >= monday) ?? null;
  }
  // A weekday: still to come, so this week's (today's, if it is today) or,
  // said "next", the one after.
  if (hint.dir === "last") return null;
  const gap = (hint.dow - isoDow(today) + 7) % 7;
  return on(addDays(today, gap === 0 && hint.dir === "next" ? 7 : gap));
}

/** The words point at a game whose time has gone: the extractor says so
 *  (`pastGame`), or the day named is gone by ("yesterday", "last Tuesday"). */
export function pointsAtPast(dayPhrase: string | null | undefined, pastGame?: boolean): boolean {
  if (pastGame === true) return true;
  const hint = readDayHint(dayPhrase);
  return (hint?.kind === "offset" && hint.days < 0) || (hint?.kind === "weekday" && hint.dir === "last");
}

/**
 * The game the words point at, among those that kicked off inside the
 * window, of ANY status (review of #437, 1): the most recent one, or the
 * most recent on the day named. Never an older game in its place:
 *
 *   cancel   it is returned even when already CANCELLED, and the core then
 *            says "already" (so a repeated "the last match didn't happen"
 *            never marks the game before it)
 *   restore  only a game marked as NOT PLAYED after kickoff (`notPlayed`);
 *            one called off before kickoff, or one played, is no answer
 *
 * "last Tuesday" said on a Tuesday is the one 7 days ago, as the free
 * places read it (`pickWaiverMatch`).
 */
function pickPastMatch<T extends { id: string; date: Date; status: string; notPlayed?: boolean }>(
  all: readonly T[],
  now: Date,
  mode: HqMatchMode,
  hint: ReturnType<typeof readDayHint>,
): T | null {
  const behind = all
    .filter((m) => withinPastCancelWindow(m.date, now) && (PAST_CANCELLABLE.has(m.status) || m.status === "CANCELLED"))
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  let found: T | null = null;
  if (!hint) found = behind[0] ?? null;
  else if (hint.kind === "offset") {
    const key = addDays(londonKey(now), hint.days);
    found = hint.days > 0 ? null : (behind.find((m) => londonKey(m.date) === key) ?? null);
  } else if (hint.kind === "weekday" && hint.dir !== "next") {
    const today = londonKey(now);
    found = behind.find((m) => isoDow(londonKey(m.date)) === hint.dow && !(hint.dir === "last" && londonKey(m.date) === today)) ?? null;
  }
  if (!found) return null;
  if (mode === "restore") return found.status === "CANCELLED" && found.notPlayed === true ? found : null;
  return found;
}

/**
 * A bare weekday that could mean last week's game (review of #437, 3): on
 * a Wednesday, "cancel Tuesday, we didn't play" without the extractor's
 * `pastGame` would cancel NEXT Tuesday and announce it. When the day named
 * is a weekday with no "last" or "next", the words did not say the past,
 * and a game on that weekday kicked off inside the window unscored and not
 * cancelled, MatchTime asks which game instead of acting. `next` is the
 * game still to come that the words would otherwise cancel, if any.
 */
export function bareWeekdayClash<T extends { id: string; date: Date; status: string; redScore?: number | null; yellowScore?: number | null }>(
  all: readonly T[],
  now: Date,
  dayPhrase: string | null | undefined,
  pastGame?: boolean,
): { past: T; next: T | null } | null {
  if (pastGame === true) return null;
  const hint = readDayHint(dayPhrase);
  if (hint?.kind !== "weekday" || hint.dir !== "near") return null;
  const past = all
    .filter(
      (m) =>
        withinPastCancelWindow(m.date, now) &&
        ACTIVE_OR_DONE.has(m.status) &&
        !(m.redScore != null && m.yellowScore != null) &&
        isoDow(londonKey(m.date)) === hint.dow,
    )
    .sort((a, b) => b.date.getTime() - a.date.getTime())[0];
  if (!past) return null;
  return { past, next: pickHqMatch(all, now, "cancel", dayPhrase, false) };
}

/**
 * Which "did it happen?" button the match page shows an organiser: "mark"
 * (This game didn't happen) for a past game inside the window with no
 * score, "restore" (It did happen) for one marked as not played, else none.
 */
export function notPlayedDoor(
  m: { date: Date; status: string; redScore: number | null; yellowScore: number | null; notPlayed?: boolean },
  now: Date,
): "mark" | "restore" | null {
  if (!withinPastCancelWindow(m.date, now)) return null;
  // Only a game marked as not played after kickoff can be put back as
  // played; one called off before kickoff was announced (review of #437, 7).
  if (m.status === "CANCELLED") return m.notPlayed === true ? "restore" : null;
  if (m.redScore !== null && m.yellowScore !== null) return null;
  return PAST_CANCELLABLE.has(m.status) ? "mark" : null;
}
