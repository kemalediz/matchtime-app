/**
 * A MERGE NEVER LOSES A POSTED RESULT THAT HAS NO STORED RECORD (review of
 * #608, round 5). Such a result is read back from the post's own words, by
 * name. A merge removes the dropped player's name from the match, so after
 * it the read-back fails and the winner would be re-counted from merged
 * votes. So, BEFORE a merge remaps anything, every posted match the dropped
 * player is part of with no record has its record stored from the post's
 * text (the same exact re-render rule), and the merge then remaps it like any
 * other stored result.
 */
import { describe, expect, it, vi } from "vitest";
import { buildMomAnnouncement } from "../mom-announcement";
import { storeMomRecordsFromPostText } from "../mom-result-merge";

const DROP = "u-drop";
const text = buildMomAnnouncement({
  mvpLabel: "Man of the Match",
  activityName: "Tuesday",
  lang: "en",
  tally: [{ name: "Alex", votes: 3 }, { name: "Uncle Najib", votes: 2 }],
});

function fakeTx(opts: { table?: boolean; existing?: string[]; text?: string | null }) {
  const created: Array<{ matchId: string; result: unknown; announcedAt: Date }> = [];
  const people = [
    { matchId: "m1", user: { id: "u-alex", name: "Alex" } },
    { matchId: "m1", user: { id: DROP, name: "Uncle Najib" } },
  ];
  const tx = {
    $queryRawUnsafe: vi.fn(async () => [{ t: opts.table === false ? null : "MoMAnnouncement" }]),
    attendance: { findMany: vi.fn(async (a: { where: { userId?: string } }) => (a.where.userId ? [{ matchId: "m1" }] : people)) },
    teamAssignment: { findMany: vi.fn(async () => []) },
    moMVote: { findMany: vi.fn(async () => []) },
    sentNotification: {
      findMany: vi.fn(async () => (opts.text === null ? [] : [{ key: "m1:mom-announcement", text: opts.text ?? text, createdAt: new Date("2026-11-03T21:00:00Z") }])),
    },
    moMAnnouncement: {
      findMany: vi.fn(async () => (opts.existing ?? []).map((matchId) => ({ matchId }))),
      create: vi.fn(async ({ data }: { data: { matchId: string; result: unknown; announcedAt: Date } }) => {
        created.push(data);
        return {};
      }),
    },
  };
  return { tx, created };
}

describe("storeMomRecordsFromPostText", () => {
  it("stores the record from the post text, by the names as they still are, before the merge", async () => {
    const { tx, created } = fakeTx({});
    expect(await storeMomRecordsFromPostText(tx, DROP)).toBe(1);
    expect(created).toEqual([
      {
        matchId: "m1",
        announcedAt: new Date("2026-11-03T21:00:00Z"),
        result: { v: 1, kind: "vote", tally: [{ userId: "u-alex", name: "Alex", votes: 3 }, { userId: DROP, name: "Uncle Najib", votes: 2 }], winners: ["u-alex"] },
      },
    ]);
  });

  it("never touches a match that already has a record, a post with no text, or a text that does not re-render", async () => {
    expect((await storeMomRecordsFromPostText(fakeTx({ existing: ["m1"] }).tx, DROP))).toBe(0);
    expect((await storeMomRecordsFromPostText(fakeTx({ text: null }).tx, DROP))).toBe(0);
    expect((await storeMomRecordsFromPostText(fakeTx({ text: `${text} (edited)` }).tx, DROP))).toBe(0);
  });

  it("before the migration (no table) it does nothing", async () => {
    const { tx, created } = fakeTx({ table: false });
    expect(await storeMomRecordsFromPostText(tx, DROP)).toBe(0);
    expect(created).toEqual([]);
  });
});
