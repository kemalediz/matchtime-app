/**
 * HOW MUCH OF A MONTH A REGULAR COVERS (Kemal, 2026-11-16). Pure: no
 * database, no model.
 *
 * A regular's `gamesCovered` is how many of the month's games their money
 * is for. The seed covers its regulars for the whole month (plan 4.5,
 * `squad-month-rules.ts` `wholeMonthGames`); anybody added once the month
 * had started covered only the games left (plan section 7, "Joining
 * mid-month"), including a player the organiser adds from the same
 * pre-paid list. The plan said "the admin page can override"; this is that
 * override, in the places that share these rules:
 *
 *   - "Add a player" on /admin/months, once the month has started: the
 *     organiser chooses the whole month (already paid) or the games left;
 *   - the coverage editor on /admin/months, for a regular already on it;
 *   - the same by tagging MatchTime in the organisers' group (the admin
 *     extractor reads `coverage` from the words), with ONE question when
 *     the words do not say which ("Whole month, or just the games left?").
 *
 * THE BOUNDS (review of #611, item 1): coverage only changes the future.
 * A regular never covers fewer games than those he was covered for that
 * are already played (since he joined; since the month's first game for a
 * seeded regular) plus the games still to play, and never more than the
 * whole month. The editor's choices and the server's checks both come from
 * `memberCoverageBounds`. What he commits to ("4 only") is kept while it
 * fits; the credits taken off the month stay within what he covers (the
 * `SquadMonthMember_counts_check` CHECK).
 *
 * CANCELLED WEEKS (item 7): the whole month is every game scheduled, a
 * cancelled one included, as the seed counts it. So a member who covers
 * the whole month is credited for a cancelled week exactly as a seeded
 * regular is, whatever his join date (`creditsCountFrom`, the one rule the
 * cancelled-week credits use).
 */
import type { HqLogRow } from "./admin-group-log";
import { CONFIRM_WINDOW_MS, questionInPlaceOfAnswer, quotedLogRow, type QuotedMessage } from "./admin-group-confirm-rules";
import { wholeMonthGames } from "./squad-month-rules";

const isWholeNumber = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** The two ends an organiser names: the whole month, or the games left. */
export type Coverage = "whole" | "left";

/** A month, as coverage sees it. */
export interface MonthCoverage {
  /** The month's games still to be played. */
  gamesLeft: number;
  /** The whole month: the seed's rule (every game scheduled). */
  whole: number;
  /** The whole month less its cancelled weeks: what "the whole month (N
   *  games)" says to an organiser. */
  playable: number;
}

/**
 * @param kickoffs the month's games, cancelled weeks left out (`monthGames`).
 *
 * The playable games are the whole month less the weeks called off AFTER
 * it was counted (round 3, item 3): a week called off before the list
 * opened is already out of `gamesScheduled`, so each called-off week is
 * counted once. That is the smaller of the two counts.
 */
export function monthCoverage(p: { gamesScheduled: number; kickoffs: Date[]; now: Date }): MonthCoverage {
  const whole = wholeMonthGames(p.gamesScheduled);
  const gamesLeft = Math.min(whole, p.kickoffs.filter((k) => k.getTime() > p.now.getTime()).length);
  return { gamesLeft, whole, playable: Math.min(whole, p.kickoffs.length) };
}

/**
 * A regular's coverage as an organiser reads it, in PLAYABLE games (round
 * 3, item 5): one number for "of" everywhere (the month's playable games),
 * and the games he covers less the called-off weeks he is credited for
 * (that credit gives them back). The whole month reads "N of N".
 */
export function shownCoverage(m: { gamesCovered: number; creditedCancelled?: number }, month: MonthCoverage): { games: number; of: number; wholeMonth: boolean } {
  const wholeMonth = m.gamesCovered >= month.whole;
  const games = wholeMonth ? month.playable : Math.max(0, Math.min(month.playable, m.gamesCovered - Math.max(0, m.creditedCancelled ?? 0)));
  return { games, of: month.playable, wholeMonth };
}

/**
 * The editor's options for one regular: every coverage his bounds allow,
 * shown in playable games (`shownCoverage`), each shown once. A coverage
 * below the whole month that already reads as every playable game is
 * left out: the whole month is that choice.
 */
export function coverageOptions(
  b: CoverageBounds,
  month: MonthCoverage,
  creditedCancelled: number,
): Array<{ value: number; games: number; of: number; least: boolean; wholeMonth: boolean }> {
  const out: Array<{ value: number; games: number; of: number; least: boolean; wholeMonth: boolean }> = [];
  for (let value = b.min; value <= b.max; value++) {
    const s = shownCoverage({ gamesCovered: value, creditedCancelled }, month);
    if (!s.wholeMonth && s.games >= month.playable) continue;
    out.push({ value, games: s.games, of: s.of, least: value === b.min && !s.wholeMonth, wholeMonth: s.wholeMonth });
  }
  return out;
}

/** A seeded regular's games count from the month's first game. */
export function seededSource(source: string): boolean {
  return source.startsWith("seed");
}

