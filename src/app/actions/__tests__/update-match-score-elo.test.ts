/**
 * The dashboard's score box (`updateMatchScore`) and the club's Elo
 * (2026-10-07).
 *
 * Until today the action added the entered result's Elo points every
 * time it was saved, with no memory of what it had added before. So:
 *
 *   - a score entered wrong and then corrected left the ratings carrying
 *     BOTH results;
 *   - pressing Save twice on the same score added it twice.
 *
 * These tests run the real action against an in-memory database that
 * keeps real ratings, and assert where the ratings END UP.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { computeEloDeltas, type PlayerEloInput } from "@/lib/elo";
import { fakeScoreDb, type FakeMatch } from "@/lib/__tests__/fake-score-db";

const state: { fake: ReturnType<typeof fakeScoreDb> | null } = { fake: null };
const sendRatingEmails = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "admin" } }) }));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/attendance-events", () => ({ recordAttendanceEvent: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendRatingEmails: (...a: unknown[]) => sendRatingEmails(...a) }));
vi.mock("@/lib/rolling-squad", () => ({ findCarryOverSource: vi.fn(), seedRollingSquad: vi.fn() }));
vi.mock("@/lib/db", () => ({
  // A getter, so each test gets the database it built.
  get db() {
    return state.fake!.db;
  },
}));

import { updateMatchScore } from "../matches";

const START: Record<string, number> = { r1: 1010, r2: 1040, r3: 980, y1: 1000, y2: 960, y3: 1075 };
const TEAMS = [
  ...["r1", "r2", "r3"].map((userId) => ({ userId, team: "RED" as const })),
  ...["y1", "y2", "y3"].map((userId) => ({ userId, team: "YELLOW" as const })),
];

function match(over: Partial<FakeMatch> = {}): FakeMatch {
  return {
    id: "m1",
    orgId: "org-1",
    date: new Date("2026-10-06T19:30:00Z"),
    status: "COMPLETED",
    redScore: null,
    yellowScore: null,
    eloApplied: null,
    teams: TEAMS,
    ...over,
  };
}

function expectedAfter(start: Record<string, number>, red: number, yellow: number): Record<string, number> {
  const inputs: PlayerEloInput[] = TEAMS.map((t) => ({ ...t, matchRating: start[t.userId] }));
  return Object.fromEntries(computeEloDeltas(inputs, red, yellow).map((d) => [d.userId, d.after]));
}

const ratingsNow = () => Object.fromEntries(state.fake!.ratings);

beforeEach(() => {
  vi.clearAllMocks();
  sendRatingEmails.mockResolvedValue(undefined);
  state.fake = fakeScoreDb({ matches: [match()], ratings: { ...START } });
});

describe("updateMatchScore and the club's Elo", () => {
  it("a first score adds that result's points", async () => {
    await updateMatchScore("m1", { redScore: 9, yellowScore: 6 });
    expect(state.fake!.matches.get("m1")).toMatchObject({ redScore: 9, yellowScore: 6, status: "COMPLETED" });
    expect(ratingsNow()).toEqual(expectedAfter(START, 9, 6));
  });

  it("a CORRECTED score leaves the ratings where the right result alone would have put them", async () => {
    await updateMatchScore("m1", { redScore: 9, yellowScore: 6 });
    await updateMatchScore("m1", { redScore: 6, yellowScore: 9 });
    expect(state.fake!.matches.get("m1")).toMatchObject({ redScore: 6, yellowScore: 9 });
    expect(ratingsNow()).toEqual(expectedAfter(START, 6, 9));
  });

  it("saving the SAME score twice adds its points once", async () => {
    await updateMatchScore("m1", { redScore: 9, yellowScore: 6 });
    await updateMatchScore("m1", { redScore: 9, yellowScore: 6 });
    expect(ratingsNow()).toEqual(expectedAfter(START, 9, 6));
  });

  it("re-saving the score of a match scored before points were stored adds nothing", async () => {
    // Every match scored before 2026-10-07: a score, ratings that
    // already carry it, and no record of what was written.
    const carried = expectedAfter(START, 9, 6);
    state.fake = fakeScoreDb({ matches: [match({ redScore: 9, yellowScore: 6 })], ratings: { ...carried } });
    await updateMatchScore("m1", { redScore: 9, yellowScore: 6 });
    expect(ratingsNow()).toEqual(carried);
  });

  it("asks the players to rate the match on the first score only, not on a correction", async () => {
    await updateMatchScore("m1", { redScore: 9, yellowScore: 6 });
    expect(sendRatingEmails).toHaveBeenCalledTimes(1);
    await updateMatchScore("m1", { redScore: 6, yellowScore: 9 });
    expect(sendRatingEmails).toHaveBeenCalledTimes(1);
  });

  it("tells the admin, in the club's language, when the Elo could not be recalculated", async () => {
    // An older match (points never stored) with a later match scored
    // since: the old points cannot be recovered, so the ratings are left
    // alone. That used to be a console line only (review item 2).
    const carried = expectedAfter(START, 9, 6);
    const older = match({ redScore: 9, yellowScore: 6 });
    const later = match({ id: "m2", date: new Date("2026-10-13T19:30:00Z"), redScore: 2, yellowScore: 2 });
    state.fake = fakeScoreDb({ matches: [older, later], ratings: { ...carried } });
    const en = await updateMatchScore("m1", { redScore: 6, yellowScore: 9 });
    expect(en.eloNote).toMatch(/^Score saved\. The Elo ratings were not recalculated/);
    expect(state.fake.matches.get("m1")).toMatchObject({ redScore: 6, yellowScore: 9 });
    expect(ratingsNow()).toEqual(carried);

    state.fake = fakeScoreDb({
      matches: [match({ redScore: 9, yellowScore: 6 }), { ...later }],
      ratings: { ...carried },
      language: "tr",
    });
    const tr = await updateMatchScore("m1", { redScore: 6, yellowScore: 9 });
    expect(tr.eloNote).toMatch(/^Skor kaydedildi\. Bu maç için Elo puanları yeniden hesaplanmadı/);
    expect(`${en.eloNote}${tr.eloNote}`).not.toMatch(/[\u2013\u2014]/);
  });

  it("says nothing extra on an ordinary save", async () => {
    expect((await updateMatchScore("m1", { redScore: 9, yellowScore: 6 })).eloNote).toBeNull();
    expect((await updateMatchScore("m1", { redScore: 6, yellowScore: 9 })).eloNote).toBeNull();
  });
});
