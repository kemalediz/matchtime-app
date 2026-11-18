/**
 * THE LAST MAN OF THE MATCH, AS FACTS (2026-11-10; the rules, 2026-11-16).
 *
 * THE INCIDENT. Sutton FC's players' group, Tue 10 Nov 19:25: "@Match Time
 * who was the last MoM and for which game it was? How many votes did he get
 * out of how many votes?" The question extractor read the `mom` table and
 * the group got the all-time "Most Man of the Match wins" top ten. This
 * module writes ONE match's Man of the Match into the records the unified
 * answer reads (`unified-answer.ts`, through `load-stats.ts` and
 * `answer-batch.ts`), the only question path since 2026-11-18 (#626).
 *
 * WHAT MAY BE TOLD (Kemal, 2026-11-16):
 *   1. A result POSTED in the group is told exactly as announced: the same
 *      winner and the same tally the group saw, read from the record stored
 *      when the post was claimed (`mom-announce-rules.ts`). Later votes and
 *      changed votes never alter it. A post from before that record existed
 *      (`scripts/backfill-mom-announcements.ts` fills it from the post's own
 *      text where it can): once its vote window has CLOSED the votes are
 *      final, so the winner only, as in rule 2; while it is still open,
 *      NOBODY is named (the votes may yet differ from what the group saw),
 *      and the answer says when it was posted and that the post has it.
 *   2. A result that is FINAL but was NEVER posted: once the vote is over,
 *      the winner only. No counts. Final: the scheduler has given up for
 *      good (older than 9 days, or the club's next fixture of the series has
 *      kicked off, `isLaterFixtureOf`).
 *   3. Anything else (the vote still open, or closed and still to be posted):
 *      nothing about it, not even who is ahead. Its status is said in true
 *      words: never "open" when it is closed, never "it will be posted" when
 *      the post may never come, and never a time.
 *   4. An organisers' pick (`mom-chooser.ts`) has no vote and is final when
 *      made, but rule 3 holds for it too (round 4 of the review): a pick the
 *      scheduler WILL post is told nothing before its post, only that it will
 *      be posted; with no post coming it is told. In an organisers' club THE
 *      CORRECTION WINS (Kemal,
 *      2026-11-16, PR #608): an organiser who restates or corrects a pick
 *      after it was posted is told, still as a pick. With no pick row left,
 *      the pick as announced. Never posted: the winner only. Votes left from
 *      before a club switched to picking: the record if there is one, else
 *      rule 2. A voting club keeps everything as announced.
 *
 * THE WINS TABLES (review of #608) credit a match by the same decision
 * (`decideMom`, `momCredit`): the announced winner(s) when posted, the final
 * winner when final, nobody while open or still to be posted. A historical
 * (back-filled) match is decided by its final winner.
 *
 * WHO voted for whom is never read: the loader groups by the player voted
 * for, and no voter id reaches this module.
 *
 * PURE. No Prisma, no clock: `load-stats.ts` reads, this decides and writes.
 */
import { BADGE_FINAL_AFTER_DAYS } from "../badge-announcements";
import { MOM_BACKSTOP_AFTER_DAYS, momPickWillBePosted, type MomAnnouncedResult } from "../mom-announce-rules";
import { dayLabel } from "../i18n/dates";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One player's votes in one match. */
export interface MomVoteCount {
  userId: string;
  name: string;
  votes: number;
}

/** One match with Man of the Match votes or a posted result, as `load-stats.ts` reads it. */
export interface MomMatchRecord {
  date: Date;
  /** The match's own team names (`resolveTeamLabels`), red first. */
  teamLabels: [string, string];
  redScore: number | null;
  yellowScore: number | null;
  /** The votes each player has NOW; one vote per voter. Never who voted. */
  tally: MomVoteCount[];
  /** Its Man of the Match result has been posted (`<matchId>:mom-announcement`). */
  announced: boolean;
  /** When that post was claimed; null when never posted. */
  postedAt: Date | null;
  /** What that post said, stored when it was claimed. Null for a post from
   *  before the record existed, or when the record could not be read. */
  announcedResult: MomAnnouncedResult | null;
  /** When the vote closes: kickoff plus the activity's `ratingWindowHours`. */
  voteClosesAt: Date;
  /** Kickoff of the club's next fixture of this series, played or to come
   *  (`nextFixtureKickoff`); null when there is none. */
  nextFixtureAt: Date | null;
  /** A synthetic match anchoring a back-filled award (`Match.isHistorical`):
   *  decided, told by its final winner only. */
  isHistorical: boolean;
  /** The scheduler can post its result at all: the match is COMPLETED, its
   *  post-match flow is on (`Match.postMatchEndFlow`) and the club has Man
   *  of the Match votes switched on (`momVoting`, `due-key-feature.ts`).
   *  Without all three no post is ever promised. */
  announceable: boolean;
}

