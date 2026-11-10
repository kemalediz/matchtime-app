/**
 * THE LAST MAN OF THE MATCH, AS FACTS (2026-11-10).
 *
 * Sutton FC, Tue 10 Nov 19:25: "@Match Time who was the last MoM and for
 * which game it was? How many votes did he get out of how many votes?" was
 * answered with the all-time Man of the Match table. These pin the facts the
 * grounded answers are now given about ONE match: which match, the winner or
 * the shared winners, the votes, and whether the organisers picked it.
 */
import { describe, expect, it } from "vitest";
import { lastMomContextLines, lastMomFacts, type MomMatchRecord } from "../last-mom";

const NOW = new Date("2026-11-10T19:25:00Z");
const DAY = 24 * 60 * 60 * 1000;

function rec(o: Partial<MomMatchRecord> & { date: Date }): MomMatchRecord {
  return {
    teamLabels: ["Red", "Yellow"],
    redScore: 7,
    yellowScore: 9,
    tally: [{ userId: "u-mojib", name: "Mojib", votes: 5 }],
    announced: true,
    ...o,
  };
}

describe("lastMomFacts", () => {
  it("the most recent decided match, with the winner and the votes out of the total", () => {
    const f = lastMomFacts(
      [
        rec({
          date: new Date("2026-10-20T19:30:00Z"),
          tally: [
            { userId: "u-sait", name: "Sait", votes: 1 },
            { userId: "u-mojib", name: "Mojib", votes: 5 },
            { userId: "u-habib", name: "Habib", votes: 3 },
          ],
        }),
        rec({ date: new Date("2026-10-06T19:30:00Z"), tally: [{ userId: "u-habib", name: "Habib", votes: 9 }] }),
      ],
      { now: NOW, organisersPick: false },
    );
    expect(f.openVoteDate).toBeNull();
    expect(f.last).not.toBeNull();
    expect(f.last!.date.toISOString()).toBe("2026-10-20T19:30:00.000Z");
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    expect(f.last!.totalVotes).toBe(9);
    expect(f.last!.tally.map((t) => `${t.name} ${t.votes}`)).toEqual(["Mojib 5", "Habib 3", "Sait 1"]);
    expect(f.last!.score).toEqual({ red: 7, yellow: 9 });
    expect(f.last!.pickedByOrganisers).toBe(false);
  });

  it("a tie is shared: every top name, never one picked", () => {
    const f = lastMomFacts(
      [
        rec({
          date: new Date("2026-10-20T19:30:00Z"),
          tally: [
            { userId: "u-mojib", name: "Mojib", votes: 2 },
            { userId: "u-habib", name: "Habib", votes: 2 },
            { userId: "u-sait", name: "Sait", votes: 1 },
          ],
        }),
      ],
      { now: NOW, organisersPick: false },
    );
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Habib", "Mojib"]);
    expect(f.last!.totalVotes).toBe(5);
  });

  it("a vote still open is never the answer: the last decided match is, and the open one is named by date only", () => {
    const f = lastMomFacts(
      [
        rec({ date: new Date(NOW.getTime() - 2 * DAY), announced: false, tally: [{ userId: "u-sait", name: "Sait", votes: 4 }] }),
        rec({ date: new Date(NOW.getTime() - 9 * DAY), announced: true }),
      ],
      { now: NOW, organisersPick: false },
    );
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    expect(f.openVoteDate!.getTime()).toBe(NOW.getTime() - 2 * DAY);
  });

  it("a match too old ever to be announced counts as decided", () => {
    const f = lastMomFacts([rec({ date: new Date(NOW.getTime() - 12 * DAY), announced: false })], {
      now: NOW,
      organisersPick: false,
    });
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
    expect(f.openVoteDate).toBeNull();
  });

  it("an organisers' club: one pick is a pick, with no vote count", () => {
    const f = lastMomFacts([rec({ date: new Date("2026-11-03T21:30:00Z"), tally: [{ userId: "u-mojib", name: "Mojib", votes: 1 }] })], {
      now: NOW,
      organisersPick: true,
    });
    expect(f.last!.pickedByOrganisers).toBe(true);
    expect(f.last!.winners.map((w) => w.name)).toEqual(["Mojib"]);
  });

  it("an organisers' club whose match was voted on before the switch is still a vote", () => {
    const f = lastMomFacts(
      [
        rec({
          date: new Date("2026-10-20T19:30:00Z"),
          tally: [
            { userId: "u-mojib", name: "Mojib", votes: 3 },
            { userId: "u-sait", name: "Sait", votes: 1 },
          ],
        }),
      ],
      { now: NOW, organisersPick: true },
    );
    expect(f.last!.pickedByOrganisers).toBe(false);
    expect(f.last!.totalVotes).toBe(4);
  });

  it("no Man of the Match yet: nothing, and no open vote", () => {
    expect(lastMomFacts([], { now: NOW, organisersPick: false })).toEqual({ last: null, openVoteDate: null });
  });

  it("a match with no votes at all is skipped", () => {
    const f = lastMomFacts([rec({ date: new Date("2026-11-03T21:30:00Z"), tally: [] }), rec({ date: new Date("2026-10-20T19:30:00Z") })], {
      now: NOW,
      organisersPick: false,
    });
    expect(f.last!.date.toISOString()).toBe("2026-10-20T19:30:00.000Z");
  });
});

