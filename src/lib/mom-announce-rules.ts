/**
 * WHAT THE GROUP WAS TOLD ABOUT MAN OF THE MATCH (Kemal, 2026-11-16). PURE.
 *
 * "Who was the last Man of the Match?" must be answered with exactly what
 * the group was shown: the same winner and the same tally. Re-counting the
 * votes later cannot give that. Votes are still accepted after an early post
 * or the day-5 backstop (until kickoff plus `Activity.ratingWindowHours`), a
 * changed vote keeps its old `createdAt`, and `setMatchMom` deletes and
 * recreates an organiser's pick row on every call, so a pick restated after
 * the post looks newer than it.
 *
 * So the result is STORED at the moment the announcement is claimed
 * (/api/whatsapp/due-posts), in "MoMAnnouncement", one row per match. The
 * scheduler puts it on the instruction (`momResult`, server-side only, never
 * sent to the Pi) from the same tally the post's words were built from, and
 * the claim writes it. The answer (`pipeline/last-mom.ts`) reads that row and
 * never re-counts a posted result.
 *
 * Also here, because the scheduler's stop and the answer must agree on it:
 * the club's NEXT FIXTURE for a match (`isLaterFixtureOf`). Once it has
 * kicked off, the scheduler gives up announcing the match for good.
 */
import { isSameRecurringFixture, type RecurringFixtureKey } from "./match-slot";

/**
 * Days after kickoff at which the scheduler's MoM backstop becomes due.
 * The same number as `MOM_BACKSTOP_DAYS` in bot-scheduler.ts, which imports
 * Prisma; `__tests__/mom-announce-rules.test.ts` pins the two together.
 */
export const MOM_BACKSTOP_AFTER_DAYS = 5;

/** One player's votes as the announcement showed them. */
export interface MomAnnouncedVote {
  userId: string;
  name: string;
  votes: number;
}

/**
 * The stored record, version 1. A vote: every player who got a vote, as the
 * post listed them, most first, and the WINNERS the post announced, by user
 * id (round 4 of the review: the winners are stored, never re-derived from
 * the tally, because a player merge may sum two records' counts). `merged`
 * marks a result whose counts were combined by a merge: its per-player list
 * no longer matches what was posted. `winnerMerged` marks one where a merged
 * player was a winner, so the winner's own count changed too. A pick: the one name the post gave. Names are kept as
 * shown, so a later rename does not change what was announced. Who voted
 * for whom is never stored.
 */
export type MomAnnouncedResult =
  | { v: 1; kind: "vote"; tally: MomAnnouncedVote[]; winners: string[]; merged?: true; winnerMerged?: true }
  | { v: 1; kind: "pick"; winner: { userId: string; name: string } };

/** PURE. The winners a post built from this tally announces: the top count,
 *  every player tied on it (a tie is never broken), in tally order. */
export function announcedWinnersOf(tally: readonly MomAnnouncedVote[]): string[] {
  const top = Math.max(...tally.map((t) => t.votes));
  return tally.filter((t) => t.votes === top).map((t) => t.userId);
}

const isName = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;
const isId = (x: unknown): x is string => typeof x === "string" && x.length > 0;

/** PURE. The stored JSON, read back defensively: anything malformed is no
 *  record at all (the answer then names nobody for a posted result), never
 *  a guess. */
export function readMomAnnouncedResult(json: unknown): MomAnnouncedResult | null {
  if (!json || typeof json !== "object") return null;
  const r = json as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (r.kind === "pick") {
    const w = r.winner as Record<string, unknown> | undefined;
    if (!w || !isId(w.userId) || !isName(w.name)) return null;
    return { v: 1, kind: "pick", winner: { userId: w.userId, name: w.name } };
  }
  if (r.kind === "vote") {
    if (!Array.isArray(r.tally) || r.tally.length === 0) return null;
    const tally: MomAnnouncedVote[] = [];
    for (const e of r.tally as Array<Record<string, unknown>>) {
      if (!e || !isId(e.userId) || !isName(e.name) || typeof e.votes !== "number" || !Number.isInteger(e.votes) || e.votes < 1) return null;
      tally.push({ userId: e.userId, name: e.name, votes: e.votes });
    }
    // The stored winners as stored; a record written before they were
    // stored was never merged, so its tally still says what was announced.
    let winners: string[];
    if (r.winners === undefined) winners = announcedWinnersOf(tally);
    else {
      if (!Array.isArray(r.winners) || r.winners.length === 0 || !r.winners.every(isId)) return null;
      winners = r.winners as string[];
      if (!winners.every((id) => tally.some((t) => t.userId === id))) return null;
    }
    return {
      v: 1,
      kind: "vote",
      tally,
      winners,
      ...(r.merged === true ? { merged: true as const } : {}),
      ...(r.winnerMerged === true ? { winnerMerged: true as const } : {}),
    };
  }
  return null;
}

/** PURE. Is this the announcement's own claim row (`<matchId>:mom-announcement`)?
 *  The outbound text log's rows (`txtlog:<org>:<hash>:<key>`, dispatch-claim.ts)
 *  end the same way and are not. */
