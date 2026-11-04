/**
 * A posted list starts THIS month part-way (2026-11-03, Vets MNF). Davide
 * posted "MNF November" on 3 Nov, the day after November's first Monday.
 * The seed door only knew the coming month (December), so the November
 * list was drafted against December, refused as "another month", and no
 * month was opened. Now the list's own month picks the target, and the
 * games already played reach `startMonth` through the YES.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  organisation: { findUnique: vi.fn() },
  activity: { findMany: vi.fn(), findFirst: vi.fn() },
  squadMonth: { findMany: vi.fn() },
  membership: { findMany: vi.fn(), findFirst: vi.fn() },
  userAlias: { findMany: vi.fn() },
  adminSquadProposal: { updateMany: vi.fn(), create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("../db", () => ({ db: dbMock }));
const squadMonth = vi.hoisted(() => ({ startMonth: vi.fn() }));
vi.mock("../squad-month", () => squadMonth);
vi.mock("@/lib/squad-month", () => squadMonth);

import { applyMonthSeedYes, comingMonth } from "@/lib/month-seed-hq";
import { proposeMonthSeedPaste } from "@/lib/month-seed-read";
import type { MonthlyList, MonthlyListEntry } from "@/lib/monthly-list";

const ORG = "org-vets";
const NOW = new Date("2026-11-03T09:14:00Z");
const DAVIDE = "u-davide";
const STEFF = "u-steff";

const line = (slot: number, name: string, games: number | null = null): MonthlyListEntry => ({
  slot,
  raw: name,
  name,
  marks: { paid: true, paidAmountPence: null, tier: null, payg: false, paygDates: [], gamesCommitted: games },
});
const listFor = (month: number): MonthlyList => ({
  month: { month, year: null },
  slots: [line(1, "Davide"), line(2, "steff", 4)],
  sections: { cantPlay: [], reserves: [], other: [] },
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.organisation.findUnique.mockResolvedValue({ squadMode: "monthly", seasonBreakMonths: [] });
  dbMock.activity.findMany.mockResolvedValue([{ id: "act", dayOfWeek: 1, time: "20:30" }]);
  dbMock.activity.findFirst.mockResolvedValue({ id: "act", dayOfWeek: 1, time: "20:30" });
  dbMock.squadMonth.findMany.mockResolvedValue([]);
  dbMock.membership.findMany.mockResolvedValue([
    { user: { id: DAVIDE, name: "Davide De Sousa" } },
    { user: { id: STEFF, name: "Steff" } },
  ]);
  dbMock.membership.findFirst.mockResolvedValue({ id: "mem" });
  dbMock.userAlias.findMany.mockResolvedValue([]);
  dbMock.adminSquadProposal.updateMany.mockResolvedValue({ count: 0 });
  dbMock.adminSquadProposal.create.mockResolvedValue({ id: "p1" });
  squadMonth.startMonth.mockResolvedValue({ ok: true, monthId: "m1" });
});

describe("the month a posted list starts", () => {
  it("a list for THIS month, already under way and never started, is proposed for this month with the games played", async () => {
    const res = await proposeMonthSeedPaste({ orgId: ORG, lang: "en", messageId: "wa1", organiserUserId: DAVIDE, text: "", now: NOW, list: listFor(11) });
    expect(res?.outcome).toBe("month-seed-proposed");
    const data = dbMock.adminSquadProposal.create.mock.calls[0][0].data;
    expect(data.monthStart).toBe("2026-11-01");
    expect(data.monthSeed).toMatchObject({ activityId: "act", games: 5, gamesPlayed: 1 });
    expect(data.monthSeed.rows.map((r: { userId: string; gamesCommitted: number | null }) => [r.userId, r.gamesCommitted])).toEqual([
      [DAVIDE, null],
      [STEFF, 4],
    ]);
  });

  it("a list for NEXT month is still proposed for next month (the coming-month door is unchanged)", async () => {
    const res = await proposeMonthSeedPaste({ orgId: ORG, lang: "en", messageId: "wa2", organiserUserId: DAVIDE, text: "", now: NOW, list: listFor(12) });
    expect(res?.outcome).toBe("month-seed-proposed");
    const data = dbMock.adminSquadProposal.create.mock.calls[0][0].data;
    expect(data.monthStart).toBe("2026-12-01");
    expect(data.monthSeed).toMatchObject({ games: 4, gamesPlayed: 0 });
  });

  it("a list for a month already started proposes nothing", async () => {
    dbMock.squadMonth.findMany.mockResolvedValue([{ id: "sm", activityId: "act", status: "running", monthStart: new Date("2026-11-01T00:00:00Z") }]);
    const res = await proposeMonthSeedPaste({ orgId: ORG, lang: "en", messageId: "wa3", organiserUserId: DAVIDE, text: "", now: NOW, list: listFor(11) });
    expect(res).toBeNull();
    expect(dbMock.adminSquadProposal.create).not.toHaveBeenCalled();
  });

  it("club summary B2 (D5): another game's month (a former Activity) does not count as this game's; the list is proposed", async () => {
    dbMock.squadMonth.findMany.mockResolvedValue([{ id: "sm-old", activityId: "act-old", status: "running", monthStart: new Date("2026-11-01T00:00:00Z") }]);
    const res = await proposeMonthSeedPaste({ orgId: ORG, lang: "en", messageId: "wa4", organiserUserId: DAVIDE, text: "", now: NOW, list: listFor(11) });
    expect(res?.outcome).toBe("month-seed-proposed");
    expect(dbMock.adminSquadProposal.create.mock.calls[0][0].data.monthStart).toBe("2026-11-01");
  });

  it("club summary B2: a month held for its organiser is still one a list may start", async () => {
    dbMock.squadMonth.findMany.mockResolvedValue([]);
    const c = await comingMonth(ORG, NOW);
    expect(c?.monthStart).toBe("2026-11-01");
  });

  it("comingMonth is the first month a list could start: this month part-way when it was never started", async () => {
    const c = await comingMonth(ORG, NOW);
    expect(c && [c.monthStart, c.games, c.gamesPlayed]).toEqual(["2026-11-01", 5, 1]);
  });
});

describe("the YES", () => {
  it("starts a month under way with the games played by the time of the YES", async () => {
    // Proposed on 3 Nov (1 played), answered on 10 Nov (9 Nov played too).
    const r = await applyMonthSeedYes({
      orgId: ORG,
      lang: "en",
      proposal: { monthStart: "2026-11-01", monthSeed: { activityId: "act", games: 5, gamesPlayed: 1, rows: [{ userId: DAVIDE, kind: "regular" }] } },
      senderUserId: DAVIDE,
      now: new Date("2026-11-10T09:00:00Z"),
    });
    expect(r.outcome).toBe("month-seed-applied");
    expect(squadMonth.startMonth).toHaveBeenCalledWith(
      ORG,
      DAVIDE,
      expect.objectContaining({ activityId: "act", gamesScheduled: 5, gamesPlayed: 2, source: "seed-list" }),
      expect.any(Date),
      { monthStart: "2026-11-01" },
    );
  });

  it("a coming month starts with nothing played", async () => {
    await applyMonthSeedYes({
      orgId: ORG,
      lang: "en",
      proposal: { monthStart: "2026-12-01", monthSeed: { activityId: "act", games: 4, rows: [{ userId: DAVIDE, kind: "regular" }] } },
      senderUserId: DAVIDE,
      now: NOW,
    });
    expect(squadMonth.startMonth.mock.calls[0][2]).toMatchObject({ gamesScheduled: 4, gamesPlayed: 0 });
  });
});
