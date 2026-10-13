/**
 * The per-user cap on venue suggestion calls: 120 an hour, counted in
 * one row per person per hour. The db module is an in-memory fake; the
 * same count against a real Postgres is in e2e/web/venue-suggest.spec.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const world = vi.hoisted(() => ({
  rows: new Map<string, { key: string; userId: string; windowStart: Date; count: number }>(),
  fail: false,
  upserts: 0,
}));

vi.mock("@/lib/db", () => ({
  db: {
    venueSuggestUsage: {
      upsert: async (args: {
        where: { key: string };
        create: { key: string; userId: string; windowStart: Date; count: number };
        update: { count: { increment: number } };
      }) => {
        world.upserts += 1;
        if (world.fail) throw new Error('relation "VenueSuggestUsage" does not exist');
        const found = world.rows.get(args.where.key);
        if (found) found.count += args.update.count.increment;
        else world.rows.set(args.where.key, { ...args.create });
        return { count: world.rows.get(args.where.key)!.count };
      },
      deleteMany: async (args: { where: { userId: string; windowStart: { lt: Date } } }) => {
        let n = 0;
        for (const [key, row] of world.rows) {
          if (row.userId === args.where.userId && row.windowStart < args.where.windowStart.lt) {
            world.rows.delete(key);
            n += 1;
          }
        }
        return { count: n };
      },
    },
  },
}));

import { claimSuggestCall } from "../venue-suggest-cap";
import { VENUE_SUGGEST_CALLS_PER_USER_PER_HOUR as CAP } from "../venue-suggest-rules";

const AT = (iso: string) => new Date(iso);

beforeEach(() => {
  world.rows.clear();
  world.fail = false;
  world.upserts = 0;
});

describe("claimSuggestCall", () => {
  it("allows exactly 120 calls in an hour and refuses the 121st", async () => {
    const now = AT("2026-10-13T14:05:00Z");
    for (let i = 0; i < CAP; i++) expect(await claimSuggestCall("user-a", now), `call ${i + 1}`).toBe(true);
    expect(await claimSuggestCall("user-a", now)).toBe(false);
    expect(await claimSuggestCall("user-a", AT("2026-10-13T14:59:59Z"))).toBe(false);
  });

  it("one person's calls are not another's", async () => {
    const now = AT("2026-10-13T14:05:00Z");
    for (let i = 0; i <= CAP; i++) await claimSuggestCall("user-a", now);
    expect(await claimSuggestCall("user-a", now)).toBe(false);
    expect(await claimSuggestCall("user-b", now)).toBe(true);
  });

  it("the next hour starts again, and the old hour's row is removed", async () => {
    for (let i = 0; i <= CAP; i++) await claimSuggestCall("user-a", AT("2026-10-13T14:05:00Z"));
    await claimSuggestCall("user-b", AT("2026-10-13T14:05:00Z"));
    expect(await claimSuggestCall("user-a", AT("2026-10-13T15:00:01Z"))).toBe(true);
    // One row per person: user-a's new hour and user-b's untouched one.
    expect([...world.rows.values()].map((r) => [r.userId, r.windowStart.toISOString(), r.count])).toEqual([
      ["user-b", "2026-10-13T14:00:00.000Z", 1],
      ["user-a", "2026-10-13T15:00:00.000Z", 1],
    ]);
  });

  it("the row carries the person's id and the hour, and nothing that was typed", async () => {
    await claimSuggestCall("user-a", AT("2026-10-13T14:05:00Z"));
    expect([...world.rows.values()]).toEqual([
      { key: "user-a|2026-10-13T14:00:00.000Z", userId: "user-a", windowStart: AT("2026-10-13T14:00:00Z"), count: 1 },
    ]);
  });

  it("when the count cannot be kept (the table is missing, the database is down) the call is REFUSED, never thrown", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    world.fail = true;
    expect(await claimSuggestCall("user-a", AT("2026-10-13T14:05:00Z"))).toBe(false);
    // The error's name only: a message can carry SQL.
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/relation|VenueSuggestUsage" does not exist/);
    errors.mockRestore();
  });

  it("refuses a missing user id without touching the database", async () => {
    expect(await claimSuggestCall("", AT("2026-10-13T14:05:00Z"))).toBe(false);
    expect(world.upserts).toBe(0);
  });
});