export function isMomAnnouncementClaimKey(key: string): boolean {
  return /^[^:]+:mom-announcement$/.test(key);
}

/** PURE. The record a due instruction carries (`momResult`), if any. */
export function momAnnouncedResultOf(instr: object): MomAnnouncedResult | null {
  return "momResult" in instr ? readMomAnnouncedResult((instr as { momResult?: unknown }).momResult) : null;
}

/** A match as the next-fixture rule needs it. */
export interface FixtureMatchRef {
  id: string;
  date: Date;
  status: string;
  activityId: string;
  activity: RecurringFixtureKey;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * PURE. Is `s` a later fixture of the same series as `m`? The scheduler's
 * rule for its "next fixture" stop (section 6e): not cancelled, the same
 * activity or the same recurring fixture (a format-switched successor still
 * counts), and at least a day later (a co-timed ghost match left by a format
 * switch must never count). A club's other weekly fixture is not one.
 */
export function isLaterFixtureOf(s: FixtureMatchRef, m: FixtureMatchRef): boolean {
  return (
    s.id !== m.id &&
    s.status !== "CANCELLED" &&
    (s.activityId === m.activityId || isSameRecurringFixture(s.activity, m.activity)) &&
    s.date.getTime() >= m.date.getTime() + DAY_MS
  );
}

/** PURE. The kickoff of `m`'s next fixture, played or still to come; null
 *  when there is none (a cancelled one is none). */
export function nextFixtureKickoff(m: FixtureMatchRef, matches: readonly FixtureMatchRef[]): Date | null {
  let best: Date | null = null;
  for (const s of matches) {
    if (isLaterFixtureOf(s, m) && (!best || s.date.getTime() < best.getTime())) best = s.date;
  }
  return best;
}

// ── The scheduler's own rule for whether a result can still be posted ──
//
// Round 5 of the review: the answer guessed ("a whole day left") whether an
// organisers' pick would be posted, and so told a pick hours before its post
// when the next fixture or the 9-day stop was under a day away. These are
// the scheduler's own conditions (bot-scheduler.ts section 6e reads them),
// so the answer, the tables and the web hold a pick exactly as long as the
// scheduler will still post it.

/** Days after kickoff past which no result is posted (= the scheduler's
 *  `MOM_ANNOUNCE_MAX_AGE_DAYS`, pinned by `mom-announce-rules.test.ts`). */
export const MOM_ANNOUNCE_STOP_DAYS = 9;
/** London hours MatchTime may post a result in: 09:00 up to 20:59. */
export const MOM_CIVIL_FROM_HOUR = 9;
export const MOM_CIVIL_TO_HOUR = 21;

/** Hour of the day 0 to 23 in Europe/London, DST-safe. */
export function londonHourOf(at: Date): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false })
    .formatToParts(at)
    .find((p) => p.type === "hour")?.value;
  return parseInt(h ?? "0", 10) % 24;
}

/** PURE. The scheduler's stops at `at`: the result is past the 9-day stop,
 *  or the match's next fixture has kicked off. After either it never posts. */
export function momAnnouncementStopped(kickoff: Date, nextFixtureAt: Date | null, at: Date): boolean {
  return at.getTime() - kickoff.getTime() > MOM_ANNOUNCE_STOP_DAYS * DAY_MS || (nextFixtureAt !== null && nextFixtureAt.getTime() <= at.getTime());
}

/** PURE. Inside the hours MatchTime may post a result in. */
export function isMomCivilHour(at: Date): boolean {
  const h = londonHourOf(at);
  return h >= MOM_CIVIL_FROM_HOUR && h < MOM_CIVIL_TO_HOUR;
}

/** PURE. The scheduler's next chance to post: `at` itself inside the civil
 *  hours (it polls every ~30 seconds), else the next 09:00 London. */
export function nextMomCivilTick(at: Date): Date {
  if (isMomCivilHour(at)) return at;
  // London is a whole number of hours off UTC, so step to whole UTC hours.
  let t = new Date(Math.floor(at.getTime() / (60 * 60 * 1000)) * 60 * 60 * 1000 + 60 * 60 * 1000);
  for (let i = 0; i < 26 && !isMomCivilHour(t); i++) t = new Date(t.getTime() + 60 * 60 * 1000);
  return t;
}

/**
 * PURE. Will the scheduler post this organisers' pick? Exactly its rule: it
 * can post the club's result at all (`announceable`), the match's rows name
 * ONE player (`pickers`: two rows for the same player are still one pick),
 * and at its next civil-hours tick the result is not stopped.
 */
export function momPickWillBePosted(args: { kickoff: Date; nextFixtureAt: Date | null; announceable: boolean; pickers: number; now: Date }): boolean {
  if (!args.announceable || args.pickers !== 1) return false;
  return !momAnnouncementStopped(args.kickoff, args.nextFixtureAt, nextMomCivilTick(args.now));
}
