/**
 * WHEN AN IN IS HELD BACK IN A MONTHLY CLUB (Vets, 2026-11-03; narrowed on
 * review of #502). Only when the match's month has NO SquadMonth at all:
 * a month in sign-up, priced, running, held or closed behaves exactly as
 * before (the sign-up flow owns those).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  match: { findUnique: vi.fn() },
  squadMonth: { findFirst: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { monthNotStartedFor } from "@/lib/month-not-started";

const match = (squadMode: string) => ({
  id: "m1",
  date: new Date("2026-12-07T20:30:00Z"),
  activityId: "act",
  activity: { orgId: "org", org: { squadMode } },
});

beforeEach(() => vi.clearAllMocks());

describe("monthNotStartedFor", () => {
  it("a monthly club with no month row for the match's month: held back", async () => {
    dbMock.match.findUnique.mockResolvedValue(match("monthly"));
    dbMock.squadMonth.findFirst.mockResolvedValue(null);
    expect(await monthNotStartedFor("m1")).toBe(true);
    expect(dbMock.squadMonth.findFirst).toHaveBeenCalledWith({
      where: { orgId: "org", activityId: "act", monthStart: new Date("2026-12-01T00:00:00.000Z") },
      select: { id: true },
    });
  });

  it.each(["open", "priced", "running", "held", "closed"])("a month in status %s: not held back (as on main)", async (status) => {
    dbMock.match.findUnique.mockResolvedValue(match("monthly"));
    dbMock.squadMonth.findFirst.mockResolvedValue({ id: "sm", status });
    expect(await monthNotStartedFor("m1")).toBe(false);
  });

  it("a weekly club is never held back, and asks nothing about months", async () => {
    dbMock.match.findUnique.mockResolvedValue(match("weekly"));
    expect(await monthNotStartedFor("m1")).toBe(false);
    expect(dbMock.squadMonth.findFirst).not.toHaveBeenCalled();
  });

  it("a match it cannot find is not held back", async () => {
    dbMock.match.findUnique.mockResolvedValue(null);
    expect(await monthNotStartedFor("m1")).toBe(false);
  });
});
