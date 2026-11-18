/**
 * THE LAST MAN OF THE MATCH, AS FACTS (2026-11-10; the rules, 2026-11-16).
 *
 * Sutton FC, Tue 10 Nov 19:25: "@Match Time who was the last MoM and for
 * which game it was? How many votes did he get out of how many votes?" was
 * answered with the all-time Man of the Match table. These pin the facts the
 * grounded answers are given about ONE match.
 *
 * Kemal's rules (2026-11-16):
 *   1. POSTED: told exactly as announced, the winner and the tally the group
 *      saw. Later votes or vote changes never alter it.
 *   2. FINAL, NEVER POSTED: once the vote is over, the winner only. No counts.
 *   3. NOT FINAL, OR STILL TO BE POSTED: nothing about it. Its status in true
 *      words: never "open" when it is not, never a promise of a post that will
 *      not come, never a timing.
 *   4. ORGANISERS' PICK: final when made. As announced if posted, else the
 *      winner only.
 */
import { describe, expect, it } from "vitest";
import { lastMomContextLines, lastMomFacts, momCredit, type MomMatchRecord } from "../last-mom";
import type { MomAnnouncedResult } from "../../mom-announce-rules";

const NOW = new Date("2026-11-10T19:25:00Z");
const DAY = 24 * 60 * 60 * 1000;
const H = 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

/** A stored vote result as the claim writes it: the tally and the winners
 *  the post announced (the top count, ties shared). */
const vote = (...t: Array<[string, number]>): MomAnnouncedResult => {
  const top = Math.max(...t.map(([, n]) => n));
  return {
    v: 1,
    kind: "vote",
    tally: t.map(([name, votes]) => ({ userId: `u-${name.toLowerCase()}`, name, votes })),
    winners: t.filter(([, n]) => n === top).map(([name]) => `u-${name.toLowerCase()}`),
  };
};
const live = (...t: Array<[string, number]>) => t.map(([name, votes]) => ({ userId: `u-${name.toLowerCase()}`, name, votes }));

/** A match played `daysAgo`, a 120h vote, the club's next fixture a week later. */
function rec(o: Partial<MomMatchRecord> & { date: Date }): MomMatchRecord {
  return {
    teamLabels: ["Red", "Yellow"],
    redScore: 7,
    yellowScore: 9,
    tally: live(["Mojib", 5]),
    announced: true,
    postedAt: o.announced === false ? null : new Date(o.date.getTime() + 2 * DAY),
    announcedResult: vote(["Mojib", 5]),
    voteClosesAt: new Date(o.date.getTime() + 120 * H),
    nextFixtureAt: new Date(o.date.getTime() + 7 * DAY),
    isHistorical: false,
    announceable: true,
    ...o,
  };
}
const VOTERS = { now: NOW, organisersPick: false };
const PICKERS = { now: NOW, organisersPick: true };
const text = (f: ReturnType<typeof lastMomFacts>) => lastMomContextLines(f).join("\n");

