/**
 * D2 of slice 3 (MDs/friday-group-features-plan-2026-09-30.md, 3.2): the
 * organisers' summary once the club's weekly drop-out deadline has passed.
 *
 *   - once per match, claimed by `<matchId>:deadline-summary`;
 *   - through `sendAdminNotice` (the one door slice 2a re-routes);
 *   - 08:00 to 21:59 London, before kickoff, the next live match only;
 *   - "Said maybe" lists only CONFIRMED players with an open maybe;
 *   - a club without the setting (Sutton FC) gets nothing.
 *
 * Prisma and the admin channel are mocked: no live DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    org: null as Record<string, unknown> | null,
    matches: [] as Array<Record<string, unknown>>,
    claimed: new Set<string>(),
    claimsDeleted: [] as string[],
    tentatives: [] as Array<{ userId: string; resolvedAt: Date | null; matchId: string }>,
    notices: [] as Array<{ orgId: string; text: string }>,
    noticeFails: false,
    attendanceFeature: true,
  },
}));

vi.mock("../db", () => ({
  db: {
    organisation: { findUnique: async () => h.state.org },
    match: { findMany: async () => h.state.matches },
    tentativeAvailability: {
      findMany: async ({ where }: { where: { matchId: string; userId: { in: string[] } } }) =>
        h.state.tentatives.filter(
          (t) => t.matchId === where.matchId && t.resolvedAt === null && where.userId.in.includes(t.userId),
        ),
    },
    sentNotification: {
      create: async ({ data }: { data: { key: string } }) => {
        if (h.state.claimed.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" });
        h.state.claimed.add(data.key);
        return data;
      },
      deleteMany: async ({ where }: { where: { key: string } }) => {
        h.state.claimed.delete(where.key);
        h.state.claimsDeleted.push(where.key);
        return { count: 1 };
      },
    },
  },
}));
vi.mock("../admin-channel", () => ({
  sendAdminNotice: async (a: { orgId: string; text: string }) => {
    if (h.state.noticeFails) throw new Error("db down");
    h.state.notices.push(a);
    return { queued: 1 };
  },
}));
vi.mock("../org-features", () => ({
  getOrgFeatures: async () => ({ attendance: h.state.attendanceFeature }),
}));

const { sendDueDeadlineSummaries } = await import("../deadline-summary");
const { buildDeadlineSummaryAdminNotice } = await import("../dm-copy");

/** Fri 9 Oct 2026 20:30 London. Deadline Mon 5 Oct 21:00 London = 20:00 UTC. */
const KICKOFF = new Date("2026-10-09T19:30:00.000Z");
const MON_2105 = new Date("2026-10-05T20:05:00.000Z");

function row(userId: string, name: string, status: string, position: number) {
  return { userId, status, position, user: { name } };
}

function fridayMatch(over: Record<string, unknown> = {}) {
  return {
    id: "m-fri",
    date: KICKOFF,
    status: "UPCOMING",
    maxPlayers: 18,
    activityId: "fri-9",
    activity: { orgId: "org-fnf", name: "Friday 9-a-side", venue: "Powerleague", dayOfWeek: 5 },
    attendances: [
      row("u1", "Hamzah", "CONFIRMED", 1),
      row("u2", "Raihan", "CONFIRMED", 2),
      row("u3", "Wasim", "DROPPED", 3),
      row("u4", "Ali", "BENCH", 4),
      row("u5", "Sam", "BENCH", 5),
    ],
    ...over,
  };
}

beforeEach(() => {
  h.state.org = {
    id: "org-fnf",
    language: "en",
    approvalStatus: "approved",
    dormantAt: null,
    dropOutDeadlineDay: 1,
    dropOutDeadlineTime: "21:00",
    listPublishDay: 2,
    listPublishTime: "20:00",
  };
  h.state.matches = [fridayMatch()];
  h.state.claimed = new Set();
  h.state.claimsDeleted = [];
  h.state.tentatives = [];
  h.state.notices = [];
  h.state.noticeFails = false;
  h.state.attendanceFeature = true;
});

