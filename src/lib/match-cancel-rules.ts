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
 */
import { formatLondon } from "./london-time";
import { readDayHint } from "./fee-waiver-rules";

export type HqMatchMode = "cancel" | "restore";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE = new Set(["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"]);
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
): T | null {
  const ahead = all
    .filter((m) => m.date.getTime() > now.getTime() && (mode === "cancel" ? ACTIVE.has(m.status) : m.status === "CANCELLED"))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const today = londonKey(now);
  const on = (key: string) => ahead.find((m) => londonKey(m.date) === key) ?? null;
  const hint = readDayHint(dayPhrase);
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