describe("rule 1: a posted result is told exactly as announced", () => {
  it("the winner and every vote, out of the votes cast, from the stored announcement", () => {
    const f = lastMomFacts(
      [
        rec({ date: new Date("2026-10-20T19:30:00Z"), announcedResult: vote(["Mojib", 5], ["Habib", 3], ["Sait", 1]) }),
        rec({ date: new Date("2026-10-06T19:30:00Z"), announcedResult: vote(["Habib", 9]) }),
      ],
      VOTERS,
    );
    expect(f.pending).toEqual([]);
    expect(f.last!.date.toISOString()).toBe("2026-10-20T19:30:00.000Z");
    expect(f.last!.told).toBe("announced");
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    expect(f.last!.votes).toEqual({ top: 5, total: 9 });
    expect(f.last!.tally.map((t) => `${t.name} ${t.votes}`)).toEqual(["Mojib 5", "Habib 3", "Sait 1"]);
    expect(f.last!.score).toEqual({ red: 7, yellow: 9 });
    expect(f.last!.pickedByOrganisers).toBe(false);
  });

  it("a vote CHANGED after the post never alters it (the live rows now say Habib)", () => {
    const f = lastMomFacts(
      [rec({ date: ago(2), announcedResult: vote(["Mojib", 3], ["Habib", 2]), tally: live(["Habib", 3], ["Mojib", 2]) })],
      VOTERS,
    );
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    expect(f.last!.votes).toEqual({ top: 3, total: 5 });
    expect(text(f)).toContain("Man of the Match: Mojib, with 3 of the 5 votes cast, as announced in the group");
    expect(text(f)).not.toContain("Habib 3");
  });

  it("an EARLY post, with votes still coming in afterwards: as announced", () => {
    const f = lastMomFacts(
      [rec({ date: ago(1), announcedResult: vote(["Mojib", 4]), tally: live(["Mojib", 4], ["Sait", 3]) })],
      VOTERS,
    );
    expect(f.last!.tally.map((t) => `${t.name} ${t.votes}`)).toEqual(["Mojib 4"]);
    expect(f.pending).toEqual([]);
  });

  it("the day-5 BACKSTOP inside a 168h vote: later votes on day 6 do not change it", () => {
    const date = ago(6);
    const f = lastMomFacts(
      [rec({ date, voteClosesAt: new Date(date.getTime() + 168 * H), announcedResult: vote(["Sait", 2], ["Mojib", 1]), tally: live(["Mojib", 4], ["Sait", 2]) })],
      VOTERS,
    );
    expect(f.last!.told).toBe("announced");
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Sait"]);
    expect(f.last!.votes).toEqual({ top: 2, total: 3 });
  });

  // Round 4: a merge sums two records of one person into one tally entry.
  // The winners stay those announced, and the counts no longer match the
  // post, so the winner(s) are told without any count.
  // Round 5: counts are dropped only as far as the merge changed them. No
  // winner merged: his count and the votes cast are as posted, so they stay;
  // only the per-player list (one of its rows changed) goes.
  it("a merge of two NON-winners: the winner's announced count and the votes cast stay, the per-player list goes", () => {
    const merged: MomAnnouncedResult = {
      v: 1,
      kind: "vote",
      tally: [{ userId: "u-pete", name: "Pete", votes: 4 }, { userId: "u-alex", name: "Alex", votes: 5 }],
      winners: ["u-alex"],
      merged: true,
    };
    const f = lastMomFacts([rec({ date: ago(3), announcedResult: merged })], VOTERS);
    expect(f.last!.votes).toEqual({ top: 5, total: 9 });
    expect(f.last!.tally).toEqual([]);
    const t = text(f);
    expect(t).toContain("Man of the Match: Alex, with 5 of the 9 votes cast, as announced in the group");
    expect(t).not.toMatch(/Votes each player got|Pete/);
  });

  it("a MERGED stored result where a WINNER was merged: the announced winner (never re-derived), with no counts at all", () => {
    const merged: MomAnnouncedResult = {
      v: 1,
      kind: "vote",
      tally: [{ userId: "u-pete", name: "Pete", votes: 4 }, { userId: "u-alex", name: "Alex", votes: 3 }],
      winners: ["u-alex"],
      merged: true,
      winnerMerged: true,
    };
    const f = lastMomFacts([rec({ date: ago(3), announcedResult: merged })], VOTERS);
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Alex"]);
    expect(f.last!.votes).toBeNull();
    expect(f.last!.tally).toEqual([]);
    const t = text(f);
    expect(t).toContain("Man of the Match: Alex.");
    expect(t).not.toMatch(/Pete|\b4\b|votes cast|Votes each player got/);
  });

  it("a tie is shared as it was announced: every top name, never one picked", () => {
    const f = lastMomFacts([rec({ date: new Date("2026-10-20T19:30:00Z"), announcedResult: vote(["Mojib", 2], ["Habib", 2], ["Sait", 1]) })], VOTERS);
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Habib", "Mojib"]);
    expect(f.last!.votes).toEqual({ top: 2, total: 5 });
    expect(text(f)).toContain("Man of the Match: shared between Habib and Mojib, with 2 votes each of the 5 votes cast, as announced in the group");
  });

  // Review of #608: the current votes may name another winner (or a tie)
  // than the post did, so a post with no stored record names NOBODY.
  // Round 2 of the review (Kemal, 2026-11-16): only 5 of production's 34
  // posts kept their text. Once the vote window has CLOSED the votes are
  // final, so the winner is named from them (no counts), as for a final
  // result never posted. Before it closes, nobody is named.
  it("posted before results were stored, the vote window CLOSED: the final winner, no counts", () => {
    const date = new Date("2026-10-20T19:30:00Z");
    const f = lastMomFacts([rec({ date, postedAt: new Date("2026-10-22T14:00:00Z"), announcedResult: null, tally: live(["Mojib", 5], ["Habib", 3]) })], VOTERS);
    expect(f.last!.told).toBe("winner-only");
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    expect(f.last!.votes).toBeNull();
    const t = text(f);
    expect(t).toContain("Man of the Match: Mojib. Only the winner is told for this match: there are no vote counts to give.");
    expect(t).not.toMatch(/Habib|votes cast|\d+ of the/);
  });

  it("posted before results were stored, the vote window still OPEN: no name; it says the post has the result", () => {
    const date = ago(2);
    const f = lastMomFacts([rec({ date, postedAt: ago(1), announcedResult: null, tally: live(["Mojib", 5], ["Habib", 3]) })], VOTERS);
    expect(f.last!.told).toBe("posted-unrecorded");
    expect(f.last!.winners).toEqual([]);
    const t = text(f);
    expect(t).toContain("the result was posted in the group on Mon 9 Nov, and that post has it");
    expect(t).not.toMatch(/Mojib|Habib|votes cast|\d+ of the/);
  });

  it("...and in an organisers' club, the current single pick is the pick (the correction wins)", () => {
    const f = lastMomFacts([rec({ date: ago(3), announcedResult: null, tally: live(["Akram", 1]) })], PICKERS);
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Akram"]);
    expect(f.last!.pickedByOrganisers).toBe(true);
  });
});

