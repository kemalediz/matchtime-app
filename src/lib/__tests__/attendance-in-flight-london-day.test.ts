/**
 * THE "PREVIOUS MATCH STILL IN FLIGHT" BLOCK READS THE LONDON DAY (club
 * summary, slice B4, decision K5).
 *
 * `registerAttendance` refuses a later match while a live match dated before
 * today is not completed: the selector's own block, as a query
 * (`inFlightWhere`, next-match.ts). Before B4 "today" began at UTC midnight
 * here, while the posting rule used the London day, so at 00:30 BST last
 * night's unfinished match did not block yet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ lastInFlightWhere: null as unknown }));

vi.mock("../db", () => {
  const db: Record<string, unknown> = {
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
  return {
    db: Object.assign(db, {
      match: {
        findUnique: async () => ({
          id: "next-week",
          maxPlayers: 14,
          date: new Date("2026-07-21T20:30:00.000Z"),
          activity: { orgId: "org1" },
        }),
        findFirst: async (args: { where: unknown }) => {
          h.lastInFlightWhere = args.where;
          return { id: "last-night", date: new Date("2026-07-14T20:30:00.000Z") };
        },
      },
    }),
  };
});

import { registerAttendance } from "../attendance";
import { inFlightWhere } from "../next-match";

beforeEach(() => {
  h.lastInFlightWhere = null;
  vi.useFakeTimers({ toFake: ["Date"] });
});

describe("registerAttendance: the in-flight block", () => {
  it("at 00:30 BST, last night's live match is yesterday's: the query asks from London midnight", async () => {
    // 00:30 BST on Wed 15 Jul = 23:30 UTC on Tue 14 Jul.
    const now = new Date("2026-07-14T23:30:00.000Z");
    vi.setSystemTime(now);
    await expect(registerAttendance("u1", "next-week", { event: { cause: "self-attendance", actorKind: "player" } })).rejects.toThrow(
      "hasn't been completed yet",
    );
    expect(h.lastInFlightWhere).toEqual(inFlightWhere("org1", now, "next-week"));
    expect((h.lastInFlightWhere as { date: { lt: Date } }).date.lt.toISOString()).toBe("2026-07-14T23:00:00.000Z");
  });
});
