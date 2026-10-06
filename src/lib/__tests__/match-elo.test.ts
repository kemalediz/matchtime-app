/**
 * A changed score must take the old result's Elo points back before the
 * new result's are added, exactly once (2026-10-07).
 *
 * The incident: Sutton FC, 6 October 2026, "9-6 to yellows" recorded as
 * Red 9, Yellow 6. Re-entering the right score on the dashboard would
 * have added the right result's points ON TOP of the wrong result's.
 *
 * `fake-score-db.ts` is a tiny in-memory stand-in for the Prisma calls
 * the score writers make. It keeps real state, so every assertion is about
 * what the ratings END UP as, never about which method was called.
 */
import { describe, it, expect } from "vitest";
import { computeEloDeltas, type PlayerEloInput } from "../elo";
import { parseEloApplied, reconcileMatchElo, setMatchScore, ScoreMovedError } from "../match-elo";
import { fakeScoreDb as fakeDb, type FakeMatch } from "./fake-score-db";

const RED = ["r1", "r2", "r3"];
const YELLOW = ["y1", "y2", "y3"];
const START: Record<string, number> = { r1: 1010, r2: 1040, r3: 980, y1: 1000, y2: 960, y3: 1075 };
const TEAMS = [
  ...RED.map((userId) => ({ userId, team: "RED" as const })),
  ...YELLOW.map((userId) => ({ userId, team: "YELLOW" as const })),
];

function unscored(over: Partial<FakeMatch> = {}): FakeMatch {
  return {
    id: "m1",
    orgId: "org-1",
    date: new Date("2026-10-06T19:30:00Z"),
    status: "TEAMS_PUBLISHED",
    redScore: null,
    yellowScore: null,
    eloApplied: null,
    teams: TEAMS,
    ...over,
  };
}

/** What the ratings should be had `red`-`yellow` been the only result. */
function expectedAfter(start: Record<string, number>, red: number, yellow: number): Record<string, number> {
  const inputs: PlayerEloInput[] = TEAMS.map((t) => ({ ...t, matchRating: start[t.userId] }));
  return Object.fromEntries(computeEloDeltas(inputs, red, yellow).map((d) => [d.userId, d.after]));
}

async function score(db: never, red: number, yellow: number) {
  await setMatchScore({ db, matchId: "m1", red, yellow });
  return reconcileMatchElo({ db, matchId: "m1" });
}

describe("a first score", () => {
  it("adds the result's points and stores exactly what it wrote", async () => {
    const f = fakeDb({ matches: [unscored()], ratings: { ...START } });
    const res = await score(f.db, 9, 6);
    expect(res).toMatchObject({ status: "applied", moved: 6 });
    expect(Object.fromEntries(f.ratings)).toEqual(expectedAfter(START, 9, 6));
    const stored = parseEloApplied(f.matches.get("m1")!.eloApplied)!;
    expect(stored.target).toEqual({ red: 9, yellow: 6 });
    expect(stored.applied).toMatchObject({ red: 9, yellow: 6 });
    expect(stored.applied!.deltas).toHaveLength(6);
    expect(f.matches.get("m1")!.status).toBe("COMPLETED");
  });
});

