/**
 * The once-an-hour claim behind the monthly played-games sweep
 * (`claimHourlySweep`, src/lib/monthly-week.ts).
 *
 * DISK IO, 2026-11-25. It used to claim the hour by INSERTing the hour's
 * key on EVERY poll (every 30 seconds) and reading the unique violation as
 * "already claimed". A failed INSERT still writes WAL (the heap tuple, its
 * index entries and the abort), so a monthly club wrote WAL twice a minute
 * around the clock. With Supabase's `archive_timeout` of 120 s, any WAL in
 * a two-minute window forces a whole 16 MB WAL segment to disk, so that one
 * failing INSERT kept the database writing a segment every two minutes
 * even when nothing else happened (measured on prod: 13 failed inserts and
 * 4 segment switches in 6-8 quiet minutes).
 *
 * The claim now READS first and inserts only when the hour is unclaimed,
 * so 119 of the hour's 120 polls write nothing at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const existing = new Set<string>();
const create = vi.fn(async ({ data }: { data: { key: string } }) => {
  if (existing.has(data.key)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
  existing.add(data.key);
  return data;
});
const findUnique = vi.fn(async ({ where }: { where: { key: string } }) => (existing.has(where.key) ? { id: "x" } : null));
const deleteMany = vi.fn(async () => ({ count: 0 }));

vi.mock("../db", () => ({
  db: {
    sentNotification: {
      create: (a: { data: { key: string } }) => create(a),
      findUnique: (a: { where: { key: string } }) => findUnique(a),
      deleteMany: () => deleteMany(),
    },
  },
}));

import { claimHourlySweep } from "../monthly-week";

const NOW = new Date("2026-11-25T08:10:00Z");

beforeEach(() => {
  existing.clear();
  create.mockClear();
  findUnique.mockClear();
  deleteMany.mockClear();
});

describe("claimHourlySweep", () => {
  it("claims the first poll of the hour and writes the hour's key", async () => {
    expect(await claimHourlySweep("org1", NOW)).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect([...existing]).toEqual(["org-org1:monthly-played-sweep:2026-11-25T08"]);
  });

  it("every later poll of the same hour returns false WITHOUT attempting an insert (no WAL)", async () => {
    await claimHourlySweep("org1", NOW);
    create.mockClear();
    deleteMany.mockClear();
    for (let s = 30; s < 50 * 60; s += 30) {
      expect(await claimHourlySweep("org1", new Date(NOW.getTime() + s * 1000))).toBe(false);
    }
    expect(create).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("the next hour is claimed again", async () => {
    await claimHourlySweep("org1", NOW);
    expect(await claimHourlySweep("org1", new Date("2026-11-25T09:00:05Z"))).toBe(true);
  });

  it("losing a race to another poll (the insert hits the unique key) is still 'not mine'", async () => {
    findUnique.mockImplementationOnce(async () => null);
    existing.add("org-org1:monthly-played-sweep:2026-11-25T08");
    expect(await claimHourlySweep("org1", NOW)).toBe(false);
  });

  it("logs a failed claim, but not a lost race (P2002)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockImplementationOnce(async () => null);
    existing.add("org-org1:monthly-played-sweep:2026-11-25T08");
    await claimHourlySweep("org1", NOW);
    expect(spy).not.toHaveBeenCalled();
    create.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    expect(await claimHourlySweep("org1", new Date("2026-11-25T10:00:00Z"))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