describe("the deadline summary", () => {
  it("after the deadline: one notice with who is out, who said maybe, who is waiting, and the places open", async () => {
    h.state.tentatives = [
      { matchId: "m-fri", userId: "u2", resolvedAt: null }, // confirmed, open maybe: listed
      { matchId: "m-fri", userId: "u4", resolvedAt: null }, // bench: not listed
      { matchId: "m-fri", userId: "u1", resolvedAt: new Date() }, // resolved: not listed
    ];
    const res = await sendDueDeadlineSummaries("org-fnf", MON_2105);
    expect(res.sent).toBe(1);
    expect(h.state.claimed.has("m-fri:deadline-summary")).toBe(true);
    expect(h.state.notices).toEqual([
      {
        orgId: "org-fnf",
        now: MON_2105,
        text: buildDeadlineSummaryAdminNotice({
          activityName: "Friday 9-a-side",
          whenLabel: "Fri 9 Oct at 20:30",
          confirmed: 2,
          maxPlayers: 18,
          out: ["Wasim"],
          maybe: ["Raihan"],
          waiting: ["Ali", "Sam"],
          open: 16,
          lang: "en",
        }),
      },
    ]);
  });

  it("only once: a second tick finds the claim taken", async () => {
    await sendDueDeadlineSummaries("org-fnf", MON_2105);
    await sendDueDeadlineSummaries("org-fnf", new Date(MON_2105.getTime() + 5 * 60 * 1000));
    expect(h.state.notices).toHaveLength(1);
  });

  it("not before the deadline", async () => {
    expect((await sendDueDeadlineSummaries("org-fnf", new Date("2026-10-05T19:55:00.000Z"))).sent).toBe(0);
    expect(h.state.claimed.size).toBe(0);
  });

  it("a tick after 22:00 waits for 08:00", async () => {
    expect((await sendDueDeadlineSummaries("org-fnf", new Date("2026-10-05T21:05:00.000Z"))).sent).toBe(0);
    expect((await sendDueDeadlineSummaries("org-fnf", new Date("2026-10-06T07:05:00.000Z"))).sent).toBe(1);
  });

  it("the Turkish club gets the Turkish summary", async () => {
    h.state.org = { ...h.state.org!, language: "tr" };
    await sendDueDeadlineSummaries("org-fnf", MON_2105);
    expect(h.state.notices[0].text).toContain("için son çıkış saati geçti. Kadro 2/18.");
  });

  it("next week's match waits while this week's is still live", async () => {
    h.state.matches = [
      fridayMatch({ id: "m-this", date: new Date("2026-10-06T19:30:00.000Z"), activity: { orgId: "org-fnf", name: "Tue", venue: "Powerleague", dayOfWeek: 5 } }),
      fridayMatch({ id: "m-next", date: new Date("2026-10-13T19:30:00.000Z"), activity: { orgId: "org-fnf", name: "Tue", venue: "Powerleague", dayOfWeek: 5 } }),
    ];
    // Mon 12 Oct 21:05: m-next's deadline passed, but m-this is still live.
    await sendDueDeadlineSummaries("org-fnf", new Date("2026-10-12T20:05:00.000Z"));
    expect(h.state.claimed.has("m-next:deadline-summary")).toBe(false);
  });

  it("a club without the setting (Sutton) gets nothing", async () => {
    h.state.org = { ...h.state.org!, dropOutDeadlineDay: null, dropOutDeadlineTime: null };
    expect((await sendDueDeadlineSummaries("org-fnf", MON_2105)).sent).toBe(0);
    expect(h.state.notices).toEqual([]);
  });

  it("a club that is not operational, or has attendance off, gets nothing", async () => {
    h.state.org = { ...h.state.org!, dormantAt: new Date() };
    expect((await sendDueDeadlineSummaries("org-fnf", MON_2105)).sent).toBe(0);
    h.state.org = { ...h.state.org!, dormantAt: null, approvalStatus: "pending" };
    expect((await sendDueDeadlineSummaries("org-fnf", MON_2105)).sent).toBe(0);
    h.state.org = { ...h.state.org!, approvalStatus: "approved" };
    h.state.attendanceFeature = false;
    expect((await sendDueDeadlineSummaries("org-fnf", MON_2105)).sent).toBe(0);
  });

  it("if the notice cannot be queued, the claim is released so the next tick tries again", async () => {
    h.state.noticeFails = true;
    expect((await sendDueDeadlineSummaries("org-fnf", MON_2105)).sent).toBe(0);
    expect(h.state.claimsDeleted).toEqual(["m-fri:deadline-summary"]);
    h.state.noticeFails = false;
    expect((await sendDueDeadlineSummaries("org-fnf", MON_2105)).sent).toBe(1);
  });
});