describe("a changed score", () => {
  it("leaves the ratings exactly where the right result alone would have put them", async () => {
    const f = fakeDb({ matches: [unscored()], ratings: { ...START } });
    await score(f.db, 9, 6);
    const res = await score(f.db, 6, 9);
    expect(res).toMatchObject({ status: "corrected", moved: 6 });
    expect(Object.fromEntries(f.ratings)).toEqual(expectedAfter(START, 6, 9));
  });

  it("is exact even after ANOTHER match has moved the same players since", async () => {
    // The stored points are what makes this possible: nothing is worked
    // out backwards from ratings that have moved again.
    const f = fakeDb({ matches: [unscored()], ratings: { ...START } });
    await score(f.db, 9, 6);
    f.ratings.set("r1", f.ratings.get("r1")! + 17); // some later result
    f.ratings.set("y2", f.ratings.get("y2")! - 17);
    const afterWrong = Object.fromEntries(f.ratings);
    const wrong = parseEloApplied(f.matches.get("m1")!.eloApplied)!.applied!.deltas!;
    await score(f.db, 6, 9);
    // Each player: the wrong points off, then the right result's points
    // computed from the ratings as they then stood.
    const base: Record<string, number> = { ...afterWrong };
    for (const d of wrong) base[d.userId] -= d.delta;
    expect(Object.fromEntries(f.ratings)).toEqual(expectedAfter(base, 6, 9));
  });

  it("going there and back again returns every rating to where it started", async () => {
    const f = fakeDb({ matches: [unscored()], ratings: { ...START } });
    await score(f.db, 9, 6);
    const once = Object.fromEntries(f.ratings);
    await score(f.db, 6, 9);
    await score(f.db, 9, 6);
    expect(Object.fromEntries(f.ratings)).toEqual(once);
  });
});

describe("exactly once", () => {
  it("saving the SAME score again moves nothing", async () => {
    const f = fakeDb({ matches: [unscored()], ratings: { ...START } });
    await score(f.db, 9, 6);
    const once = Object.fromEntries(f.ratings);
    const res = await score(f.db, 9, 6);
    expect(res.status).toBe("unchanged");
    expect(Object.fromEntries(f.ratings)).toEqual(once);
  });

  it("reconciling twice in a row moves nothing the second time", async () => {
    const f = fakeDb({ matches: [unscored()], ratings: { ...START } });
    await score(f.db, 9, 6);
    await setMatchScore({ db: f.db, matchId: "m1", red: 6, yellow: 9 });
    await reconcileMatchElo({ db: f.db, matchId: "m1" });
    const settled = Object.fromEntries(f.ratings);
    expect((await reconcileMatchElo({ db: f.db, matchId: "m1" })).status).toBe("unchanged");
    expect(Object.fromEntries(f.ratings)).toEqual(settled);
  });

  it("a reconcile that never ran is made good by the next one", async () => {
    // The score write and the Elo are two transactions on purpose. If
    // the second is lost, the stored record still describes the OLD
    // result, so a later reconcile corrects from it.
    const f = fakeDb({ matches: [unscored()], ratings: { ...START } });
    await score(f.db, 9, 6);
    await setMatchScore({ db: f.db, matchId: "m1", red: 6, yellow: 9 }); // reconcile lost
    await setMatchScore({ db: f.db, matchId: "m1", red: 6, yellow: 9 }); // somebody saves again
    await reconcileMatchElo({ db: f.db, matchId: "m1" });
    expect(Object.fromEntries(f.ratings)).toEqual(expectedAfter(START, 6, 9));
  });
});

