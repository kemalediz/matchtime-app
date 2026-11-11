/**
 * THE LAST MAN OF THE MATCH, AS FACTS (2026-11-10).
 *
 * THE INCIDENT. Sutton FC's players' group, Tue 10 Nov 19:25: "@Match Time
 * who was the last MoM and for which game it was? How many votes did he get
 * out of how many votes?" The question extractor read the `mom` table and
 * the group got the all-time "Most Man of the Match wins" top ten. The
 * question was about ONE match, and nothing MatchTime's answers were given
 * said who won that match's vote, or by how much.
 *
 * NO NEW TOPIC OR TABLE (Kemal). The extractor now reads a question about
 * one match's Man of the Match as `stats`, table `other`, whose grounded
 * generic answer (`stats-generic.ts`) answers from the club's stats context.
 * This module writes that match into the context, so ANY question about it
 * ("how many votes did Mojib get?", "who came second?") has the facts, and
 * the open answer (`open-answer.ts`), which shares the context, has them too.
 *
 * WHICH MATCH. The most recent match whose Man of the Match is DECIDED: its
 * result has been posted (`<matchId>:mom-announcement`), or it is too old
 * for one ever to be posted. The same rule that decides when a vote counts
 * toward the badges (`badge-announcements.ts`, `badgeMatchFinalised`). A
 * vote still open is never told: the group hears its result from the
 * announcement, so a newer match still voting is named by its date only,
 * with no name and no count from it.
 *
 * WHAT IS SAID. The match (day, the two teams, the score and who won it),
 * the winner, or every winner of a tie with "shared" (the announcement's own
 * rule: a tie is never broken), the winner's votes out of the votes cast,
 * and every player who got a vote with their count. The announcement
 * already posts that breakdown in the group, so none of it is new to the
 * group. WHO voted for whom is never read: the loader groups by the player
 * voted for, and no voter id reaches this module.
 *
 * AN ORGANISERS' PICK (`mom-chooser.ts`). A pick is stored as exactly one
 * MoMVote (`mom-pick.ts`), so a count would read "1 of 1 votes". For a club
 * whose organisers pick, a match with one vote row is said as picked by the
 * organisers, with no votes. A match voted on before the club switched
 * (several rows) is still told as the vote it was.
 *
 * PURE. No Prisma, no clock: `load-stats.ts` reads, this decides and writes.
 */
import { BADGE_FINAL_AFTER_DAYS } from "../badge-announcements";
import { dayLabel } from "../i18n/dates";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One player's votes in one match. */
export interface MomVoteCount {
  userId: string;
  name: string;
  votes: number;
}

/** One match with Man of the Match votes, as `load-stats.ts` reads it. */
export interface MomMatchRecord {
  date: Date;
  /** The match's own team names (`resolveTeamLabels`), red first. */
  teamLabels: [string, string];
  redScore: number | null;
  yellowScore: number | null;
  /** Votes each player received; one vote per voter. Never who voted. */
  tally: MomVoteCount[];
  /** Its Man of the Match result has been posted in the group. */
  announced: boolean;
}

/** The last decided Man of the Match. */
export interface LastMom {
  date: Date;
  teamLabels: [string, string];
  score: { red: number; yellow: number } | null;
  /** The player with the most votes, or every player tied on the most. */
  winners: MomVoteCount[];
  /** Every player who got a vote, most first, ties by name. */
  tally: MomVoteCount[];
  totalVotes: number;
  /** The organisers picked: one name, no vote. */
  pickedByOrganisers: boolean;
}

export interface LastMomFacts {
  last: LastMom | null;
  /** A newer match whose vote is still open, by date only. */
  openVoteDate: Date | null;
  /** Every DECIDED Man of the Match in the records read, newest first
   *  (2026-11-11): "the last 3 weeks' MoMs" needs each match's winners, not
   *  only the last. `last` is the first of these. A vote still open is never
   *  in it. Absent on facts made before it existed: read as empty. */
  recent?: LastMom[];
}

