/**
 * Is the rolling squad of a match still to be carried over (2026-10-17)?
 * Read by the admin group (`admin-group-squad-change.ts`): until the 08:00
 * carry-over the morning after the last game, the next game's list is not
 * set, and HQ does not change it. The same rules the scheduler seeds by
 * (`pickSeedSource`, `rollingSeedDueAt`). Prisma mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ match: { findUnique: vi.fn(), findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { rollingSeedPendingAt } from "../rolling-squad";

const ACT = { orgId: "org-fnf", venue: "Harris Merton", dayOfWeek: 5, matchDurationMins: 60 };
// FNF, the incident: Friday's game played (19:30 London = 18:30 UTC), next
// Friday's not seeded yet.
const PLAYED = { id: "m-played", date: new Date("2026-10-16T18:30:00Z"), status: "COMPLETED", isHistorical: false, activity: ACT };
const NEXT = {
  id: "m-next",
  date: new Date("2026-10-23T18:30:00Z"),
  status: "UPCOMING",
  isHistorical: false,
  rollingSeededAt: null as Date | null,
  activity: { ...ACT, org: { rollingSquadEnabled: true } },
};
const NIGHT = new Date("2026-10-16T22:49:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.match.findUnique.mockResolvedValue(NEXT);
  dbMock.match.findMany.mockResolvedValue([PLAYED]);
});

describe("rollingSeedPendingAt", () => {
  it("the night after the game: pending, due at 08:00 London the next morning", async () => {
    expect(await rollingSeedPendingAt("m-next", NIGHT)).toEqual(new Date("2026-10-17T07:00:00Z"));
  });

  it("once seeded: not pending", async () => {
    dbMock.match.findUnique.mockResolvedValue({ ...NEXT, rollingSeededAt: new Date("2026-10-17T07:00:10Z") });
    expect(await rollingSeedPendingAt("m-next", NIGHT)).toBeNull();
  });

  it("past the due time (the cron runs every 15 minutes): not pending, the list is MatchTime's to change", async () => {
    expect(await rollingSeedPendingAt("m-next", new Date("2026-10-17T07:05:00Z"))).toBeNull();
  });

  it("a club without the rolling squad: never pending", async () => {
    dbMock.match.findUnique.mockResolvedValue({ ...NEXT, activity: { ...NEXT.activity, org: { rollingSquadEnabled: false } } });
    expect(await rollingSeedPendingAt("m-next", NIGHT)).toBeNull();
    expect(dbMock.match.findMany).not.toHaveBeenCalled();
  });

  it("nothing to carry from (the first game, or a long break): never pending", async () => {
    dbMock.match.findMany.mockResolvedValue([]);
    expect(await rollingSeedPendingAt("m-next", NIGHT)).toBeNull();
  });

  it("a match that does not exist: not pending", async () => {
    dbMock.match.findUnique.mockResolvedValue(null);
    expect(await rollingSeedPendingAt("nope", NIGHT)).toBeNull();
  });
});