describe("a match scored before the points were stored", () => {
  /** A match the OLD code scored: points added, nothing recorded. */
  function legacy(red: number, yellow: number) {
    return {
      match: unscored({ status: "COMPLETED", redScore: red, yellowScore: yellow }),
      ratings: expectedAfter(START, red, yellow),
    };
  }

  it("saving the same score again does NOT add its points a second time", async () => {
    // What `updateMatchScore` did until today.
    const l = legacy(9, 6);
    const f = fakeDb({ matches: [l.match], ratings: { ...l.ratings } });
    const res = await score(f.db, 9, 6);
    expect(res.status).toBe("unchanged");
    expect(Object.fromEntries(f.ratings)).toEqual(l.ratings);
  });

  it("a changed score takes the old points back when no later match has been scored", async () => {
    const l = legacy(9, 6);
    const f = fakeDb({ matches: [l.match], ratings: { ...l.ratings } });
    const res = await score(f.db, 6, 9);
    expect(res.status).toBe("corrected");
    const want = expectedAfter(START, 6, 9);
    for (const [u, r] of f.ratings) expect(Math.abs(r - want[u])).toBeLessThanOrEqual(2);
    // And from here on it is an ordinary match with stored points.
    expect(parseEloApplied(f.matches.get("m1")!.eloApplied)!.applied!.deltas).toHaveLength(6);
  });

  it("LEAVES THE RATINGS ALONE when a later match has been scored since", async () => {
    const l = legacy(9, 6);
    const laterMatch = unscored({
      id: "m2",
      date: new Date("2026-10-13T19:30:00Z"),
      status: "COMPLETED",
      redScore: 3,
      yellowScore: 3,
    });
    const f = fakeDb({ matches: [l.match, laterMatch], ratings: { ...l.ratings } });
    const res = await score(f.db, 6, 9);
    expect(res.status).toBe("legacy_left");
    expect(res.detail).toMatch(/still reflect 9-6/);
    expect(Object.fromEntries(f.ratings)).toEqual(l.ratings);
    // The score itself did change, and the stamp remembers which result
    // the ratings stand for, so a later edit cannot stack a second one.
    expect(f.matches.get("m1")).toMatchObject({ redScore: 6, yellowScore: 9 });
    expect(parseEloApplied(f.matches.get("m1")!.eloApplied)).toMatchObject({
      applied: { red: 9, yellow: 6, deltas: null },
      target: { red: 6, yellow: 9 },
    });
    const again = await score(f.db, 7, 9);
    expect(again.status).toBe("legacy_left");
    expect(Object.fromEntries(f.ratings)).toEqual(l.ratings);
  });

  it("putting the old score back after a left-alone edit is simply consistent again", async () => {
    const l = legacy(9, 6);
    const laterMatch = unscored({ id: "m2", date: new Date("2026-10-13T19:30:00Z"), redScore: 1, yellowScore: 0 });
    const f = fakeDb({ matches: [l.match, laterMatch], ratings: { ...l.ratings } });
    await score(f.db, 6, 9);
    const res = await score(f.db, 9, 6);
    expect(res.status).toBe("unchanged");
    expect(Object.fromEntries(f.ratings)).toEqual(l.ratings);
  });
});

describe("the 6 October match, as the migration leaves it", () => {
  it("a later edit is exact, because its points were filled in by hand", async () => {
    // Corrected by script that night to Red 6, Yellow 9; the migration
    // stores what that result contributed to each player.
    const corrected = expectedAfter(START, 6, 9);
    const deltas = TEAMS.map((t) => ({ userId: t.userId, delta: corrected[t.userId] - START[t.userId] }));
    const m = unscored({
      status: "COMPLETED",
      redScore: 6,
      yellowScore: 9,
      eloApplied: { applied: { red: 6, yellow: 9, deltas }, target: { red: 6, yellow: 9 } },
    });
    const later = unscored({ id: "m2", date: new Date("2026-10-13T19:30:00Z"), redScore: 2, yellowScore: 5 });
    const f = fakeDb({ matches: [m, later], ratings: { ...corrected } });
    expect((await score(f.db, 6, 9)).status).toBe("unchanged");
    expect(Object.fromEntries(f.ratings)).toEqual(corrected);
    await score(f.db, 7, 9);
    expect(Object.fromEntries(f.ratings)).toEqual(expectedAfter(START, 7, 9));
  });
});