/** A Man of the Match winner, by name. */
export interface MomWinner {
  userId: string;
  name: string;
}

/** A Man of the Match that can be told. */
export interface LastMom {
  date: Date;
  teamLabels: [string, string];
  score: { red: number; yellow: number } | null;
  /** The winner, or every winner of a tie (a tie is never broken). */
  winners: MomWinner[];
  /** "announced": exactly as the group was shown it. "winner-only": the
   *  name(s) and nothing else (rule 2, or an unrecorded post once its vote
   *  closed). "posted-unrecorded": posted before the result was stored,
   *  vote still open, so NO name: the post has it, `winners` is empty. */
  told: "announced" | "winner-only" | "posted-unrecorded";
  /** When the result was posted; null when it never was. */
  postedAt: Date | null;
  /** The organisers picked: one name, no vote. */
  pickedByOrganisers: boolean;
  /** An announced vote only: every player who got a vote, as announced,
   *  most first, ties by name. Empty otherwise. */
  tally: MomVoteCount[];
  /** An announced vote only: the winner's votes and the votes cast, as
   *  announced. Null otherwise. */
  votes: { top: number; total: number } | null;
}

/**
 * A match whose Man of the Match cannot be told yet.
 *   voting     the vote is open;
 *   closed     the vote is over and the result is still to be posted;
 *   undecided  the vote is open but the scheduler has given up posting it
 *              (its next fixture has kicked off): once the vote closes it is
 *              told by the winner only.
 *   picked     an organisers' pick the scheduler will post (round 4 of the
 *              review: picks wait hours for their post): nothing about it is
 *              told before the post.
 */
export type PendingMomState = "voting" | "closed" | "undecided" | "picked";

export interface PendingMom {
  date: Date;
  state: PendingMomState;
  /** Its result will be posted in the group, as far as can be known now:
   *  a backstop afternoon is left before the 9-day stop and before the next
   *  fixture of the series kicks off. Never true for "undecided". */
  toBePosted: boolean;
}

export interface LastMomFacts {
  /** The most recent Man of the Match that can be told. */
  last: LastMom | null;
  /** Every match read whose result cannot be told yet, newest first, by
   *  date only. */
  pending: PendingMom[];
  /** Every Man of the Match that can be told in the records read, newest
   *  first (2026-11-11: "the last 3 weeks' MoMs"). `last` is the first. */
  recent: LastMom[];
}

const byVotes = (a: MomVoteCount, b: MomVoteCount) => b.votes - a.votes || a.name.localeCompare(b.name);

function topOf(tally: MomVoteCount[]): MomVoteCount[] {
  const top = tally[0].votes;
  return tally.filter((t) => t.votes === top).sort((a, b) => a.name.localeCompare(b.name));
}

const winnersOf = (tally: MomVoteCount[]): MomWinner[] => topOf(tally).map(({ userId, name }) => ({ userId, name }));

/** The told part of a decision (the match's own fields are added later). */
type MomTold = Omit<LastMom, "date" | "teamLabels" | "score" | "postedAt">;

/**
 * What may be said about one match, and who it credits in the Man of the
 * Match WINS tables (review of #608). ONE function, read by this answer and
 * by every wins count (`match-history.ts`, `player-stats.ts`, through
 * `mom-records.ts`), so a table can never credit a match the answer may not
 * tell, nor credit someone other than the winner the group was shown.
 */
export type MomDecision =
  | { kind: "told"; mom: MomTold; credit: MomWinner[] }
  | { kind: "pending"; state: PendingMomState; toBePosted: boolean }
  | { kind: "none" };

