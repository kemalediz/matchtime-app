/**
 * The thin I/O half of referral badges (slice G4), with the database
 * stubbed: what it asks for and what it writes. The real database is
 * covered by e2e/sim/pool/referral-badges.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  profiles: [] as Array<Record<string, unknown>>,
  places: [] as Array<Record<string, unknown>>,
  games: [] as Array<Record<string, unknown>>,
  updates: [] as unknown[],
  profileQueries: 0,
}));

vi.mock("../../db", () => ({
  db: {
    poolProfile: {
      findMany: async () => (state.profileQueries++, state.profiles),
      updateMany: async (a: unknown) => (state.updates.push(a), { count: 1 }),
      findUnique: async () => null,
    },
    guestPlace: { findMany: async () => state.places },
    attendance: { findMany: async () => state.games, count: async () => 0 },
    membership: { findMany: async () => [] },
    badgeAnnouncement: { findMany: async () => [] },
  },
}));

import { loadClubReferralAwards, stampPlayedReferrals } from "../referrals";

beforeEach(() => {
  state.profiles = [];
  state.places = [];
  state.games = [];
  state.updates = [];
  state.profileQueries = 0;
});

describe("stampPlayedReferrals", () => {
  it("nobody waiting: one query, nothing written", async () => {
    expect(await stampPlayedReferrals(new Date())).toEqual({ counted: 0 });
    expect(state.profileQueries).toBe(1);
    expect(state.updates).toEqual([]);
  });

  it("stamps only the friend who has played, compare-and-set on a still-unstamped row", async () => {
    const now = new Date("2026-10-24T20:00:00Z");
    state.profiles = [
      { id: "p-bea", userId: "bea", referrerUserId: "ali" },
      { id: "p-cem", userId: "cem", referrerUserId: "ali" },
    ];
    state.places = [
      { userId: "bea", matchId: "m1", result: "played", settledAt: now },
      { userId: "cem", matchId: "m2", result: "played", settledAt: null },
    ];
    state.games = [{ userId: "cem", matchId: "m2" }];
    expect(await stampPlayedReferrals(now)).toEqual({ counted: 1 });
    expect(state.updates).toEqual([{ where: { id: "p-bea", referralCountedAt: null, referrerUserId: { not: null } }, data: { referralCountedAt: now } }]);
  });
});

describe("loadClubReferralAwards", () => {
  it("a club none of whose members brought anyone: one query, nothing", async () => {
    expect(await loadClubReferralAwards("fnf", new Set(["pete"]))).toEqual({ awards: [], silent: [] });
    expect(state.profileQueries).toBe(1);
  });

  it("a club with no members: no query at all", async () => {
    expect(await loadClubReferralAwards("fnf", new Set())).toEqual({ awards: [], silent: [] });
    expect(state.profileQueries).toBe(0);
  });
});
