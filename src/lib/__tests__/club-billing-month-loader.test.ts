/**
 * CLUB FEE BILLING, slice P1: the READ-ONLY loader that turns a club's rows
 * into `countClubMonth`'s input. Plan section 13.2 (P1) and 2A.
 *
 * The client is a hand-made fake with only find methods: any write the
 * loader tried would be a TypeError here. No database, no network.
 */
import { describe, expect, it, vi } from "vitest";
import { loadClubMonthInput, type MonthLoaderClient } from "../club-billing-month-loader";
import { countClubMonth } from "../club-billing-cycle-rules";

const NOV = { startsAt: new Date("2026-11-01T00:00:00Z"), endsAt: new Date("2026-12-01T00:00:00Z") };
const OLD = new Date("2025-01-01T00:00:00Z");

function fakeClient(over: { featureAttendance?: boolean | null } = {}) {
  const org = over.featureAttendance === null ? null : { featureAttendance: over.featureAttendance ?? true };
  return {
    organisation: { findUnique: vi.fn().mockResolvedValue(org) },
    match: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "m1",
          activityId: "tue7",
          date: new Date("2026-11-03T21:30:00Z"),
          status: "COMPLETED",
          isHistorical: false,
          redScore: null,
          yellowScore: null,
          _count: { attendances: 9 },
        },
        {
          id: "m2",
          activityId: "old",
          date: new Date("2026-11-10T21:30:00Z"),
          status: "COMPLETED",
          isHistorical: false,
          redScore: 2,
          yellowScore: 2,
          _count: { attendances: 0 },
        },
      ]),
    },
    activity: {
      findMany: vi.fn().mockResolvedValue([
        { id: "tue7", dayOfWeek: 2, time: "21:30", venue: "Goals", isActive: true, createdAt: OLD },
        { id: "old", dayOfWeek: 2, time: "21:30", venue: "Goals", isActive: false, createdAt: OLD },
      ]),
    },
    billingEvent: {
      findMany: vi.fn().mockResolvedValue([
        { type: "mt.paused", receivedAt: new Date("2026-11-15T00:00:00Z") },
        { type: "mt.resumed", receivedAt: new Date("2026-11-20T00:00:00Z") },
      ]),
    },
  };
}

