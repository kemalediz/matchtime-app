/**
 * THE ONE FIXTURE GENERATOR (2026-10-15), shared by the nightly cron
 * (`/api/cron/generate-matches`) and going live (`goLiveClub`).
 *
 * The incident: club FNF went live at 22:12 London. Its next game only
 * existed once the 00:00 UTC cron ran, so the squad list its organiser
 * pasted at 22:13 had nothing to go on and got no reply. Going live now
 * makes the club's upcoming games at once, through this same code, with
 * the cron's dedupe and the cron's skips.
 *
 * db is mocked. No network, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  activity: { findMany: vi.fn() },
  match: { findMany: vi.fn(), create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { readFileSync } from "node:fs";
import path from "node:path";
import { generateUpcomingMatches } from "../generate-upcoming-matches";
import { NIGHTLY_FIXTURE_RUN_UTC_HOUR, nextNightlyFixtureRun } from "../nightly-fixture-run";

// Thu 15 Oct 2026, 22:12 London (BST) = 21:12 UTC.
const NOW = new Date("2026-10-15T21:12:00Z");
// The next Friday 20:30 London: Fri 16 Oct 2026 = 19:30 UTC.
const FRI_KICKOFF = new Date("2026-10-16T19:30:00Z");

const org = (over: Record<string, unknown> = {}) => ({
  name: "FNF",
  dormantAt: null,
  approvalStatus: "approved",
  billingStatus: "exempt",
  ...over,
});
const activity = (over: Record<string, unknown> = {}) => ({
  id: "act-fnf",
  orgId: "org-fnf",
  name: "Football 9-a-side",
  dayOfWeek: 5,
  time: "20:30",
  venue: "Powerleague",
  isActive: true,
  deadlineHours: 5,
  feePerPlayer: 5,
  sport: { playersPerTeam: 9 },
  org: org(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.match.findMany.mockResolvedValue([]);
  dbMock.match.create.mockImplementation(async (a: { data: unknown }) => ({ id: "m-new", ...(a.data as object) }));
});

describe("generateUpcomingMatches", () => {
  it("makes the next game at the London wall clock, with the cron's places and sign-up deadline", async () => {
    dbMock.activity.findMany.mockResolvedValue([activity()]);
    const r = await generateUpcomingMatches({ now: NOW });
    expect(r.created).toBe(1);
    expect(dbMock.match.create).toHaveBeenCalledWith({
      data: {
        activityId: "act-fnf",
        date: FRI_KICKOFF,
        maxPlayers: 18,
        attendanceDeadline: new Date(FRI_KICKOFF.getTime() - 5 * 60 * 60 * 1000),
      },
    });
  });

  it("the cron's read: every club (no org filter)", async () => {
    dbMock.activity.findMany.mockResolvedValue([]);
    await generateUpcomingMatches({ now: NOW });
    expect(dbMock.activity.findMany.mock.calls[0][0].where).toEqual({ isActive: true });
  });

  it("going live's read: only that club", async () => {
    dbMock.activity.findMany.mockResolvedValue([]);
    await generateUpcomingMatches({ orgId: "org-fnf", now: NOW });
    expect(dbMock.activity.findMany.mock.calls[0][0].where).toEqual({ isActive: true, orgId: "org-fnf" });
  });

  it("the cron's dedupe: a game already in that slot is not made twice", async () => {
    dbMock.activity.findMany.mockResolvedValue([activity()]);
    dbMock.match.findMany.mockResolvedValue([
      { date: FRI_KICKOFF, activity: { orgId: "org-fnf", venue: "Powerleague", dayOfWeek: 5 } },
    ]);
    const r = await generateUpcomingMatches({ orgId: "org-fnf", now: NOW });
    expect(r.created).toBe(0);
    expect(dbMock.match.create).not.toHaveBeenCalled();
  });

  it("the cron's skips: dormant, not approved and paused clubs get nothing, and are counted", async () => {
    process.env.BILLING_ENABLED = "1";
    try {
      dbMock.activity.findMany.mockResolvedValue([
        activity({ id: "a1", org: org({ dormantAt: new Date("2026-09-01T00:00:00Z") }) }),
        activity({ id: "a2", org: org({ approvalStatus: "pending" }) }),
        activity({ id: "a3", org: org({ billingStatus: "paused" }) }),
      ]);
      const r = await generateUpcomingMatches({ now: NOW });
      expect(r).toMatchObject({ created: 0, skippedDormantOrgs: 1, skippedNotApprovedOrgs: 1 });
      expect(dbMock.match.create).not.toHaveBeenCalled();
    } finally {
      delete process.env.BILLING_ENABLED;
    }
  });

  it("the fee is NOT copied onto the match: Match.feePerPlayer is the collector's confirmed amount (payment-flow.ts)", async () => {
    dbMock.activity.findMany.mockResolvedValue([activity({ feePerPlayer: 5 })]);
    await generateUpcomingMatches({ now: NOW });
    expect(dbMock.match.create.mock.calls[0][0].data).not.toHaveProperty("feePerPlayer");
  });
});

describe("nextNightlyFixtureRun: when the cron next makes games (what the admin group's no-game reply says)", () => {
  it("the hour matches the cron's schedule in vercel.json", () => {
    const vercel = JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "..", "vercel.json"), "utf8"));
    const cron = vercel.crons.find((c: { path: string }) => c.path === "/api/cron/generate-matches");
    expect(cron.schedule).toBe(`0 ${NIGHTLY_FIXTURE_RUN_UTC_HOUR} * * *`);
  });

  it("the next 00:00 UTC strictly after now", () => {
    expect(nextNightlyFixtureRun(new Date("2026-10-15T21:13:00Z"))).toEqual(new Date("2026-10-16T00:00:00Z"));
    expect(nextNightlyFixtureRun(new Date("2026-10-16T00:00:00Z"))).toEqual(new Date("2026-10-17T00:00:00Z"));
    expect(nextNightlyFixtureRun(new Date("2026-10-16T00:30:00Z"))).toEqual(new Date("2026-10-17T00:00:00Z"));
  });
});