describe("momCredit: who a match credits in the Man of the Match WINS tables (review of #608)", () => {
  const names = (w: Array<{ name: string }>) => w.map((x) => x.name);

  it("an OPEN vote credits nobody, however far ahead its leader is", () => {
    expect(momCredit(rec({ date: ago(1), announced: false, announcedResult: null, tally: live(["Alice", 4]) }), NOW, false)).toEqual([]);
  });

  it("closed and still to be posted credits nobody", () => {
    const date = ago(4);
    expect(momCredit(rec({ date, voteClosesAt: new Date(date.getTime() + 72 * H), announced: false, announcedResult: null }), NOW, false)).toEqual([]);
  });

  it("posted: the ANNOUNCED winner, not the re-counted one; a shared post credits both", () => {
    expect(names(momCredit(rec({ date: ago(3), announcedResult: vote(["Pete", 3], ["Dan", 1]), tally: live(["Dan", 3], ["Pete", 1]) }), NOW, false))).toEqual(["Pete"]);
    expect(names(momCredit(rec({ date: ago(3), announcedResult: vote(["Pete", 2], ["Dan", 2]) }), NOW, false))).toEqual(["Dan", "Pete"]);
  });

  it("an organisers' club: the corrected pick", () => {
    const pick: MomAnnouncedResult = { v: 1, kind: "pick", winner: { userId: "u-mojib", name: "Mojib" } };
    expect(names(momCredit(rec({ date: ago(3), announcedResult: pick, tally: live(["Akram", 1]) }), NOW, true))).toEqual(["Akram"]);
  });

  it("final, never posted: the final winner", () => {
    expect(names(momCredit(rec({ date: ago(12), announced: false, announcedResult: null, tally: live(["Alice", 2], ["Dan", 1]) }), NOW, false))).toEqual(["Alice"]);
  });

  it("posted with no record: the final winner once the vote is over, nobody while it is open", () => {
    expect(names(momCredit(rec({ date: ago(12), announcedResult: null, tally: live(["Alice", 2]) }), NOW, false))).toEqual(["Alice"]);
    expect(momCredit(rec({ date: ago(2), announcedResult: null, tally: live(["Alice", 2]) }), NOW, false)).toEqual([]);
  });

  it("a HISTORICAL (back-filled) match is decided: its final winner, told by name only", () => {
    const m = rec({ date: ago(1), isHistorical: true, announced: false, announcedResult: null, nextFixtureAt: null, tally: live(["Erdal", 1]) });
    expect(names(momCredit(m, NOW, false))).toEqual(["Erdal"]);
    const f = lastMomFacts([m], VOTERS);
    expect(f.pending).toEqual([]);
    expect(f.last!.told).toBe("winner-only");
  });
});

describe("no post is promised when the scheduler will never send it (review of #608)", () => {
  it("postMatchEndFlow off, Man of the Match votes switched off, or the match not completed: still open, nothing promised", () => {
    const date = ago(2);
    const f = lastMomFacts([rec({ date, announced: false, announcedResult: null, announceable: false })], VOTERS);
    expect(f.pending).toEqual([{ date, state: "voting", toBePosted: false }]);
    expect(text(f)).not.toMatch(/will be posted/);
  });

  it("closed and not announceable: no promise either", () => {
    const date = ago(6);
    const f = lastMomFacts([rec({ date, announced: false, announcedResult: null, announceable: false, nextFixtureAt: null })], VOTERS);
    expect(f.pending).toEqual([{ date, state: "closed", toBePosted: false }]);
  });
});

