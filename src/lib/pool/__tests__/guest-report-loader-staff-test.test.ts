/**
 * The Guest players page and its CSV leave MatchTime staff test sign-ups
 * out (`PoolProfile.staffTest`, round 2 of #607): their games, their cards
 * and the offers they were sent are in none of the club's numbers. The
 * other callers (an invitation, a match's guest card) still see everyone
 * they ask about.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  db: {
    membership: { findMany: vi.fn() },
    guestPlace: { findMany: vi.fn() },
    poolAsk: { findMany: vi.fn() },
    partnerAsk: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    poolProfile: { findMany: vi.fn() },
    clubInvitation: { findMany: vi.fn() },
    attendance: { findMany: vi.fn() },
    poolBlock: { findMany: vi.fn() },
    match: { findMany: vi.fn() },
    organisation: { findMany: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock("../../db", () => dbMock);

import { loadGuestFacts } from "../guest-report-loader";

const KICKOFF = new Date("2026-11-10T19:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(dbMock.db)) for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  dbMock.db.organisation.findUnique.mockResolvedValue(null);
  dbMock.db.guestPlace.findMany.mockImplementation(async (a: { where: { orgId: unknown } }) =>
    a.where.orgId === "org-1"
      ? [
          { userId: "u-guest", matchId: "m1", source: "pool", fromOrgId: null, result: "played", settledAt: KICKOFF },
          { userId: "u-staff", matchId: "m1", source: "pool", fromOrgId: null, result: "played", settledAt: KICKOFF },
        ]
      : [],
  );
  dbMock.db.poolProfile.findMany.mockImplementation(async (a: { where: Record<string, unknown> }) =>
    a.where.staffTest === true ? [{ userId: "u-staff" }] : [{ userId: "u-guest", status: "active", sports: [] }, { userId: "u-staff", status: "active", sports: [] }],
  );
  dbMock.db.user.findMany.mockResolvedValue([
    { id: "u-guest", name: "Ali Guest" },
    { id: "u-staff", name: "Kemal Test" },
  ]);
  dbMock.db.match.findMany.mockResolvedValue([
    { id: "m1", date: KICKOFF, status: "COMPLETED", activity: { orgId: "org-1", venue: "Pitch", matchDurationMins: 60, sport: { id: "s", name: "Football" } } },
  ]);
  dbMock.db.poolAsk.findMany.mockResolvedValue([{ matchId: "m1", status: "filled", _count: { offers: 1 } }]);
});

describe("loadGuestFacts: staff tests on the Guest players page and CSV", () => {
  it("left out of the people, the games and the offers an ask reached", async () => {
    const facts = await loadGuestFacts("org-1", { report: true, leaveOutStaffTests: true, now: KICKOFF });
    expect(facts.people.map((p) => p.userId)).toEqual(["u-guest"]);
    expect(new Set(facts.games.map((g) => g.userId))).toEqual(new Set(["u-guest"]));
    const ask = dbMock.db.poolAsk.findMany.mock.calls[0][0] as { select: { _count: { select: { offers: { where: Record<string, unknown> } } } } };
    expect(ask.select._count.select.offers.where).toEqual({ sentAt: { not: null }, userId: { notIn: ["u-staff"] } });
  });

  it("an invitation or a match card asking about a person still sees him", async () => {
    const facts = await loadGuestFacts("org-1", { userIds: ["u-staff"], now: KICKOFF });
    expect(facts.people.map((p) => p.userId)).toContain("u-staff");
    expect(dbMock.db.poolProfile.findMany.mock.calls.some((c) => (c[0] as { where: Record<string, unknown> }).where.staffTest === true)).toBe(false);
  });
});
