/**
 * The "Generate match" button stamps the kickoff in LONDON time (2026-10-06).
 *
 * `Activity.time` ("20:00") is a London wall clock. The action used
 * `getDay()` and `setHours()` on the server clock, which is UTC on
 * Vercel, so in British Summer Time a 20:00 game was created at 20:00
 * UTC, which is 21:00 in London. The nightly cron had the same bug fixed
 * long ago; both now share `nextLondonKickoff` (src/lib/london-time.ts).
 *
 * The server's zone is pinned to UTC here, as on Vercel. On a London
 * laptop the old code happened to give the right answer, which is how
 * the bug hid.
 *
 * auth / db / org / next-cache are mocked: no live DB, no model.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

const activityFindUnique = vi.fn();
const matchFindFirst = vi.fn();
const matchCreate = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u1" } }) }));
vi.mock("@/lib/db", () => ({
  db: {
    activity: { findUnique: (...a: unknown[]) => activityFindUnique(...a) },
    match: {
      findFirst: (...a: unknown[]) => matchFindFirst(...a),
      create: (...a: unknown[]) => matchCreate(...a),
    },
  },
}));
vi.mock("@/lib/org", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { generateMatchesForActivity } from "../activities";

const TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (TZ === undefined) delete process.env.TZ;
  else process.env.TZ = TZ;
});

/** Tuesday 20:00 London, sign-up closes 5 hours before. */
const TUESDAY_8PM = {
  id: "act1",
  orgId: "org1",
  dayOfWeek: 2,
  time: "20:00",
  deadlineHours: 5,
  sport: { playersPerTeam: 5 },
};

async function generateAt(now: string) {
  vi.setSystemTime(new Date(now));
  await generateMatchesForActivity("act1");
  return (matchCreate.mock.calls[0][0] as { data: { date: Date; attendanceDeadline: Date; maxPlayers: number } }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  activityFindUnique.mockResolvedValue(TUESDAY_8PM);
  matchFindFirst.mockResolvedValue(null);
  matchCreate.mockResolvedValue({});
});
afterEach(() => {
  vi.useRealTimers();
});

describe("generateMatchesForActivity", () => {
  it("in British Summer Time, a 20:00 game is 19:00 UTC, not 20:00 UTC", async () => {
    // Wednesday 1 July 2026, 11:00 London.
    const data = await generateAt("2026-07-01T10:00:00.000Z");
    expect(data.date.toISOString()).toBe("2026-07-07T19:00:00.000Z");
    expect(data.attendanceDeadline.toISOString()).toBe("2026-07-07T14:00:00.000Z");
    expect(data.maxPlayers).toBe(10);
  });

  it("in winter (GMT), a 20:00 game is 20:00 UTC", async () => {
    // Wednesday 2 December 2026.
    const data = await generateAt("2026-12-02T10:00:00.000Z");
    expect(data.date.toISOString()).toBe("2026-12-08T20:00:00.000Z");
  });

  it("reads the weekday in London: at 00:30 London on a Tuesday (still Monday in UTC) the next Tuesday is a week away", async () => {
    // Tuesday 7 July 2026 00:30 London is Monday 23:30 UTC.
    const data = await generateAt("2026-07-06T23:30:00.000Z");
    expect(data.date.toISOString()).toBe("2026-07-14T19:00:00.000Z");
  });

  it("looks for an existing match across that LONDON day", async () => {
    await generateAt("2026-07-01T10:00:00.000Z");
    expect(matchFindFirst).toHaveBeenCalledWith({
      where: {
        activityId: "act1",
        date: { gte: new Date("2026-07-06T23:00:00.000Z"), lt: new Date("2026-07-07T23:00:00.000Z") },
      },
    });
  });

  it("refuses a second match on the same day", async () => {
    matchFindFirst.mockResolvedValue({ id: "m1" });
    vi.setSystemTime(new Date("2026-07-01T10:00:00.000Z"));
    await expect(generateMatchesForActivity("act1")).rejects.toThrow("Match already exists for this date");
    expect(matchCreate).not.toHaveBeenCalled();
  });
});