describe("rule 2: final but never posted, once the vote is over: the winner only", () => {
  it("superseded: the next weekly fixture has been played, the vote closed, never posted", () => {
    const date = ago(8);
    const f = lastMomFacts([rec({ date, announced: false, announcedResult: null, tally: live(["Mojib", 5], ["Habib", 3]), nextFixtureAt: ago(1) })], VOTERS);
    expect(f.pending).toEqual([]);
    expect(f.last!.told).toBe("winner-only");
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    expect(text(f)).not.toMatch(/Habib|\b5\b|\b3\b/);
  });

  it("too old ever to be posted (past 9 days): the winner only", () => {
    const f = lastMomFacts([rec({ date: ago(12), announced: false, announcedResult: null, nextFixtureAt: null })], VOTERS);
    expect(f.last!.told).toBe("winner-only");
    expect(f.pending).toEqual([]);
  });

  it("a shared winner never posted: both names, no counts", () => {
    const f = lastMomFacts([rec({ date: ago(12), announced: false, announcedResult: null, tally: live(["Mojib", 2], ["Habib", 2]) })], VOTERS);
    expect(text(f)).toContain("Man of the Match: shared between Habib and Mojib. Only the winners are told for this match: there are no vote counts to give.");
  });
});

describe("rule 3: not final, or still to be posted: nothing about it, its status in true words", () => {
  const NEVER_LEAKED = /Sait|\b4\b/;

  it("VOTING (120h, day 2, weekly club): still open, its result will be posted; the last told one is given", () => {
    const f = lastMomFacts(
      [
        rec({ date: new Date("2026-11-08T19:30:00Z"), announced: false, announcedResult: null, tally: live(["Sait", 4]) }),
        rec({ date: new Date("2026-11-01T19:30:00Z") }),
      ],
      VOTERS,
    );
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    expect(f.pending).toEqual([{ date: new Date("2026-11-08T19:30:00Z"), state: "voting", toBePosted: true }]);
    const t = text(f);
    expect(t).toContain("Voting for Man of the Match of the match on Sun 8 Nov is still open. Its result will be posted in the group");
    expect(t).not.toMatch(NEVER_LEAKED);
    // No timing promise of any kind.
    expect(t).not.toMatch(/when the vote closes|in \d+ days?|tomorrow|tonight/i);
  });

  it("CLOSED (72h, day 4): the vote is over and not posted yet; never called open", () => {
    const date = ago(4);
    const f = lastMomFacts(
      [rec({ date, voteClosesAt: new Date(date.getTime() + 72 * H), announced: false, announcedResult: null, tally: live(["Sait", 4]) })],
      VOTERS,
    );
    expect(f.last).toBeNull();
    expect(f.pending).toEqual([{ date, state: "closed", toBePosted: true }]);
    const t = text(f);
    expect(t).toMatch(/has closed\. Its result will be posted in the group/);
    expect(t).not.toMatch(/still open/);
    expect(t).not.toMatch(NEVER_LEAKED);
  });

  it("120h: open on day 4, closed on day 5.5 when the backstop has not posted yet", () => {
    const at = (days: number) =>
      lastMomFacts([rec({ date: ago(days), announced: false, announcedResult: null })], VOTERS).pending.map((p) => p.state);
    expect(at(4)).toEqual(["voting"]);
    expect(at(5.5)).toEqual(["closed"]);
  });

  it("168h: still open on day 6 when nothing was posted", () => {
    const date = ago(6);
    const f = lastMomFacts([rec({ date, voteClosesAt: new Date(date.getTime() + 168 * H), announced: false, announcedResult: null })], VOTERS);
    expect(f.pending.map((p) => p.state)).toEqual(["voting"]);
    expect(f.last).toBeNull();
  });

  it("MOVED KICKOFF: the next game is 3 days later, so no post is promised while voting", () => {
    const date = ago(2);
    const f = lastMomFacts(
      [rec({ date, announced: false, announcedResult: null, tally: live(["Sait", 4]), nextFixtureAt: new Date(date.getTime() + 3 * DAY) })],
      VOTERS,
    );
    expect(f.pending).toEqual([{ date, state: "voting", toBePosted: false }]);
    const t = text(f);
    expect(t).toMatch(/is still open, so nothing about its result can be told yet/);
    expect(t).not.toMatch(/will be posted/);
    expect(t).not.toMatch(NEVER_LEAKED);
  });

  it("SUPERSEDED while the vote is still open (next game played on day 3, now day 4): undecided, nothing told, nothing promised", () => {
    const date = ago(4);
    const f = lastMomFacts(
      [rec({ date, announced: false, announcedResult: null, tally: live(["Sait", 4]), nextFixtureAt: new Date(date.getTime() + 3 * DAY) })],
      VOTERS,
    );
    expect(f.last).toBeNull();
    expect(f.pending).toEqual([{ date, state: "undecided", toBePosted: false }]);
    const t = text(f);
    expect(t).not.toMatch(/will be posted/);
    expect(t).not.toMatch(NEVER_LEAKED);
  });

  it("...and once that vote closes (day 5.5) it is final and never posted: the winner only", () => {
    const date = ago(5.5);
    const f = lastMomFacts(
      [rec({ date, announced: false, announcedResult: null, tally: live(["Sait", 4], ["Mojib", 1]), nextFixtureAt: new Date(date.getTime() + 3 * DAY) })],
      VOTERS,
    );
    expect(f.pending).toEqual([]);
    expect(f.last!.told).toBe("winner-only");
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Sait"]);
    expect(text(f)).not.toMatch(/\b4\b|Mojib/);
  });

  it("a CANCELLED next game is no next fixture (the loader passes none): the post is still promised", () => {
    const date = ago(6);
    const f = lastMomFacts([rec({ date, announced: false, announcedResult: null, nextFixtureAt: null })], VOTERS);
    expect(f.pending).toEqual([{ date, state: "closed", toBePosted: true }]);
  });

  it("close to the 9-day stop, a post is not promised", () => {
    const date = ago(8.5);
    const f = lastMomFacts([rec({ date, announced: false, announcedResult: null, nextFixtureAt: null })], VOTERS);
    expect(f.pending).toEqual([{ date, state: "closed", toBePosted: false }]);
    expect(text(f)).toMatch(/has closed, but its result has not been posted, so nothing about it can be told for now/);
  });

  it("TWO FIXTURES A WEEK: Tuesday's vote still open, Thursday's posted early; both said truthfully", () => {
    const tue = ago(2);
    const thu = ago(0.5);
    const f = lastMomFacts(
      [
        rec({ date: tue, announced: false, announcedResult: null, tally: live(["Sait", 4]) }),
        rec({ date: thu, announcedResult: vote(["Craig", 6]) }),
      ],
      VOTERS,
    );
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Craig"]);
    expect(f.pending.map((p) => p.state)).toEqual(["voting"]);
    expect(text(f)).not.toMatch(NEVER_LEAKED);
  });
});