/** PURE. See the header and `MomDecision`. */
export function decideMom(m: MomMatchRecord, now: Date, organisersPick: boolean): MomDecision {
  const live = m.tally.filter((t) => t.votes > 0).sort(byVotes);
  const winnerOnly = (picked: boolean): MomDecision => {
    if (live.length === 0) return { kind: "none" };
    const winners = winnersOf(live);
    return { kind: "told", mom: { winners, told: "winner-only", pickedByOrganisers: picked, tally: [], votes: null }, credit: winners };
  };
  // One player in the rows: a pick (two rows for the same player are still
  // one pick, as the scheduler posts them).
  const onePick = live.length === 1;
  const t = now.getTime();
  const open = t <= m.voteClosesAt.getTime();

  // A back-filled award: decided, by its final winner.
  if (m.isHistorical) return winnerOnly(false);

  // Rule 1: posted.
  if (m.announced) {
    const r = m.announcedResult;
    if (r?.kind === "pick") {
      // An organisers' club: the correction wins (Kemal, 2026-11-16). The
      // organiser's latest pick, the one row `setMatchMom` leaves, is told.
      const winner = organisersPick && onePick ? { userId: live[0].userId, name: live[0].name } : r.winner;
      return { kind: "told", mom: { winners: [winner], told: "announced", pickedByOrganisers: true, tally: [], votes: null }, credit: [winner] };
    }
    if (r?.kind === "vote") {
      // The winners the post announced, as stored: never re-derived from the
      // tally (a player merge may have summed two records' counts).
      const tally = [...r.tally].sort(byVotes);
      const winners = r.winners
        .map((id) => ({ userId: id, name: tally.find((t) => t.userId === id)?.name ?? "?" }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (r.winnerMerged) {
        // A merged player was a winner, so his count no longer matches the
        // post: the winner(s), no counts.
        return { kind: "told", mom: { winners, told: "announced", pickedByOrganisers: false, tally: [], votes: null }, credit: winners };
      }
      // A merge sums counts, never the total; with no winner merged the
      // winner's count is as posted too. Only the per-player list goes.
      const total = tally.reduce((s, x) => s + x.votes, 0);
      const top = tally.find((t) => t.userId === r.winners[0])?.votes ?? tally[0].votes;
      return { kind: "told", mom: { winners, told: "announced", pickedByOrganisers: false, tally: r.merged ? [] : tally, votes: { top, total } }, credit: winners };
    }
    // Posted before the result was stored. An organisers' club's single
    // pick row IS the pick (the correction wins). Once the vote window has
    // CLOSED the votes are final: the winner only, credited, as for a final
    // result never posted (Kemal, 2026-11-16: only 5 of production's 34
    // posts kept their text). While it is open the current votes may still
    // differ from what the group saw: name nobody, credit nobody.
    if (organisersPick && onePick) return winnerOnly(true);
    if (organisersPick || !open) return winnerOnly(false);
    return {
      kind: "told",
      mom: { winners: [], told: "posted-unrecorded", pickedByOrganisers: false, tally: [], votes: null },
      credit: [],
    };
  }

  const date = m.date.getTime();
  const stop = date + BADGE_FINAL_AFTER_DAYS * DAY_MS;

  // Rule 4: an organisers' club. A pick is final when made, but rule 3 holds
  // for it too: a pick the scheduler WILL post is not told before its post.
  // Exactly the scheduler's rule (`momPickWillBePosted`, round 5 of the
  // review): ONE player in the rows (two rows for him are still one pick),
  // the club's result postable at all, and no stop by its next 09:00 to
  // 21:00 London tick. With no post coming it is told. Votes for several
  // players left from before the switch are over (the vote paths refuse new
  // ones), and the scheduler never posts them as a pick: rule 2.
  if (organisersPick) {
    const pickers = live.length;
    if (momPickWillBePosted({ kickoff: m.date, nextFixtureAt: m.nextFixtureAt, announceable: m.announceable, pickers, now })) {
      return { kind: "pending", state: "picked", toBePosted: true };
    }
    return winnerOnly(pickers === 1);
  }

  if (live.length === 0) return { kind: "none" };
  const givenUp = t > stop || (m.nextFixtureAt !== null && m.nextFixtureAt.getTime() <= t);

  // Rule 2: final, never posted, the vote over.
  if (givenUp && !open) return winnerOnly(false);
  // Rule 3.
  if (givenUp) return { kind: "pending", state: "undecided", toBePosted: false };
  // A post is promised only when the scheduler can post it at all, and a
  // whole day is left for the backstop's afternoon window, before the 9-day
  // stop and before the next fixture.
  const by = Math.max(t, date + MOM_BACKSTOP_AFTER_DAYS * DAY_MS) + DAY_MS;
  const toBePosted = m.announceable && by <= stop && !(m.nextFixtureAt !== null && m.nextFixtureAt.getTime() <= by);
  return { kind: "pending", state: open ? "voting" : "closed", toBePosted };
}

/** PURE. Who this match credits in a Man of the Match wins table: the
 *  winner(s) it may be told by (the announced ones when posted), the final
 *  winner of a posted match with no stored record once its vote is over,
 *  and nobody while it is open or still to be posted. */
export function momCredit(m: MomMatchRecord, now: Date, organisersPick: boolean): MomWinner[] {
  const d = decideMom(m, now, organisersPick);
  return d.kind === "told" ? d.credit : [];
}

/** PURE. See the header. `records` in any order. */
export function lastMomFacts(records: MomMatchRecord[], opts: { now: Date; organisersPick: boolean }): LastMomFacts {
  const recent: LastMom[] = [];
  const pending: PendingMom[] = [];
  for (const m of [...records].sort((a, b) => b.date.getTime() - a.date.getTime())) {
    const v = decideMom(m, opts.now, opts.organisersPick);
    if (v.kind === "pending") pending.push({ date: m.date, state: v.state, toBePosted: v.toBePosted });
    if (v.kind !== "told") continue;
    recent.push({
      date: m.date,
      teamLabels: m.teamLabels,
      score: m.redScore !== null && m.yellowScore !== null ? { red: m.redScore, yellow: m.yellowScore } : null,
      postedAt: m.postedAt,
      ...v.mom,
    });
  }
  return { last: recent[0] ?? null, pending, recent };
}

const both = (names: string[]) =>
  names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** PURE. One match still to be told, by date only, in true words. */
function pendingLine(p: PendingMom): string {
  if (p.state === "picked") {
    return `- The organisers have picked the Man of the Match of the match on ${dayLabel("en", p.date)}. The pick will be posted in the group; until then it cannot be told.`;
  }
  const of = `Voting for Man of the Match of the match on ${dayLabel("en", p.date)}`;
  if (p.state === "closed") {
    return p.toBePosted
      ? `- ${of} has closed. Its result will be posted in the group; until then nothing about it can be told.`
      : `- ${of} has closed, but its result has not been posted, so nothing about it can be told for now.`;
  }
  return p.toBePosted
    ? `- ${of} is still open. Its result will be posted in the group; until then nothing about it can be told, not even who is ahead.`
    : `- ${of} is still open, so nothing about its result can be told yet, not even who is ahead.`;
}

/** PURE. The Man of the Match line(s) for one told match. */
function winnerLines(m: LastMom): string[] {
  const names = m.winners.map((w) => w.name);
  if (m.told === "posted-unrecorded") {
    const on = m.postedAt ? ` on ${dayLabel("en", m.postedAt)}` : "";
    return [`- Man of the Match: the result was posted in the group${on}, and that post has it. MatchTime holds no copy of it, so it cannot give the winner or the votes here.`];
  }
  if (m.pickedByOrganisers) {
    return [`- Man of the Match: ${names[0]}, picked by the organisers. There was no vote, so there are no votes to tell.`];
  }
  if (!m.votes) {
    return [
      names.length > 1
        ? `- Man of the Match: shared between ${both(names)}. Only the winners are told for this match: there are no vote counts to give.`
        : `- Man of the Match: ${names[0]}. Only the winner is told for this match: there are no vote counts to give.`,
    ];
  }
  return [
    names.length > 1
      ? `- Man of the Match: shared between ${both(names)}, with ${m.votes.top} votes each of the ${m.votes.total} votes cast, as announced in the group (one vote for each player who voted)`
      : `- Man of the Match: ${names[0]}, with ${m.votes.top} of the ${m.votes.total} votes cast, as announced in the group (one vote for each player who voted)`,
    ...(m.tally.length ? [`- Votes each player got, as announced: ${m.tally.map((t) => `${t.name} ${t.votes}`).join(", ")}`] : []),
  ];
}

/**
 * PURE. The block the grounded answers read, in English like the rest of
 * their context (the answer is written in the group's language). Nothing
 * when the facts were not loaded.
 */
export function lastMomContextLines(f: LastMomFacts | null | undefined): string[] {
  if (!f) return [];
  const pending = (f.pending ?? []).map(pendingLine);
  const m = f.last;
  if (!m) return [`LAST MAN OF THE MATCH: none can be told yet.`, ...pending];
  const [red, yellow] = m.teamLabels;
  const result = m.score
    ? `${red} ${m.score.red}, ${yellow} ${m.score.yellow} (${
        m.score.red === m.score.yellow ? "a draw" : `${m.score.red > m.score.yellow ? red : yellow} won`
      })`
    : `${red} against ${yellow}, no score recorded`;
  const L = [
    `LAST MAN OF THE MATCH (the most recent match whose Man of the Match can be told):`,
    `- Match: ${dayLabel("en", m.date)}, ${result}`,
    ...winnerLines(m),
  ];
  // The live check, 2026-11-10: "who won MoM last week?" with the last one
  // three weeks back drew NO_ANSWER 2 times in 4. It IS the answer, with
  // its date, because no later match has one to give.
  L.push(
    pending.length
      ? `- It is the latest Man of the Match anyone can be told. Asked for the last one, or for a day or week since, give this one with its date.`
      : `- No match after it has a Man of the Match, so it is the latest one. Asked for the last one, or for a day or week since, give this one with its date.`,
  );
  return [...L, ...pending];
}