export interface CoverageBounds {
  /** The fewest he may cover: what he played since he joined, and the games left. */
  min: number;
  /** The whole month. */
  max: number;
}

/**
 * One member's bounds. `kickoffs` are the month's games (cancelled weeks
 * left out); a game counts as played once it has kicked off.
 */
export function memberCoverageBounds(
  m: MonthCoverage,
  p: {
    joinedAt: Date;
    source: string;
    kickoffs: Date[];
    now: Date;
    /** His live "cancelled-week" credits on this month: weeks called off
     *  that he is credited for (review round 2, item 1). */
    creditedCancelled?: number;
  },
): CoverageBounds {
  // A seeded regular counts from the month's first game: every game it
  // scheduled, a called-off week included (the seed's rule). He is never lowered.
  if (seededSource(p.source)) return { min: m.whole, max: m.whole };
  const played = p.kickoffs.filter((k) => k.getTime() <= p.now.getTime() && k.getTime() > p.joinedAt.getTime()).length;
  // A called-off week is in none of the month's games (`kickoffs` leave it
  // out), so a week he holds a credit for is added back: lowering must
  // never remove a week he is credited for, or he is credited twice.
  const credited = Math.max(0, p.creditedCancelled ?? 0);
  const min = Math.min(m.whole, Math.max(played + credited + m.gamesLeft, Math.min(1, m.whole)));
  return { min, max: m.whole };
}

/** The games a coverage names. */
export function coverageGames(c: Coverage | number, b: CoverageBounds): number {
  return c === "whole" ? b.max : c === "left" ? b.min : c;
}

export type CoverageError = "bad-games" | "below-games-left" | "more-than-the-month" | "below-credits" | "not-a-member" | "not-a-regular";

export interface CoverageRow {
  kind: "regular" | "payg";
  /** Off the month (`leftAt`). */
  out: boolean;
  gamesCovered: number;
  gamesCommitted: number | null;
  creditsApplied: number;
}

/**
 * The organiser sets how much of the month a regular covers. The new games
 * covered, and the games committed: kept while they fit (at most the games
 * covered), cleared to every game only when they no longer do (review
 * item 6: a "3 only" lowered to 3 and raised again is still "3 only").
 */
export function decideCoverage(p: {
  target: Coverage | number;
  bounds: CoverageBounds;
  row: CoverageRow | null;
}): { ok: true; changed: boolean; gamesCovered: number; gamesCommitted: number | null } | { ok: false; error: CoverageError } {
  if (!p.row || p.row.out) return { ok: false, error: "not-a-member" };
  if (p.row.kind !== "regular") return { ok: false, error: "not-a-regular" };
  const games = coverageGames(p.target, p.bounds);
  if (!isWholeNumber(games)) return { ok: false, error: "bad-games" };
  if (games > p.bounds.max) return { ok: false, error: "more-than-the-month" };
  if (games < p.bounds.min) return { ok: false, error: "below-games-left" };
  if (games < p.row.creditsApplied) return { ok: false, error: "below-credits" };
  const gamesCommitted = p.row.gamesCommitted !== null && p.row.gamesCommitted <= games ? p.row.gamesCommitted : null;
  return { ok: true, changed: games !== p.row.gamesCovered || gamesCommitted !== p.row.gamesCommitted, gamesCovered: games, gamesCommitted };
}

/**
 * From when a member's games count for the cancelled-week credits: his own
 * join date, or, for one who covers the whole month, no later than when
 * the month's games were counted (`countedAt`: the seed, or the list
 * opening), as for the regulars counted then. Never later than he joined.
 */
export function creditsCountFrom(m: { joinedAt: Date; gamesCovered: number }, month: { gamesScheduled: number; countedAt: Date | null | undefined }): Date {
  // Not known when the month was counted: his own join date, as before.
  if (!month.countedAt || !Number.isInteger(month.gamesScheduled)) return m.joinedAt;
  if (m.gamesCovered < wholeMonthGames(month.gamesScheduled)) return m.joinedAt;
  return month.countedAt.getTime() < m.joinedAt.getTime() ? month.countedAt : m.joinedAt;
}

// ── The tagged add's coverage words ───────────────────────────────────

/** The admin extractor's read of an add's words: the coverage, and who it names. */
export interface CoverageRead {
  coverage: Coverage | null;
  refs: string[];
}

/**
 * The coverage the add's words give THE PERSON ADDED (review of #611,
 * round 4, item 3), or null. Words that also name somebody else ("add Tom
 * for the games left, and Ian covers the whole month") give him none: one
 * coverage for two people is never guessed onto the one added. `others`:
 * the names that are not him, for the reply to say they were left alone.
 * `sameRef` is the one identity the pipeline uses for a ref (`refKey`).
 */
export function coverageForAdded(read: CoverageRead, addedNames: string[], sameRef: (a: string, b: string) => boolean): { coverage: Coverage | null; others: string[] } {
  const others = read.refs.map((r) => r.trim()).filter((r) => r && !addedNames.some((n) => n && sameRef(r, n)));
  return { coverage: others.length > 0 ? null : read.coverage, others: [...new Set(others)] };
}