describe("loadClubMonthInput", () => {
  it("null for an unknown club", async () => {
    const c = fakeClient({ featureAttendance: null });
    expect(await loadClubMonthInput(c as unknown as MonthLoaderClient, "nope", NOV)).toBeNull();
  });

  it("reads the month's non-historical matches by kickoff, with the CONFIRMED (IN) count", async () => {
    const c = fakeClient();
    await loadClubMonthInput(c as unknown as MonthLoaderClient, "org", NOV);
    const arg = c.match.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ activity: { orgId: "org" }, isHistorical: false, date: { gte: NOV.startsAt, lt: NOV.endsAt } });
    expect(arg.select._count).toEqual({ select: { attendances: { where: { status: "CONFIRMED" } } } });
  });

  it("reads active activities plus any activity with a match this month (never keyed on activityId alone)", async () => {
    const c = fakeClient();
    await loadClubMonthInput(c as unknown as MonthLoaderClient, "org", NOV);
    expect(c.activity.findMany.mock.calls[0][0].where).toEqual({
      orgId: "org",
      OR: [{ isActive: true }, { id: { in: ["tue7", "old"] } }],
    });
  });

  it("reads the club's pause and not-billable events AND the global billing-off events, up to the month's end, oldest first (H1)", async () => {
    const c = fakeClient();
    await loadClubMonthInput(c as unknown as MonthLoaderClient, "org", NOV);
    expect(c.billingEvent.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        OR: [
          { orgId: "org", type: { in: ["mt.paused", "mt.resumed", "mt.unbilled", "mt.billed", "mt.suspended", "mt.unsuspended"] } },
          { orgId: null, type: { in: ["mt.billing-off", "mt.billing-on"] } },
        ],
        receivedAt: { lt: NOV.endsAt },
      },
      orderBy: { receivedAt: "asc" },
    });
  });

  it("H1: games inside a Free spell or a billing-off spell are NOT played (only games outside them count)", async () => {
    const c = fakeClient();
    c.billingEvent.findMany.mockResolvedValue([
      { type: "mt.unbilled", receivedAt: new Date("2026-10-01T00:00:00Z") },
      { type: "mt.billed", receivedAt: new Date("2026-11-10T00:00:00Z") },
      { type: "mt.billing-off", receivedAt: new Date("2026-11-25T00:00:00Z") },
    ]);
    const input = await loadClubMonthInput(c as unknown as MonthLoaderClient, "org", NOV);
    expect(input?.pauseSpans).toEqual([
      { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-10T00:00:00Z") },
      { from: new Date("2026-11-25T00:00:00Z"), to: null },
    ]);
  });

  it("maps rows into the count's input: confirmedCount, spans, tracksAttendance, and passes now through", async () => {
    const now = new Date("2026-11-21T00:00:00Z");
    const input = await loadClubMonthInput(fakeClient({ featureAttendance: false }) as unknown as MonthLoaderClient, "org", NOV, { now });
    expect(input).toMatchObject({
      ...NOV,
      tracksAttendance: false,
      now,
      pauseSpans: [{ from: new Date("2026-11-15T00:00:00Z"), to: new Date("2026-11-20T00:00:00Z") }],
    });
    expect(input?.matches.map((m) => [m.id, m.confirmedCount])).toEqual([
      ["m1", 9],
      ["m2", 0],
    ]);
    // And it feeds the count directly.
    expect(countClubMonth(input!).played).toBe(2);
  });

  describe("games from before a held club went live (owner decision 2, 2026-10-12)", () => {
    const LIVE = new Date("2026-11-08T12:00:00Z");
    const withOrg = (org: Record<string, unknown>) => {
      const c = fakeClient();
      c.organisation.findUnique.mockResolvedValue(org);
      c.billingEvent.findMany.mockResolvedValue([]);
      return c;
    };

    it("reads the club's go-live stamp and stage beside its attendance setting", async () => {
      const c = fakeClient();
      await loadClubMonthInput(c as unknown as MonthLoaderClient, "org", NOV);
      expect(c.organisation.findUnique.mock.calls[0][0]).toEqual({
        where: { id: "org" },
        select: { featureAttendance: true, liveAt: true, approvalStatus: true, setupStage: true },
      });
    });

    for (const featureAttendance of [true, false]) {
      const kind = featureAttendance ? "tracks attendance" : "does NOT track attendance";

      it(`held then live, ${kind}: the match completed before go-live is not played, the one after is`, async () => {
        const c = withOrg({ featureAttendance, approvalStatus: "approved", setupStage: "live", liveAt: LIVE });
        const input = await loadClubMonthInput(c as unknown as MonthLoaderClient, "org", NOV);
        expect(input?.pauseSpans).toEqual([{ from: new Date(0), to: new Date(LIVE.getTime() + 1) }]);
        const count = countClubMonth(input!);
        // m1 (3 Nov, 9 IN) kicked off before go-live; m2 (10 Nov, scored) after.
        expect(count.played).toBe(1);
        expect(count.games.filter((g) => g.played).flatMap((g) => g.matchIds)).toEqual(["m2"]);
      });

      it(`still setting up, ${kind}: nothing is played, whatever was completed`, async () => {
        const c = withOrg({ featureAttendance, approvalStatus: "approved", setupStage: "setting-up", liveAt: null });
        const input = await loadClubMonthInput(c as unknown as MonthLoaderClient, "org", NOV);
        expect(input?.pauseSpans).toEqual([{ from: new Date(0), to: null }]);
        expect(countClubMonth(input!).played).toBe(0);
      });
    }

    it("a club that was never held (no stamp, stage live, or neither column read) gets no such span", async () => {
      for (const org of [
        { featureAttendance: true, approvalStatus: "approved", setupStage: "live", liveAt: null },
        { featureAttendance: true },
      ]) {
        const input = await loadClubMonthInput(withOrg(org) as unknown as MonthLoaderClient, "org", NOV);
        expect(input?.pauseSpans).toEqual([]);
        expect(countClubMonth(input!).played).toBe(2);
      }
    });

    it("the span sits beside the club's other not-charged spans, never instead of them", async () => {
      const c = withOrg({ featureAttendance: true, approvalStatus: "approved", setupStage: "live", liveAt: LIVE });
      c.billingEvent.findMany.mockResolvedValue([{ type: "mt.paused", receivedAt: new Date("2026-11-09T00:00:00Z") }]);
      const input = await loadClubMonthInput(c as unknown as MonthLoaderClient, "org", NOV);
      expect(input?.pauseSpans).toEqual([
        { from: new Date(0), to: new Date(LIVE.getTime() + 1) },
        { from: new Date("2026-11-09T00:00:00Z"), to: null },
      ]);
      expect(countClubMonth(input!).played).toBe(0);
    });
  });

  it("only ever calls find methods", async () => {
    const c = fakeClient();
    await loadClubMonthInput(c as unknown as MonthLoaderClient, "org", NOV);
    for (const model of Object.values(c)) {
      for (const name of Object.keys(model)) expect(name).toMatch(/^find/);
    }
  });
});

// Type level only (no runtime import of the app's db): the app's extended
// client must be accepted, so the month close (P2) can pass `db` as is.
type AppDb = (typeof import("../db"))["db"];
const appDbFits: AppDb extends MonthLoaderClient ? true : never = true;
void appDbFits;