describe("the edges", () => {
  it("a player with no membership at the club is neither written nor stored", async () => {
    const ratings = { ...START } as Record<string, number>;
    delete ratings.y3;
    const f = fakeDb({ matches: [unscored()], ratings });
    const res = await score(f.db, 4, 1);
    expect(res.moved).toBe(5);
    expect(parseEloApplied(f.matches.get("m1")!.eloApplied)!.applied!.deltas!.map((d) => d.userId)).not.toContain("y3");
    await score(f.db, 1, 4);
    await score(f.db, 4, 1);
    expect(f.ratings.has("y3")).toBe(false);
  });

  it("a match with no teams records the score and moves nobody", async () => {
    const f = fakeDb({ matches: [unscored({ teams: [] })], ratings: { ...START } });
    const res = await score(f.db, 5, 3);
    expect(res).toMatchObject({ status: "applied", moved: 0 });
    expect(Object.fromEntries(f.ratings)).toEqual(START);
    expect(f.matches.get("m1")).toMatchObject({ redScore: 5, yellowScore: 3 });
  });

  it("an unscored match is left alone", async () => {
    const f = fakeDb({ matches: [unscored()], ratings: { ...START } });
    expect((await reconcileMatchElo({ db: f.db, matchId: "m1" })).status).toBe("no_score");
  });

  it("refuses a correction decided against a score that has since changed", async () => {
    const f = fakeDb({ matches: [unscored()], ratings: { ...START } });
    await score(f.db, 9, 6);
    await score(f.db, 8, 6);
    await expect(
      setMatchScore({ db: f.db, matchId: "m1", red: 6, yellow: 9, expectPrevious: { red: 9, yellow: 6 } }),
    ).rejects.toBeInstanceOf(ScoreMovedError);
    expect(f.matches.get("m1")).toMatchObject({ redScore: 8, yellowScore: 6 });
  });

  it("treats an unreadable record as no record", () => {
    expect(parseEloApplied(null)).toBeNull();
    expect(parseEloApplied("9-6")).toBeNull();
    expect(parseEloApplied({ red: 9 })).toBeNull();
    expect(parseEloApplied({ target: { red: 9, yellow: 6 }, applied: { red: 9, yellow: 6, deltas: [{ userId: 1, delta: 2 }] } })).toBeNull();
    expect(parseEloApplied({ target: { red: 9, yellow: 6 }, applied: null })).toEqual({
      target: { red: 9, yellow: 6 },
      applied: null,
    });
  });
});

// ── Review of PR #214, 2026-10-07 ──────────────────────────────────────

describe("a first score whose Elo pass never ran is PENDING, not legacy (review item 1)", () => {
  it("a correction after a lost first pass applies the right result once, and takes nothing back", async () => {
    // 9-6 is written, the Elo pass throws (timeout, dropped connection),
    // ratings never move. The correction must not take back points that
    // were never added.
    const f = fakeDb({ matches: [unscored()], ratings: { ...START } });
    await setMatchScore({ db: f.db, matchId: "m1", red: 9, yellow: 6 }); // reconcile lost
    expect(Object.fromEntries(f.ratings)).toEqual(START);
    const res = await score(f.db, 6, 9);
    expect(res.status).toBe("applied");
    expect(Object.fromEntries(f.ratings)).toEqual(expectedAfter(START, 6, 9));
  });

  it("saving the same score again after a lost first pass applies it", async () => {
    const f = fakeDb({ matches: [unscored()], ratings: { ...START } });
    await setMatchScore({ db: f.db, matchId: "m1", red: 9, yellow: 6 }); // reconcile lost
    const res = await score(f.db, 9, 6);
    expect(res.status).toBe("applied");
    expect(Object.fromEntries(f.ratings)).toEqual(expectedAfter(START, 9, 6));
    // And only once.
    await score(f.db, 9, 6);
    expect(Object.fromEntries(f.ratings)).toEqual(expectedAfter(START, 9, 6));
  });

  it("the reviewer's case: four players on 1000", async () => {
    const four = { r1: 1000, r2: 1000, y1: 1000, y2: 1000 };
    const teams = [
      { userId: "r1", team: "RED" as const },
      { userId: "r2", team: "RED" as const },
      { userId: "y1", team: "YELLOW" as const },
      { userId: "y2", team: "YELLOW" as const },
    ];
    const f = fakeDb({ matches: [unscored({ teams })], ratings: { ...four } });
    await setMatchScore({ db: f.db, matchId: "m1", red: 9, yellow: 6 }); // reconcile lost
    await score(f.db, 6, 9);
    expect(Object.fromEntries(f.ratings)).toEqual({ r1: 974, r2: 974, y1: 1026, y2: 1026 });
  });

  it("writes the ratings in one pass, in a fixed order, after locking them in that order", async () => {
    const f = fakeDb({ matches: [unscored()], ratings: { ...START } });
    await score(f.db, 9, 6);
    f.log.length = 0;
    await score(f.db, 6, 9);
    const writes = f.log.filter((l) => l.startsWith("rating:")).map((l) => l.slice("rating:".length));
    expect(writes).toEqual([...writes].sort());
    expect(new Set(writes).size).toBe(writes.length); // one write per player, not two
    expect(f.log.indexOf("lock:memberships")).toBeGreaterThan(-1);
    expect(f.log.indexOf("lock:memberships")).toBeLessThan(f.log.findIndex((l) => l.startsWith("rating:")));
  });
});