// ── The question in HQ ────────────────────────────────────────────────

export const COVERAGE_ASK_PREFIX = "month-coverage:";
/** Questions logged for one reply are logged together, at once. */
const BATCH_MS = 5_000;

/** `month-coverage:<monthId>:<userId>`: who the question is about. Never
 *  anything about a payment: a coverage answer records none (round 4). */
export function coverageAskRef(monthId: string, userId: string): string {
  return `${COVERAGE_ASK_PREFIX}${monthId}:${userId}`;
}

export type CoverageAsk = { monthId: string; userId: string };

export function parseCoverageAskRef(ref: string | null | undefined): CoverageAsk | null {
  if (!ref || !ref.startsWith(COVERAGE_ASK_PREFIX)) return null;
  const [monthId, userId, ...rest] = ref.slice(COVERAGE_ASK_PREFIX.length).split(":");
  return monthId && userId && rest.length === 0 ? { monthId, userId } : null;
}

export type CoverageAnswerTarget = ({ kind: "asked" } & CoverageAsk) | { kind: "which"; userIds: string[] };

/**
 * Which of MatchTime's "whole month, or just the games left?" questions a
 * message is in the place of an answer to (review item 3). What it says is
 * the admin extractor's read; this only says which question.
 *
 *   - a WhatsApp reply: the question it quotes, however old (within the
 *     day's log). Quoting anything else: none;
 *   - otherwise the newest, by the positional tests every HQ question
 *     uses (`questionInPlaceOfAnswer`);
 *   - otherwise, with questions about two or more players asked within the
 *     window: not clear which ("which"), and MatchTime asks which player.
 *
 * ONE REPLY, SEVERAL QUESTIONS (round 4, item 4): every question asked in
 * one reply is logged with that whole reply as its words, so the ack stamps
 * the reply's id on each of them and a quote finds them by id, whatever
 * line comes first (`quotedLogRow`, by id first). Those questions are a
 * batch: a reply quoting it, or a plain answer right after it, answers it
 * only when it is about ONE player; about two or more, "which player?".
 */
export function coverageAnswerTarget(p: { quoted: QuotedMessage | null; log: HqLogRow[]; now: Date; windowMs?: number }): CoverageAnswerTarget | null {
  const isAsk = (ref: string | null) => parseCoverageAskRef(ref) !== null;
  // Only questions still open: none settled (`coverageSettledLineId`) after it.
  const settled = (r: HqLogRow, ask: { monthId: string; userId: string }) =>
    p.log.some((x) => x.fromMatchTime && x.waMessageId.startsWith(coverageSettledPrefix(ask.monthId, ask.userId)) && x.createdAt.getTime() >= r.createdAt.getTime());
  /** The questions asked in the same reply as this one. */
  const batchOf = (row: HqLogRow): CoverageAsk[] => {
    const rows = p.log.filter(
      (r) => r.fromMatchTime && isAsk(r.askRef) && r.text === row.text && Math.abs(r.createdAt.getTime() - row.createdAt.getTime()) <= BATCH_MS,
    );
    const asks = rows.map((r) => parseCoverageAskRef(r.askRef)!);
    return asks.filter((a, i) => asks.findIndex((b) => b.userId === a.userId && b.monthId === a.monthId) === i);
  };
  const target = (row: HqLogRow): CoverageAnswerTarget => {
    const all = batchOf(row);
    // Of the batch, those not settled since (one named in a message of its
    // own meanwhile is no longer asked); all settled: the batch as it was.
    const open = all.filter((a) => !settled(row, a));
    const batch = open.length > 0 ? open : all;
    return batch.length === 1 ? { kind: "asked", ...batch[0] } : { kind: "which", userIds: [...new Set(batch.map((a) => a.userId))] };
  };
  if (p.quoted && (p.quoted.text || p.quoted.fromMatchTime || p.quoted.messageId)) {
    const { row } = quotedLogRow(p.quoted, p.log);
    return row?.fromMatchTime && isAsk(row.askRef) ? target(row) : null;
  }
  const newest = questionInPlaceOfAnswer({ ...p, isAsk });
  if (newest) return target(newest);
  const windowMs = p.windowMs ?? CONFIRM_WINDOW_MS;
  const open = p.log.filter((r) => {
    const ask = r.fromMatchTime ? parseCoverageAskRef(r.askRef) : null;
    return !!ask && p.now.getTime() - r.createdAt.getTime() <= windowMs && !settled(r, ask);
  });
  const userIds = [...new Set(open.map((r) => parseCoverageAskRef(r.askRef)!.userId))];
  return userIds.length >= 2 ? { kind: "which", userIds } : null;
}

/** The id prefix of the line MatchTime logs when a regular's coverage is
 *  settled in HQ: a question about him before it is no longer open. */
export function coverageSettledPrefix(monthId: string, userId: string): string {
  return `mt:said:coverage-settled:${monthId}:${userId}:`;
}