describe("rule 4: an organisers' pick", () => {
  it("posted, then restated unchanged (setMatchMom recreates the row): the same pick, and the match never drops out", () => {
    const pick: MomAnnouncedResult = { v: 1, kind: "pick", winner: { userId: "u-mojib", name: "Mojib" } };
    const f = lastMomFacts([rec({ date: ago(3), announcedResult: pick, tally: live(["Mojib", 1]) })], PICKERS);
    expect(f.last!.pickedByOrganisers).toBe(true);
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    const t = text(f);
    expect(t).toContain("Man of the Match: Mojib, picked by the organisers. There was no vote");
    expect(t).not.toMatch(/votes cast/);
  });

  // Kemal, 2026-11-16 (PR #608 review): in an organisers' club the
  // correction wins. The organiser's latest pick is told, still as a pick.
  it("posted, then CORRECTED by an organiser: the correction is told, picked by the organisers, no votes", () => {
    const pick: MomAnnouncedResult = { v: 1, kind: "pick", winner: { userId: "u-mojib", name: "Mojib" } };
    const f = lastMomFacts([rec({ date: ago(3), announcedResult: pick, tally: live(["Akram", 1]) })], PICKERS);
    expect(f.last!.pickedByOrganisers).toBe(true);
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Akram"]);
    expect(f.last!.votes).toBeNull();
    const t = text(f);
    expect(t).toContain("Man of the Match: Akram, picked by the organisers. There was no vote");
    expect(t).not.toMatch(/votes cast|Mojib/);
  });

  it("posted, then the pick row is gone: the pick as announced", () => {
    const pick: MomAnnouncedResult = { v: 1, kind: "pick", winner: { userId: "u-mojib", name: "Mojib" } };
    const f = lastMomFacts([rec({ date: ago(3), announcedResult: pick, tally: [] })], PICKERS);
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    expect(f.last!.pickedByOrganisers).toBe(true);
  });

  it("a VOTING club stays as announced, even for a posted pick whose rows changed since", () => {
    const pick: MomAnnouncedResult = { v: 1, kind: "pick", winner: { userId: "u-mojib", name: "Mojib" } };
    const f = lastMomFacts([rec({ date: ago(3), announcedResult: pick, tally: live(["Akram", 1]) })], VOTERS);
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    expect(f.last!.told).toBe("announced");
  });

  // Round 4 of the review: picks wait 9 to 11 hours for their post in
  // production. Rule 3 holds for them too: a pick that WILL be posted is not
  // told before its post, and nothing about it is said but that.
  it("an unposted pick that WILL be posted: nothing told, honestly; nobody credited", () => {
    const date = ago(0.2);
    const m = rec({ date, announced: false, announcedResult: null, tally: live(["Mojib", 1]) });
    const f = lastMomFacts([m], PICKERS);
    expect(f.last).toBeNull();
    expect(f.pending).toEqual([{ date, state: "picked", toBePosted: true }]);
    const t = text(f);
    expect(t).toMatch(/The organisers have picked the Man of the Match of the match on \w{3} \d{1,2} \w{3}\. The pick will be posted in the group; until then it cannot be told\./);
    expect(t).not.toMatch(/Mojib|still open|Voting/);
    expect(momCredit(m, NOW, true)).toEqual([]);
  });

  // Round 5 of the review: "a whole day left" was a guess. The answer now
  // holds a pick exactly when the scheduler will post it: at its next
  // 09:00 to 21:00 London tick, if the match is not past 9 days by then and
  // its next fixture has not kicked off (`momPickWillBePosted`, shared with
  // bot-scheduler.ts 6e). The old third case here (next game 3 hours after
  // 19:25) was impossible: the scheduler posts it at 19:25.
  const told = (m: MomMatchRecord, now: Date) => {
    const f = lastMomFacts([m], { now, organisersPick: true });
    expect(f.pending).toEqual([]);
    expect(f.last!.pickedByOrganisers).toBe(true);
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    expect(momCredit(m, now, true).map((w) => w.name)).toEqual(["Mojib"]);
  };
  const held = (m: MomMatchRecord, now: Date) => {
    const f = lastMomFacts([m], { now, organisersPick: true });
    expect(f.last).toBeNull();
    expect(f.pending.map((p) => p.state)).toEqual(["picked"]);
    expect(momCredit(m, now, true)).toEqual([]);
  };
  const pick = (o: Partial<MomMatchRecord> & { date: Date }) => rec({ announced: false, announcedResult: null, tally: live(["Mojib", 1]), ...o });

  it("no post coming: MoM posts off (or the bot off, or billing paused): told at once", () => {
    told(pick({ date: ago(0.2), announceable: false }), NOW);
  });

  it("no post coming: past the 9-day stop: told", () => {
    told(pick({ date: ago(9.5) }), NOW);
  });

  it("no post coming: asked at 23:00 London, the next game kicks off at 08:00, before the 09:00 tick: told", () => {
    const now = new Date("2026-11-10T23:00:00Z");
    told(pick({ date: new Date("2026-11-10T20:00:00Z"), nextFixtureAt: new Date("2026-11-11T08:00:00Z") }), now);
  });

  it("REVIEWER CASE: the next fixture is tonight at 19:00, asked at 04:07: the 09:00 tick posts it first, so it is held", () => {
    const now = new Date("2026-11-10T04:07:00Z");
    held(pick({ date: new Date("2026-11-09T21:00:00Z"), nextFixtureAt: new Date("2026-11-10T19:00:00Z") }), now);
  });

  it("REVIEWER CASE: a match 8.4 days old: still posted (at the next tick, under 9 days), so it is held", () => {
    // No next fixture played yet (else the scheduler would have stopped at it).
    held(pick({ date: ago(8.4), nextFixtureAt: null }), NOW);
    // Asked at 04:07, 8.4 days old: the 09:00 tick is at 8.6 days, still under 9.
    const early = new Date("2026-11-10T04:07:00Z");
    held(pick({ date: new Date(early.getTime() - 8.4 * DAY), nextFixtureAt: null }), early);
    // Asked at 22:00 when 8.9 days old: the next tick (09:00) is past 9 days: no post.
    const late = new Date("2026-11-10T22:00:00Z");
    told(pick({ date: new Date(late.getTime() - 8.9 * DAY), nextFixtureAt: null }), late);
  });

  it("two pick rows for the same player: the scheduler posts it as a pick, so it is held too, and told as a pick", () => {
    held(pick({ date: ago(0.2), tally: live(["Mojib", 2]) }), NOW);
    told(pick({ date: ago(9.5), tally: live(["Mojib", 2]) }), NOW);
  });

  it("votes left from before the switch, no record: the winner only, as a vote (rule 2)", () => {
    const f = lastMomFacts([rec({ date: ago(2), announced: false, announcedResult: null, tally: live(["Mojib", 3], ["Sait", 1]) })], PICKERS);
    expect(f.pending).toEqual([]);
    expect(f.last!.pickedByOrganisers).toBe(false);
    expect(f.last!.told).toBe("winner-only");
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    expect(text(f)).not.toMatch(/\b3\b|Sait/);
  });

  // Round 4 (Kemal's rule 1 over rule 4): a result posted as a VOTE, before
  // the club switched to picking, stays as announced even when an organiser
  // later writes a pick for that match. It was a vote when it was posted.
  it("a VOTE result posted before the club switched to picking: as announced, even after a pick is written", () => {
    const f = lastMomFacts([rec({ date: ago(4), announcedResult: vote(["Mojib", 3], ["Sait", 1]), tally: live(["Akram", 1]) })], PICKERS);
    expect(f.last!.pickedByOrganisers).toBe(false);
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    expect(f.last!.votes).toEqual({ top: 3, total: 4 });
  });

  it("votes left from before the switch, with a record: as announced", () => {
    const f = lastMomFacts([rec({ date: ago(2), announcedResult: vote(["Mojib", 3], ["Sait", 1]), tally: live(["Mojib", 3], ["Sait", 1]) })], PICKERS);
    expect(f.last!.pickedByOrganisers).toBe(false);
    expect(f.last!.votes).toEqual({ top: 3, total: 4 });
  });
});

