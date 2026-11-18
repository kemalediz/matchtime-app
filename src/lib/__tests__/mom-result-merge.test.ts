/**
 * A STORED MAN OF THE MATCH RESULT ACROSS A PLAYER MERGE (review of #608,
 * rounds 3 and 4). Its user ids decide who the win is credited to, so a
 * merge MAPS them, in the stored winners and in the tally. Both players in
 * one result become one tally entry with their votes summed (a count of the
 * same person), but the WINNERS are only mapped, never recomputed from the
 * merged tally: "Alex 3, Pete 2, Pete S 2" stays Alex's win. A merged result
 * is marked `merged`, because its counts no longer match what was posted.
 * One rewrite (`mergeMomResultIds`) for both merge paths.
 */
import { describe, expect, it, vi } from "vitest";
import { mergeMomResultIds, rekeyStoredMomResults } from "../mom-result-merge";
import { momCredit, type MomMatchRecord } from "../pipeline/last-mom";
import type { MomAnnouncedResult } from "../mom-announce-rules";

const KEEP = "u-keep";
const DROP = "u-drop";
/** A stored vote result, as the claim writes it: the tally and its winners. */
const vote = (winners: string[], ...t: Array<[string, string, number]>): MomAnnouncedResult => ({
  v: 1,
  kind: "vote",
  tally: t.map(([userId, name, votes]) => ({ userId, name, votes })),
  winners,
});
const at = new Date("2026-10-01T20:00:00Z");
const posted = (r: MomAnnouncedResult): MomMatchRecord => ({
  date: at,
  teamLabels: ["Red", "Yellow"],
  redScore: 1,
  yellowScore: 0,
  tally: [],
  announced: true,
  postedAt: at,
  announcedResult: r,
  voteClosesAt: at,
  nextFixtureAt: null,
  isHistorical: false,
  announceable: true,
});
const credited = (r: MomAnnouncedResult) => momCredit(posted(r), new Date("2026-11-16T00:00:00Z"), false).map((w) => w.userId);

describe("mergeMomResultIds", () => {
  it("the dropped player's entry and win become the kept player's; counts unchanged, so not marked merged", () => {
    expect(mergeMomResultIds(vote([DROP], [DROP, "Uncle Najib", 3], ["u-x", "Mo", 1]), DROP, KEEP)).toEqual(vote([KEEP], [KEEP, "Uncle Najib", 3], ["u-x", "Mo", 1]));
  });

  it("a pick moves too", () => {
    expect(mergeMomResultIds({ v: 1, kind: "pick", winner: { userId: DROP, name: "Najib" } }, DROP, KEEP)).toEqual({ v: 1, kind: "pick", winner: { userId: KEEP, name: "Najib" } });
  });

  it("BOTH in one result: one tally entry, votes summed; the winners are only MAPPED, and it is marked merged", () => {
    expect(mergeMomResultIds(vote(["u-x"], ["u-x", "Alex", 3], [KEEP, "Pete", 2], [DROP, "Pete S", 2]), DROP, KEEP)).toEqual({
      ...vote(["u-x"], [KEEP, "Pete", 4], ["u-x", "Alex", 3]),
      merged: true,
    });
  });

  it("when one of the merged players is a WINNER, his shown count changed: marked winnerMerged too", () => {
    expect(mergeMomResultIds(vote([KEEP], [KEEP, "Pete", 3], [DROP, "Pete S", 1], ["u-x", "Alex", 2]), DROP, KEEP)).toEqual({
      ...vote([KEEP], [KEEP, "Pete", 4], ["u-x", "Alex", 2]),
      merged: true,
      winnerMerged: true,
    });
  });

  it("the reviewers' case: Alex 3, Pete 2, Pete S 2 is still ALEX's win after merging the two Petes", () => {
    const merged = mergeMomResultIds(vote(["u-x"], ["u-x", "Alex", 3], [KEEP, "Pete", 2], [DROP, "Pete S", 2]), DROP, KEEP);
    expect(credited(merged)).toEqual(["u-x"]);
  });

  it("a shared win between the two records of one person becomes that person's win, once", () => {
    const merged = mergeMomResultIds(vote([KEEP, DROP], [KEEP, "Pete", 2], [DROP, "Pete S", 2], ["u-x", "Alex", 1]), DROP, KEEP);
    expect(merged.kind === "vote" && merged.winners).toEqual([KEEP]);
    expect(credited(merged)).toEqual([KEEP]);
  });

  it("a shared win with someone else stays shared", () => {
    const merged = mergeMomResultIds(vote([DROP, "u-x"], [DROP, "Pete S", 2], ["u-x", "Alex", 2], [KEEP, "Pete", 1]), DROP, KEEP);
    expect(credited(merged).sort()).toEqual([KEEP, "u-x"].sort());
  });

  it("a result naming neither is returned unchanged", () => {
    const r = vote(["u-x"], ["u-x", "Mo", 3]);
    expect(mergeMomResultIds(r, DROP, KEEP)).toBe(r);
  });
});

describe("rekeyStoredMomResults: the merge step on a transaction", () => {
  function tx(opts: { table: boolean; rows: Array<{ matchId: string; result: unknown }> }) {
    const updates: Array<{ matchId: string; result: unknown }> = [];
    const queries: string[] = [];
    return {
      updates,
      queries,
      client: {
        $queryRawUnsafe: vi.fn(async (sql: string) => {
          queries.push(sql);
          if (sql.includes("to_regclass")) return [{ t: opts.table ? "MoMAnnouncement" : null }];
          return opts.rows;
        }),
        moMAnnouncement: {
          update: vi.fn(async ({ where, data }: { where: { matchId: string }; data: { result: unknown } }) => {
            updates.push({ matchId: where.matchId, result: data.result });
            return {};
          }),
        },
      },
    };
  }

  it("rewrites every stored result naming the dropped player", async () => {
    const t = tx({ table: true, rows: [{ matchId: "m1", result: vote([DROP], [DROP, "N", 3]) }, { matchId: "m2", result: vote(["u-x"], ["u-x", "X", 3], [KEEP, "K", 1], [DROP, "N", 1]) }] });
    expect(await rekeyStoredMomResults(t.client, DROP, KEEP)).toBe(2);
    expect(t.updates).toEqual([
      { matchId: "m1", result: vote([KEEP], [KEEP, "N", 3]) },
      { matchId: "m2", result: { ...vote(["u-x"], ["u-x", "X", 3], [KEEP, "K", 2]), merged: true } },
    ]);
  });

  it("before the migration (no table) it does nothing, and never runs a query that would abort the transaction", async () => {
    const t = tx({ table: false, rows: [] });
    expect(await rekeyStoredMomResults(t.client, DROP, KEEP)).toBe(0);
    expect(t.queries).toHaveLength(1);
    expect(t.updates).toEqual([]);
  });

  it("a client without raw queries is left alone", async () => {
    expect(await rekeyStoredMomResults({}, DROP, KEEP)).toBe(0);
  });
});
