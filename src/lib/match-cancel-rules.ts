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
 *   restore  a CANCELLED past match: back on the record as played
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

export function pickHqMatch<T extends { id: string; date: Date; status: string }>(
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

/** The most recent past match inside the window, on the day named if one is. */
function pickPastMatch<T extends { id: string; date: Date; status: string }>(
  all: readonly T[],
  now: Date,
  mode: HqMatchMode,
  hint: ReturnType<typeof readDayHint>,
): T | null {
  const behind = all
    .filter((m) => withinPastCancelWindow(m.date, now) && (mode === "cancel" ? PAST_CANCELLABLE.has(m.status) : m.status === "CANCELLED"))
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  if (!hint) return behind[0] ?? null;
  if (hint.kind === "offset") {
    if (hint.days > 0) return null;
    const key = addDays(londonKey(now), hint.days);
    return behind.find((m) => londonKey(m.date) === key) ?? null;
  }
  if (hint.kind === "next-week") return null;
  if (hint.dir === "next") return null;
  return behind.find((m) => isoDow(londonKey(m.date)) === hint.dow) ?? null;
}

/**
 * Which "did it happen?" button the match page shows an organiser: "mark"
 * (This game didn't happen) for a past game inside the window with no
 * score, "restore" (It did happen) for one already marked, else none.
 */
export function notPlayedDoor(
  m: { date: Date; status: string; redScore: number | null; yellowScore: number | null },
  now: Date,
): "mark" | "restore" | null {
  if (!withinPastCancelWindow(m.date, now)) return null;
  if (m.status === "CANCELLED") return "restore";
  if (m.redScore !== null && m.yellowScore !== null) return null;
  return PAST_CANCELLABLE.has(m.status) ? "mark" : null;
}