describe("what is never read or told", () => {
  it("no Man of the Match yet: nothing, and nothing pending", () => {
    expect(lastMomFacts([], VOTERS)).toEqual({ last: null, pending: [], recent: [] });
  });

  it("a match with no votes and no post is skipped", () => {
    const f = lastMomFacts([rec({ date: ago(1), announced: false, announcedResult: null, tally: [] }), rec({ date: new Date("2026-10-20T19:30:00Z") })], VOTERS);
    expect(f.last!.date.toISOString()).toBe("2026-10-20T19:30:00.000Z");
    expect(f.pending).toEqual([]);
  });

  it("who voted for whom is never in it", () => {
    const f = lastMomFacts([rec({ date: new Date("2026-10-20T19:30:00Z"), announcedResult: vote(["Mojib", 5], ["Habib", 3]) })], VOTERS);
    expect(text(f)).not.toMatch(/voted for/i);
  });
});

describe("lastMomContextLines (what the grounded answers read)", () => {
  it("one winner: the match, the score and who won it, the votes out of the total, every vote", () => {
    const t = text(lastMomFacts([rec({ date: new Date("2026-10-20T19:30:00Z"), announcedResult: vote(["Mojib", 5], ["Habib", 3]) })], VOTERS));
    expect(t).toMatch(/^LAST MAN OF THE MATCH/);
    expect(t).toContain("Tue 20 Oct");
    expect(t).toContain("Red 7, Yellow 9 (Yellow won)");
    expect(t).toContain("Man of the Match: Mojib, with 5 of the 8 votes cast");
    expect(t).toContain("Votes each player got, as announced: Mojib 5, Habib 3");
  });

  it("no score recorded says so; a draw says so", () => {
    const none = text(lastMomFacts([rec({ date: new Date("2026-10-20T19:30:00Z"), redScore: null, yellowScore: null })], VOTERS));
    expect(none).toContain("no score recorded");
    const draw = text(lastMomFacts([rec({ date: new Date("2026-10-20T19:30:00Z"), redScore: 4, yellowScore: 4 })], VOTERS));
    expect(draw).toContain("Red 4, Yellow 4 (a draw)");
  });

  // The live check, 2026-11-10: "who won MoM last week?" with the last one
  // three weeks back drew NO_ANSWER. The block says it is the latest there is.
  it("says it is the latest one, to give with its date whatever day or week is asked", () => {
    const f = lastMomFacts([rec({ date: new Date("2026-10-20T19:30:00Z") })], VOTERS);
    expect(text(f)).toMatch(/No match after it has a Man of the Match, so it is the latest one[^\n]*with its date/);
  });

  it("none yet says so plainly; no facts at all prints nothing", () => {
    expect(lastMomContextLines({ last: null, pending: [], recent: [] }).join("\n")).toMatch(/LAST MAN OF THE MATCH: none can be told yet/);
    expect(lastMomContextLines(undefined)).toEqual([]);
  });

  it("no long dashes anywhere in the lines", () => {
    const f = lastMomFacts(
      [
        rec({ date: ago(2), announced: false, announcedResult: null }),
        rec({ date: ago(9.5), announced: false, announcedResult: null, nextFixtureAt: ago(2.5) }),
      ],
      VOTERS,
    );
    expect(text(f)).not.toMatch(/[—–]/);
  });
});