describe("the legacy guard is about WHEN a score was written, not only kickoff (review item 2)", () => {
  it("leaves the ratings alone when an EARLIER match was scored after this one", async () => {
    const carried = expectedAfter(START, 9, 6);
    const thisOne = unscored({ status: "COMPLETED", redScore: 9, yellowScore: 6, updatedAt: new Date("2026-10-06T21:00:00Z") });
    const earlierKickoffScoredLater = unscored({
      id: "m0",
      date: new Date("2026-09-29T19:30:00Z"),
      status: "COMPLETED",
      redScore: 2,
      yellowScore: 1,
      updatedAt: new Date("2026-10-07T09:00:00Z"),
    });
    const f = fakeDb({ matches: [thisOne, earlierKickoffScoredLater], ratings: { ...carried } });
    const res = await score(f.db, 6, 9);
    expect(res.status).toBe("legacy_left");
    expect(Object.fromEntries(f.ratings)).toEqual(carried);
  });
});

describe("stored points for somebody who is no longer a member (review item 8)", () => {
  it("are left, said out loud, and everybody else is still corrected", async () => {
    const f = fakeDb({ matches: [unscored()], ratings: { ...START } });
    await score(f.db, 9, 6);
    f.ratings.delete("y3"); // merged into another record, or removed
    const res = await score(f.db, 6, 9);
    expect(res.status).toBe("corrected");
    expect(res.detail).toMatch(/1 player.*no longer.*y3/);
    expect(f.ratings.has("y3")).toBe(false);
  });
});

describe("a score changed by something that does not keep the record (review item 8)", () => {
  it("the old code editing the 6 October match after the migration is DETECTED, never double counted", async () => {
    // Migration applied, new code not yet deployed: the old dashboard
    // code changes the score and adds the new result on top, and knows
    // nothing about the stored record.
    const corrected = expectedAfter(START, 6, 9);
    const deltas = TEAMS.map((t) => ({ userId: t.userId, delta: corrected[t.userId] - START[t.userId] }));
    const m = unscored({
      status: "COMPLETED",
      redScore: 6,
      yellowScore: 9,
      eloApplied: { applied: { red: 6, yellow: 9, deltas }, target: { red: 6, yellow: 9 } },
    });
    const f = fakeDb({ matches: [m], ratings: { ...corrected } });
    // The old code's edit: score changed, 7-9's points added on top.
    const stacked = expectedAfter(corrected, 7, 9);
    Object.assign(f.matches.get("m1")!, { redScore: 7, yellowScore: 9 });
    for (const [u, r] of Object.entries(stacked)) f.ratings.set(u, r);

    // The new code, later: any save of that match.
    const res = await score(f.db, 7, 9);
    expect(res.status).toBe("legacy_left");
    expect(res.detail).toMatch(/outside/);
    expect(Object.fromEntries(f.ratings)).toEqual(stacked);
    // And it stays flagged rather than quietly "healing" on the next save.
    expect((await score(f.db, 8, 9)).status).toBe("legacy_left");
    expect(Object.fromEntries(f.ratings)).toEqual(stacked);
  });
});
