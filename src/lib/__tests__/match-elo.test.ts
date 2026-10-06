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
    expect(stored).toMatchObject({ red: 9, yellow: 6 });
    expect(stored.deltas).toHaveLength(6);
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
    const wrong = parseEloApplied(f.matches.get("m1")!.eloApplied)!.deltas!;
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
    expect(parseEloApplied(f.matches.get("m1")!.eloApplied)!.deltas).toHaveLength(6);
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
    expect(parseEloApplied(f.matches.get("m1")!.eloApplied)).toEqual({ red: 9, yellow: 6, deltas: null });
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
      eloApplied: { red: 6, yellow: 9, deltas },
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
    expect(parseEloApplied(f.matches.get("m1")!.eloApplied)!.deltas!.map((d) => d.userId)).not.toContain("y3");
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
    expect(parseEloApplied({ red: 9, yellow: 6, deltas: [{ userId: 1, delta: 2 }] })).toBeNull();
    expect(parseEloApplied({ red: 9, yellow: 6, deltas: null })).toEqual({ red: 9, yellow: 6, deltas: null });
  });
});
