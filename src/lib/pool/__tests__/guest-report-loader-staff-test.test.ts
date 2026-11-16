/**
 * The Guest players page and its CSV leave MatchTime staff tests out
 * (rounds 2 to 4 of #607): their games, their cards and the offers they were
 * sent are in none of the club's numbers. Read off the rows' OWN flags
 * (`GuestPlace.staffTest`, `PoolOffer.staffTest`), so an erased staff-test
 * profile stays out, and a real person's own games stay in even when one
 * place of his was a staff test's booking. The other callers (an
 * invitation, a match's guest card) still see everyone they ask about.
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
const place = (userId: string, matchId: string, staffTest: boolean) => ({ userId, matchId, source: "pool", fromOrgId: null, result: "played", settledAt: KICKOFF, staffTest });

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(dbMock.db)) for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  dbMock.db.organisation.findUnique.mockResolvedValue(null);
  dbMock.db.guestPlace.findMany.mockImplementation(async (a: { where: { orgId: unknown } }) =>
    a.where.orgId === "org-1"
      ? [
          place("u-guest", "m1", false),
          // An erased staff test: his profile is gone, his place stays, flagged.
          place("u-staff", "m1", true),
          // A real person booked once through a staff test's friend-link sign-up.
          place("u-real", "m1", false),
          place("u-real", "m2", true),
        ]
      : [],
  );
  // No profile for u-staff any more, so no live staff-test profile either.
  dbMock.db.poolProfile.findMany.mockImplementation(async (a: { where: Record<string, unknown> }) =>
    a.where.staffTest === true
      ? []
      : [
          { userId: "u-guest", status: "active", sports: [] },
          { userId: "u-real", status: "active", sports: [] },
        ],
  );
  dbMock.db.user.findMany.mockResolvedValue([
    { id: "u-guest", name: "Ali Guest" },
    { id: "u-staff", name: "Kemal Test" },
    { id: "u-real", name: "Real Person" },
  ]);
  dbMock.db.match.findMany.mockResolvedValue(
    ["m1", "m2"].map((id) => ({ id, date: KICKOFF, status: "COMPLETED", activity: { orgId: "org-1", venue: "Pitch", matchDurationMins: 60, sport: { id: "s", name: "Football" } } })),
  );
  dbMock.db.poolAsk.findMany.mockResolvedValue([{ matchId: "m1", status: "filled", _count: { offers: 1 } }]);
  // Round 5 of #607: the real person is also this club's guest by
  // membership, and his attendance rows are on both matches. A staff-test
  // place must not come back as a "legacy" guest game through them.
  dbMock.db.membership.findMany.mockImplementation(async (a: { where: Record<string, unknown> }) =>
    "guestVia" in (a.where ?? {}) || "OR" in (a.where ?? {}) || "guestMatchId" in (a.where ?? {})
      ? [
          { userId: "u-real", guestFromOrgId: null, guestVia: "pool" },
          { userId: "u-staff", guestFromOrgId: null, guestVia: "pool" },
        ]
      : [],
  );
  const attendance = [
    { userId: "u-real", matchId: "m1", status: "CONFIRMED" },
    { userId: "u-real", matchId: "m2", status: "CONFIRMED" },
    { userId: "u-staff", matchId: "m1", status: "CONFIRMED" },
  ];
  dbMock.db.attendance.findMany.mockImplementation(async (a: { where: { userId?: { in: string[] } } }) =>
    attendance.filter((r) => !a.where?.userId || a.where.userId.in.includes(r.userId)),
  );
});

describe("loadGuestFacts: staff tests on the Guest players page and CSV", () => {
  it("an erased staff test is left out by his place's own flag; a real person keeps his own games, not the staff-test one", async () => {
    const facts = await loadGuestFacts("org-1", { report: true, leaveOutStaffTests: true, now: KICKOFF });
    expect(facts.people.map((p) => p.userId).sort()).toEqual(["u-guest", "u-real"]);
    expect(facts.games.map((g) => `${g.userId}:${g.match.matchId}`).sort()).toEqual(["u-guest:m1", "u-real:m1"]);
    const placesArgs = dbMock.db.guestPlace.findMany.mock.calls[0][0] as { select: Record<string, unknown> };
    expect(placesArgs.select).toMatchObject({ staffTest: true });
  });

  it("the offers an ask reached are read off the offer's own flag", async () => {
    await loadGuestFacts("org-1", { report: true, leaveOutStaffTests: true, now: KICKOFF });
    const ask = dbMock.db.poolAsk.findMany.mock.calls[0][0] as { select: { _count: { select: { offers: { where: Record<string, unknown> } } } } };
    expect(ask.select._count.select.offers.where).toEqual({ sentAt: { not: null }, staffTest: false });
  });

  it("an invitation or a match card asking about a person still sees him, whatever his places say", async () => {
    const facts = await loadGuestFacts("org-1", { userIds: ["u-staff"], now: KICKOFF });
    expect(facts.people.map((p) => p.userId)).toContain("u-staff");
  });
});
