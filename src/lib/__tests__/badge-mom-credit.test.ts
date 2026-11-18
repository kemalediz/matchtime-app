/**
 * BADGES CREDIT MAN OF THE MATCH BY THE SHARED DECISION (review of #608,
 * round 2). The badge replay (`toReplayMatches`) used to count the CURRENT
 * vote winner of every finalised match, so the group's badge post and the
 * player's own page (which credits by `decideMom`) could disagree. It now
 * takes each match's credited winners (`momCredit`, carried as `momCredit`
 * on the raw match by `loadRawBadgeMatches`).
 *
 * The proof that this changes nothing already earned: a production-shaped
 * club (weekly games, posted results whose stored record says what the
 * votes say, older posts with no record, one vote still open) replays to
 * the SAME badges match by match, and with everything already announced no
 * badge is announced again or newly. Only a result whose votes changed
 * after its post differs, and then the badge follows the announced winner.
 */
import { describe, expect, it } from "vitest";
import { pickBadgeAwards, replayBadges, toReplayMatches, type RawBadgeMatch } from "../badge-announcements";
import { momCredit, type MomMatchRecord } from "../pipeline/last-mom";
import type { MomAnnouncedResult } from "../mom-announce-rules";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-16T12:00:00Z");
const PLAYERS = Array.from({ length: 10 }, (_, i) => `u-${i + 1}`);

interface Fixture {
  raw: RawBadgeMatch & { date: Date };
  record: MomMatchRecord;
  posted: boolean;
}

/** 16 weekly games back from NOW; the winners rotate so that two players
 *  reach three wins (MoM Machine) and several reach one (first MoM). */
function club(opts: { changedAfterPost?: boolean } = {}): Fixture[] {
  const winnersOf = [1, 2, 1, 3, 4, 1, 5, 2, 6, 2, 7, 8, 3, 9, 4, 9];
  return winnersOf.map((w, i) => {
    const date = new Date(NOW.getTime() - (winnersOf.length - i) * 7 * DAY + DAY);
    const id = `m-${String(i + 1).padStart(2, "0")}`;
    const winner = `u-${w}`;
    const runnerUp = `u-${((w % 10) + 1)}`;
    const votes = [...Array(4).fill(winner), ...Array(2).fill(runnerUp)].map((playerId) => ({ playerId }));
    const newest = i === winnersOf.length - 1; // the vote still open
    const legacy = i < 10; // posted before results were stored
    const posted = !newest;
    let tally = [
      { userId: winner, name: winner, votes: 4 },
      { userId: runnerUp, name: runnerUp, votes: 2 },
    ];
    let liveVotes = votes;
    const stored: MomAnnouncedResult | null = posted && !legacy ? { v: 1, kind: "vote", tally, winners: [winner] } : null;
    // Votes moved after the post on the last posted match (opt-in).
    if (opts.changedAfterPost && i === winnersOf.length - 2) {
      liveVotes = [...Array(5).fill(runnerUp), ...Array(1).fill(winner)].map((playerId) => ({ playerId }));
      tally = [
        { userId: runnerUp, name: runnerUp, votes: 5 },
        { userId: winner, name: winner, votes: 1 },
      ];
    }
    const record: MomMatchRecord = {
      date,
      teamLabels: ["Red", "Yellow"],
      redScore: 3,
      yellowScore: 2,
      tally,
      announced: posted,
      postedAt: posted ? new Date(date.getTime() + 2 * DAY) : null,
      announcedResult: stored,
      voteClosesAt: new Date(date.getTime() + 120 * 60 * 60 * 1000),
      nextFixtureAt: newest ? null : new Date(date.getTime() + 7 * DAY),
      isHistorical: false,
      announceable: true,
    };
    const raw = {
      id,
      date,
      confirmed: PLAYERS,
      teamUserIds: PLAYERS,
      ratings: PLAYERS.map((p, k) => ({ playerId: p, score: 6 + (k % 4) })),
      momVotes: liveVotes,
    };
    return { raw, record, posted };
  });
}

/** The badge rule's "final": posted, or past 9 days. */
const isFinalAt = (f: Fixture[]) => (m: { id: string; date: Date }) =>
  f.find((x) => x.raw.id === m.id)!.posted || NOW.getTime() - m.date.getTime() > 9 * DAY;

const oldPath = (f: Fixture[]) => toReplayMatches(f.map((x) => x.raw), isFinalAt(f));
const newPath = (f: Fixture[]) =>
  toReplayMatches(
    f.map((x) => ({ ...x.raw, momCredit: momCredit(x.record, NOW, false).map((w) => w.userId) })),
    isFinalAt(f),
  );
const asObj = (r: ReturnType<typeof replayBadges>) => JSON.stringify([...r.held].map(([u, m]) => [u, [...m]]));

describe("badges credit Man of the Match by the shared decision", () => {
  it("today's data shape replays to the SAME badges at every match", () => {
    const f = club();
    for (let upTo = 1; upTo <= f.length; upTo++) {
      expect(asObj(replayBadges(newPath(f.slice(0, upTo))))).toBe(asObj(replayBadges(oldPath(f.slice(0, upTo)))));
    }
  });

  it("with everything already announced, no badge is announced again or newly", () => {
    const f = club();
    const all = replayBadges(oldPath(f));
    const announced = new Set<string>();
    for (const [u, keys] of all.everEarned) for (const k of keys.keys()) announced.add(`${u}:${k}`);
    for (let upTo = 1; upTo <= f.length; upTo++) {
      const replay = replayBadges(newPath(f.slice(0, upTo)));
      const { awards } = pickBadgeAwards({ replay, matchId: f[upTo - 1].raw.id, announced, bootstrap: false, eligibleUserIds: new Set(PLAYERS) });
      expect(awards, `match ${upTo}`).toEqual([]);
    }
  });

  it("an open vote is credited to nobody by either path", () => {
    const f = club();
    const open = newPath(f).at(-1)!;
    expect(open.momWinners).toEqual([]);
    expect(oldPath(f).at(-1)!.momWinners).toEqual([]);
  });

  it("when votes moved after the post, the badge follows the ANNOUNCED winner, as the player's page does", () => {
    const f = club({ changedAfterPost: true });
    const m = f.at(-2)!;
    const announcedWinner = (m.record.announcedResult as { tally: Array<{ userId: string }> }).tally[0].userId;
    expect(newPath(f).at(-2)!.momWinners).toEqual([announcedWinner]);
    expect(oldPath(f).at(-2)!.momWinners).not.toEqual([announcedWinner]);
  });
});
