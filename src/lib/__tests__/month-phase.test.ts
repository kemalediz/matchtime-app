/**
 * ONE MATCH'S MONTH, FOR A DOOR WITH NO CLUB SUMMARY (club summary, slice
 * B2): the same phase function the summary runs (`monthPhaseFor`), over
 * the match's own game's month row and held key. Replaces
 * `monthNotStartedFor` (month-not-started.ts), which looked the row up on
 * its own: the IN hold is now `monthNotStartedOf` of this phase.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  match: { findUnique: vi.fn() },
  squadMonth: { findUnique: vi.fn() },
  sentNotification: { findUnique: vi.fn() },
}));
vi.mock("../db", () => ({ db: dbMock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { loadMatchMonth } from "@/lib/month-phase";
import { monthNotStartedOf } from "@/lib/monthly-gates";

const NOW = new Date("2026-12-03T12:00:00.000Z");
const match = (squadMode: string, over: Record<string, unknown> = {}) => ({
  id: "m1",
  date: new Date("2026-12-07T20:30:00Z"),
  status: "UPCOMING",
  activityId: "act",
  rollingSeededAt: null,
  activity: { orgId: "org", org: { squadMode } },
  ...over,
});
const row = (status: string, over: Record<string, unknown> = {}) => ({
  id: "sm",
  activityId: "act",
  monthStart: new Date("2026-12-01T00:00:00.000Z"),
  status,
  listOpenedAt: null,
  pricedAt: null,
  closedAt: null,
  createdAt: new Date("2026-11-20T10:00:00.000Z"),
  startedMidMonthAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.sentNotification.findUnique.mockResolvedValue(null);
});

describe("loadMatchMonth", () => {
  it("a monthly club with no month row for the game's month: none, pending, the IN held back", async () => {
    dbMock.match.findUnique.mockResolvedValue(match("monthly"));
    dbMock.squadMonth.findUnique.mockResolvedValue(null);
    const got = await loadMatchMonth("m1", NOW);
    expect(got).toMatchObject({ mode: "monthly", month: { phase: "none" }, flow: "month-pending" });
    expect(monthNotStartedOf(got!)).toBe(true);
    // The game's own month: its Activity and the London month, the table's unique key.
    expect(dbMock.squadMonth.findUnique.mock.calls[0][0].where).toEqual({
      orgId_activityId_monthStart: { orgId: "org", activityId: "act", monthStart: new Date("2026-12-01T00:00:00.000Z") },
    });
    expect(dbMock.sentNotification.findUnique.mock.calls[0][0].where).toEqual({ key: "org-org:msu:held:2026-12-01:act" });
  });

  it("a held key and no row: held, the IN held back", async () => {
    dbMock.match.findUnique.mockResolvedValue(match("monthly"));
    dbMock.squadMonth.findUnique.mockResolvedValue(null);
    dbMock.sentNotification.findUnique.mockResolvedValue({ key: "org-org:msu:held:2026-12-01:act" });
    const got = await loadMatchMonth("m1", NOW);
    expect(got).toMatchObject({ month: { phase: "held" }, flow: "month-pending" });
    expect(monthNotStartedOf(got!)).toBe(true);
  });

  it.each([
    ["open", "signup", "month-pending"],
    ["priced", "signup", "month-pending"],
    ["running", "running", "month"],
    ["closed", "closed", "month-pending"],
  ])("a month row in status %s: phase %s, flow %s, the IN not held back (as on main)", async (status, phase, flow) => {
    dbMock.match.findUnique.mockResolvedValue(match("monthly"));
    dbMock.squadMonth.findUnique.mockResolvedValue(row(status));
    const got = await loadMatchMonth("m1", NOW);
    expect(got).toMatchObject({ month: { phase, monthId: "sm" }, flow });
    expect(monthNotStartedOf(got!)).toBe(false);
  });

  it("a played game of a closed month is the month's", async () => {
    dbMock.match.findUnique.mockResolvedValue(match("monthly", { status: "COMPLETED", date: new Date("2026-12-01T20:30:00Z") }));
    dbMock.squadMonth.findUnique.mockResolvedValue(row("closed"));
    expect(await loadMatchMonth("m1", NOW)).toMatchObject({ flow: "month" });
  });

  it("a weekly club is weekly and asks nothing about months", async () => {
    dbMock.match.findUnique.mockResolvedValue(match("weekly"));
    expect(await loadMatchMonth("m1", NOW)).toEqual({ mode: "weekly", month: null, flow: "weekly" });
    expect(dbMock.squadMonth.findUnique).not.toHaveBeenCalled();
  });

  it("a match it cannot find is null", async () => {
    dbMock.match.findUnique.mockResolvedValue(null);
    expect(await loadMatchMonth("m1", NOW)).toBeNull();
  });
});