/** PURE. Decided: posted, or past the age at which it ever could be. */
function decided(m: MomMatchRecord, now: Date): boolean {
  return m.announced || now.getTime() - m.date.getTime() > BADGE_FINAL_AFTER_DAYS * DAY_MS;
}

/** PURE. See the header. `records` in any order. */
export function lastMomFacts(records: MomMatchRecord[], opts: { now: Date; organisersPick: boolean }): LastMomFacts & { recent: LastMom[] } {
  const withVotes = records
    .filter((r) => r.tally.some((t) => t.votes > 0))
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  let openVoteDate: Date | null = null;
  const recent: LastMom[] = [];
  for (const m of withVotes) {
    if (!decided(m, opts.now)) {
      // Only a vote NEWER than the last decided one is "still open"; an
      // older undecided one cannot exist (it would be past the age).
      if (recent.length === 0) openVoteDate ??= m.date;
      continue;
    }
    const tally = m.tally
      .filter((t) => t.votes > 0)
      .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
    const top = tally[0].votes;
    recent.push({
      date: m.date,
      teamLabels: m.teamLabels,
      score: m.redScore !== null && m.yellowScore !== null ? { red: m.redScore, yellow: m.yellowScore } : null,
      winners: tally.filter((t) => t.votes === top),
      tally,
      totalVotes: tally.reduce((s, t) => s + t.votes, 0),
      pickedByOrganisers: opts.organisersPick && tally.length === 1 && tally[0].votes === 1,
    });
  }
  return { last: recent[0] ?? null, openVoteDate, recent };
}

const both = (names: string[]) =>
  names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * PURE. The block the grounded answers read, in English like the rest of
 * their context (the answer is written in the group's language). Nothing
 * when the facts were not loaded, so a snapshot without them reads exactly
 * as before.
 */
export function lastMomContextLines(f: LastMomFacts | null | undefined): string[] {
  if (!f) return [];
  const open = f.openVoteDate
    ? [`- The vote for the match on ${dayLabel("en", f.openVoteDate)} is still open. Its result is announced in the group when the vote closes, so nobody can be told it before then.`]
    : [];
  const m = f.last;
  if (!m) return [`LAST MAN OF THE MATCH: none decided yet.`, ...open];
  const [red, yellow] = m.teamLabels;
  const result = m.score
    ? `${red} ${m.score.red}, ${yellow} ${m.score.yellow} (${
        m.score.red === m.score.yellow ? "a draw" : `${m.score.red > m.score.yellow ? red : yellow} won`
      })`
    : `${red} against ${yellow}, no score recorded`;
  const L = [
    `LAST MAN OF THE MATCH (the most recent match whose Man of the Match is decided):`,
    `- Match: ${dayLabel("en", m.date)}, ${result}`,
  ];
  if (m.pickedByOrganisers) {
    L.push(`- Man of the Match: ${m.winners[0].name}, picked by the organisers. There was no vote, so there are no votes to tell.`);
  } else {
    const names = m.winners.map((w) => w.name);
    L.push(
      names.length > 1
        ? `- Man of the Match: shared between ${both(names)}, with ${m.winners[0].votes} votes each of the ${m.totalVotes} votes cast (one vote for each player who voted)`
        : `- Man of the Match: ${names[0]}, with ${m.winners[0].votes} of the ${m.totalVotes} votes cast (one vote for each player who voted)`,
    );
    L.push(`- Votes each player got: ${m.tally.map((t) => `${t.name} ${t.votes}`).join(", ")}`);
  }
  // The live check, 2026-11-10: "who won MoM last week?" with the last one
  // three weeks back drew NO_ANSWER 2 times in 4. It IS the answer, with
  // its date, because no later match has one to give.
  L.push(
    f.openVoteDate
      ? `- It is the latest Man of the Match anyone can be told. Asked for the last one, or for a day or week since, give this one with its date.`
      : `- No match after it has a Man of the Match, so it is the latest one. Asked for the last one, or for a day or week since, give this one with its date.`,
  );
  return [...L, ...open];
}