describe("lastMomContextLines (what the grounded answers read)", () => {
  it("one winner: the match, the score and who won it, the votes out of the total, every vote", () => {
    const f = lastMomFacts(
      [
        rec({
          date: new Date("2026-10-20T19:30:00Z"),
          tally: [
            { userId: "u-mojib", name: "Mojib", votes: 5 },
            { userId: "u-habib", name: "Habib", votes: 3 },
          ],
        }),
      ],
      { now: NOW, organisersPick: false },
    );
    const text = lastMomContextLines(f).join("\n");
    expect(text).toMatch(/^LAST MAN OF THE MATCH/);
    expect(text).toContain("Tue 20 Oct");
    expect(text).toContain("Red 7, Yellow 9 (Yellow won)");
    expect(text).toContain("Man of the Match: Mojib, with 5 of the 8 votes cast");
    expect(text).toContain("Votes each player got: Mojib 5, Habib 3");
    // Who voted for whom is never in it.
    expect(text).not.toMatch(/voted for/i);
  });

  it("a tie says shared, with the votes each", () => {
    const f = lastMomFacts(
      [
        rec({
          date: new Date("2026-10-20T19:30:00Z"),
          tally: [
            { userId: "u-habib", name: "Habib", votes: 2 },
            { userId: "u-mojib", name: "Mojib", votes: 2 },
            { userId: "u-sait", name: "Sait", votes: 1 },
          ],
        }),
      ],
      { now: NOW, organisersPick: false },
    );
    const text = lastMomContextLines(f).join("\n");
    expect(text).toContain("Man of the Match: shared between Habib and Mojib, with 2 votes each of the 5 votes cast");
  });

  it("an organisers' pick says so and gives no votes", () => {
    const f = lastMomFacts([rec({ date: new Date("2026-11-03T21:30:00Z"), tally: [{ userId: "u-mojib", name: "Mojib", votes: 1 }] })], {
      now: NOW,
      organisersPick: true,
    });
    const text = lastMomContextLines(f).join("\n");
    expect(text).toContain("Man of the Match: Mojib, picked by the organisers. There was no vote");
    expect(text).not.toMatch(/votes cast/);
  });

  it("no score recorded says so; a draw says so", () => {
    const none = lastMomContextLines(
      lastMomFacts([rec({ date: new Date("2026-10-20T19:30:00Z"), redScore: null, yellowScore: null })], { now: NOW, organisersPick: false }),
    ).join("\n");
    expect(none).toContain("no score recorded");
    const draw = lastMomContextLines(
      lastMomFacts([rec({ date: new Date("2026-10-20T19:30:00Z"), redScore: 4, yellowScore: 4 })], { now: NOW, organisersPick: false }),
    ).join("\n");
    expect(draw).toContain("Red 4, Yellow 4 (a draw)");
  });

  it("an open vote is named by date, with no names from it", () => {
    const f = lastMomFacts(
      [
        rec({ date: new Date("2026-11-08T19:30:00Z"), announced: false, tally: [{ userId: "u-sait", name: "Sait", votes: 4 }] }),
        rec({ date: new Date("2026-10-20T19:30:00Z") }),
      ],
      { now: NOW, organisersPick: false },
    );
    const text = lastMomContextLines(f).join("\n");
    expect(text).toContain("Sun 8 Nov");
    expect(text).toMatch(/still open/);
    expect(text).not.toContain("Sait");
  });

  // The live check: "who won MoM last week?" with the last one three weeks
  // back drew NO_ANSWER. The block says it is the latest there is.
  it("says it is the latest one, to give with its date whatever day or week is asked", () => {
    const f = lastMomFacts([rec({ date: new Date("2026-10-20T19:30:00Z") })], { now: NOW, organisersPick: false });
    expect(lastMomContextLines(f).join("\n")).toMatch(/No match after it has a Man of the Match, so it is the latest one[^\n]*with its date/);
  });

  it("none yet says so plainly; no facts at all prints nothing", () => {
    expect(lastMomContextLines({ last: null, openVoteDate: null }).join("\n")).toMatch(/LAST MAN OF THE MATCH: none decided yet/);
    expect(lastMomContextLines(undefined)).toEqual([]);
  });
});