describe("recent: every Man of the Match that can be told, newest first", () => {
  it("lists each told match's winners, skips a vote still open, keeps ties shared", () => {
    const f = lastMomFacts(
      [
        rec({ date: ago(1), announced: false, announcedResult: null, tally: live(["BH", 2]) }),
        rec({ date: new Date("2026-11-02T20:15:00Z"), announcedResult: vote(["Craig", 5], ["Ben", 1]) }),
        rec({ date: new Date("2026-10-26T20:15:00Z"), announcedResult: vote(["Mo", 3], ["Naim", 3]) }),
        rec({ date: new Date("2026-10-19T20:15:00Z"), announced: false, announcedResult: null, tally: live(["Ali", 4]), nextFixtureAt: new Date("2026-10-26T20:15:00Z") }),
      ],
      VOTERS,
    );
    expect(
      f.recent.map((r) => `${r.date.toISOString().slice(0, 10)} ${r.winners.map((w) => w.name).join("+")} ${r.votes ? r.votes.total : "-"}`),
    ).toEqual(["2026-11-02 Craig 6", "2026-10-26 Mo+Naim 6", "2026-10-19 Ali -"]);
    expect(f.last!.winners[0].name).toBe("Craig");
  });
});

/* ── A CLAIM THAT NEVER WENT OUT (review of #608, round 6) ─────────────
 *
 * The claim row (`<matchId>:mom-announcement`) is written before the Pi
 * sends; the Pi stamps `waMessageId` on it only once WhatsApp took the
 * message. A row with no message id was never confirmed sent (production,
 * 18 Nov: 3 of 26 MoM claims, all Sept), and the scheduler never posts that
 * key again. So it is NOT "as announced": the never-posted rules, with no
 * post to come.
 */
