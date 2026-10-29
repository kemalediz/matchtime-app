/**
 * A partner club's or the player pool's GUEST (a membership with
 * `guestMatchId`, booked for one game) is not a player of the club in a
 * monthly squad (agent D's finding, 2026-10-29):
 *   - `applySignup` never puts a guest on the month;
 *   - `loadPaygPool` never offers a guest the club's PAYG places.
 * The database is mocked: what matters is that each read asks for the
 * club's ORDINARY members only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  squadMonth: { findUnique: vi.fn() },
  organisation: { findUnique: vi.fn() },
  match: { findMany: vi.fn() },
  membership: { findMany: vi.fn(), findFirst: vi.fn() },
  attendance: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db }));
vi.mock("../db", () => ({ db }));

import { applySignup } from "../month-signup";
import { loadPaygPool } from "../monthly-week";

const MONTH_ROW = {
  id: "m1",
  orgId: "o1",
  activityId: "a1",
  monthStart: new Date("2026-11-01T00:00:00.000Z"),
  status: "open",
  listOpenedAt: new Date("2026-10-26T10:00:00.000Z"),
  startedMidMonthAt: null,
  sharePerGamePence: null,
  concessionPerGamePence: null,
  venueCostPence: null,
  payByAt: null,
  pricedAt: null,
  summarySentAt: null,
  activity: { name: "Monday", venue: "Goals", dayOfWeek: 1, time: "20:30", sport: { playersPerTeam: 8 } },
  org: { language: "en" },
  members: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  db.squadMonth.findUnique.mockResolvedValue(MONTH_ROW);
  db.organisation.findUnique.mockResolvedValue({ squadMode: "monthly" });
  db.match.findMany.mockResolvedValue([]);
  db.membership.findMany.mockResolvedValue([]);
});

describe("applySignup and a guest", () => {
  it("asks for the club's ordinary members only, so a guest is not a member", async () => {
    db.membership.findFirst.mockResolvedValue(null);
    const res = await applySignup({
      monthId: "m1",
      userId: "guest-1",
      choice: "in",
      source: "reply",
      actorUserId: "guest-1",
      now: new Date("2026-10-29T12:00:00.000Z"),
    });
    expect(res).toEqual({ ok: false, error: "not-a-member" });
    expect(db.membership.findFirst.mock.calls[0][0].where).toMatchObject({ orgId: "o1", userId: "guest-1", guestMatchId: null });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("loadPaygPool and a guest", () => {
  it("reads only the club's ordinary members, so a partner or pool guest is never offered a place", async () => {
    db.attendance.findMany.mockResolvedValue([{ userId: "guest-1" }]);
    db.membership.findMany.mockResolvedValue([]);
    const pool = await loadPaygPool({ orgId: "o1", members: [], rows: [] }, new Date("2026-11-03T12:00:00.000Z"));
    expect(pool).toEqual([]);
    expect(db.membership.findMany.mock.calls[0][0].where).toMatchObject({ orgId: "o1", guestMatchId: null });
  });
});
