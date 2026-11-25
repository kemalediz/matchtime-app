/**
 * "This month waits for your list" (`tellMonthHeld`, reached through
 * `openDueMonthLists` on every 30 s due-posts poll) claims its once-only
 * keys, `held:` and `held-again:`, by READING first (Disk IO, 2026-11-25).
 * An INSERT that fails on the unique key still writes WAL, and on Supabase
 * any WAL in a two-minute window forces a 16 MB WAL segment to disk, so a
 * held month must not retry the insert on every poll until it starts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rows: new Map<string, Date>(),
  creates: [] as string[],
  notices: 0,
  now: new Date(),
}));

vi.mock("../db", () => ({
  db: {
    organisation: {
      findUnique: async () => ({
        squadMode: "monthly",
        monthListOpensDaysBefore: 30,
        seasonBreakMonths: [],
        language: "en",
        approvalStatus: "approved",
        dormantAt: null,
        billingStatus: null,
      }),
    },
    activity: {
      findMany: async () => [{ id: "act1", venue: "Park", dayOfWeek: 3, time: "19:00", deadlineHours: 2, sport: { playersPerTeam: 7 } }],
    },
    squadMonth: { findMany: async () => [] },
    sentNotification: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        h.rows.has(where.key) ? { id: "x", createdAt: h.rows.get(where.key)! } : null,
      create: async ({ data }: { data: { key: string } }) => {
        h.creates.push(data.key);
        if (h.rows.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" });
        h.rows.set(data.key, h.now);
        return data;
      },
    },
  },
}));
vi.mock("../admin-channel", () => ({
  sendAdminNotice: async () => {
    h.notices += 1;
    return { channel: "dm", queued: 1 };
  },
}));

const { openDueMonthLists } = await import("../month-signup");
const { firstKickoffOf } = await import("../month-signup-rules");

const FIRST = firstKickoffOf("2026-12-01", 3, "19:00")!;
const HOUR = 60 * 60 * 1000;

async function poll(at: Date) {
  h.now = at;
  await openDueMonthLists("org1", at);
}

beforeEach(() => {
  h.rows.clear();
  h.creates.length = 0;
  h.notices = 0;
});

describe("tellMonthHeld's claims", () => {
  it("held: told once, and later polls never try the insert again", async () => {
    const start = new Date(FIRST.getTime() - 5 * 24 * HOUR);
    start.setUTCHours(11, 0, 0, 0);
    await poll(start);
    expect(h.notices).toBe(1);
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toContain(":held:");
    for (let i = 1; i <= 6; i++) await poll(new Date(start.getTime() + i * 30_000));
    expect(h.creates).toHaveLength(1);
    expect(h.notices).toBe(1);
  });

  it("held-again: the day-before nudge goes once, and later polls never try either insert", async () => {
    const start = new Date(FIRST.getTime() - 5 * 24 * HOUR);
    start.setUTCHours(11, 0, 0, 0);
    await poll(start);
    // The day before the first game, daytime.
    const dayBefore = new Date(FIRST.getTime() - 20 * HOUR);
    dayBefore.setUTCHours(11, 0, 0, 0);
    if (dayBefore.getTime() < FIRST.getTime() - 24 * HOUR) dayBefore.setTime(dayBefore.getTime() + 24 * HOUR);
    await poll(dayBefore);
    expect(h.notices).toBe(2);
    expect(h.creates.filter((k) => k.includes(":held-again:"))).toHaveLength(1);
    const before = h.creates.length;
    for (let i = 1; i <= 6; i++) await poll(new Date(dayBefore.getTime() + i * 30_000));
    expect(h.creates).toHaveLength(before);
    expect(h.notices).toBe(2);
  });
});