describe("a claimed post never confirmed sent (no message id)", () => {
  const unsent = (o: Partial<MomMatchRecord> & { date: Date }) =>
    rec({ announced: false, postedAt: null, announcedResult: null, postUnsent: true, ...o });

  it("once the vote is over: the winner only, no counts, never 'as announced'", () => {
    // 6 days ago, a 120h vote: closed; the 9-day stop and the next fixture
    // are still ahead, so without the unsent claim it would wait for a post.
    const f = lastMomFacts([unsent({ date: ago(6), tally: live(["Mojib", 3], ["Habib", 1]) })], VOTERS);
    expect(f.pending).toEqual([]);
    expect(f.last!.told).toBe("winner-only");
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    expect(f.last!.votes).toBeNull();
    expect(f.last!.tally).toEqual([]);
    const t = text(f);
    expect(t).not.toMatch(/as announced|votes cast|Habib/);
    expect(t).toContain("Man of the Match: Mojib. Only the winner is told");
  });

  it("while the vote is open: nothing told, and no post promised", () => {
    const f = lastMomFacts([unsent({ date: ago(2), tally: live(["Mojib", 3]) })], VOTERS);
    expect(f.last).toBeNull();
    expect(f.pending).toEqual([{ date: ago(2), state: "undecided", toBePosted: false }]);
    expect(text(f)).not.toMatch(/will be posted|Mojib/);
  });

  it("credits the final winner once the vote is over, nobody while open", () => {
    expect(momCredit(unsent({ date: ago(6), tally: live(["Mojib", 3]) }), NOW, false).map((w) => w.name)).toEqual(["Mojib"]);
    expect(momCredit(unsent({ date: ago(2), tally: live(["Mojib", 3]) }), NOW, false)).toEqual([]);
  });

  it("an organisers' pick whose post never went: told as the pick, not held for a post that will not come", () => {
    const f = lastMomFacts([unsent({ date: ago(1), tally: live(["Akram", 1]) })], PICKERS);
    expect(f.pending).toEqual([]);
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Akram"]);
    expect(f.last!.pickedByOrganisers).toBe(true);
    expect(text(f)).not.toMatch(/as announced/);
  });
});
