/**
 * The seed nudge's counts and a partner club's guest (review of the
 * cross-club stack). With no guest involved the counts are EXACTLY what
 * they were before the guests existed, including a confirmed attendee who
 * has no membership row; a guest is left out of both counts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  rating: { findFirst: vi.fn() },
  membership: { findMany: vi.fn() },
  botJob: { findFirst: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));

import { loadSeedState } from "../seed-nudge";

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.rating.findFirst.mockResolvedValue(null);
  dbMock.botJob.findFirst.mockResolvedValue(null);
});

describe("loadSeedState", () => {
  it("no guest: a confirmed attendee without a membership row still counts, as before", async () => {
    dbMock.membership.findMany.mockResolvedValue([
      { userId: "a", seedRating: 6, leftAt: null, guestFromOrgId: null },
      { userId: "b", seedRating: null, leftAt: null, guestFromOrgId: null },
    ]);
    const s = await loadSeedState("org", ["a", "b", "no-row"]);
    expect(s.confirmed).toEqual({ total: 3, seeded: 1 });
    expect(s.active).toEqual({ total: 2, seeded: 1 });
  });

  it("a guest is left out of both counts", async () => {
    dbMock.membership.findMany.mockResolvedValue([
      { userId: "a", seedRating: 6, leftAt: null, guestFromOrgId: null },
      { userId: "g", seedRating: null, leftAt: null, guestFromOrgId: "sutton" },
    ]);
    const s = await loadSeedState("org", ["a", "g"]);
    expect(s.confirmed).toEqual({ total: 1, seeded: 1 });
    expect(s.active).toEqual({ total: 1, seeded: 1 });
  });
});
