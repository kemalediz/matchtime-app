/**
 * Wiring test for `switchMatchFormat`'s KICKOFF handling.
 *
 * THE BUG (2026-09-08, Sutton FC, live). Each format is its own Activity
 * with its own London wall-clock `time` — `tuesday-7aside` = "21:30",
 * `tuesday-5aside` = "21:15". `switchMatchFormat` re-pointed `activityId`
 * and reset `maxPlayers` but never touched `Match.date`, so a match
 * switched to 5-a-side sat at the 7-a-side kickoff while pointing at an
 * Activity configured 15 minutes earlier. Every downstream post — the
 * chase, the announcement, the team sheet, the 2-hour pre-kickoff
 * message — reads `Match.date`, so they all stated the wrong time until
 * the owner spotted it four hours before a real match.
 *
 * The arithmetic itself lives in `src/lib/format-switch-time.ts` and is
 * unit-tested there. THIS file proves the action actually applies it:
 * the exact `db.match.update` payload, in both directions, and — just as
 * important — that the payload carries NO `date` key at all when the
 * kickoff must not move.
 *
 * auth / db / org / attendance-events / next-cache are mocked; no DB.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const authMock = vi.fn();
const matchFindUnique = vi.fn();
const matchUpdate = vi.fn();
const activityFindFirst = vi.fn();
const attendanceFindMany = vi.fn();
const attendanceUpdate = vi.fn();
const botJobCreate = vi.fn();
const requireOrgAdmin = vi.fn();
const recordAttendanceEvent = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/org", () => ({
  requireOrgAdmin: (...a: unknown[]) => requireOrgAdmin(...a),
}));
vi.mock("@/lib/attendance-events", () => ({
  recordAttendanceEvent: (...a: unknown[]) => recordAttendanceEvent(...a),
}));
vi.mock("@/lib/email", () => ({ sendRatingEmails: vi.fn() }));
vi.mock("@/lib/elo", () => ({ computeEloDeltas: vi.fn(() => []) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const sendAdminNotice = vi.fn(async (..._a: unknown[]) => ({ channel: "admin-group", queued: 1 }));
vi.mock("@/lib/admin-channel", () => ({
  sendAdminNotice: (...a: unknown[]) => sendAdminNotice(...a),
}));
vi.mock("@/lib/db", () => ({
  db: {
    match: {
      findUnique: (...a: unknown[]) => matchFindUnique(...a),
      update: (...a: unknown[]) => matchUpdate(...a),
    },
    activity: { findFirst: (...a: unknown[]) => activityFindFirst(...a) },
    attendance: {
      findMany: (...a: unknown[]) => attendanceFindMany(...a),
      update: (...a: unknown[]) => attendanceUpdate(...a),
    },
    botJob: { create: (...a: unknown[]) => botJobCreate(...a) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        attendance: { update: (...a: unknown[]) => attendanceUpdate(...a) },
      }),
  },
}));

import { switchMatchFormat } from "@/app/actions/matches";

/** Sutton prod, Tue 8 Sep 2026: 21:30 London (BST) = 20:30 UTC. */
const TUE_2130_BST = new Date("2026-09-08T20:30:00.000Z");
const TUE_2115_BST = new Date("2026-09-08T20:15:00.000Z");

const sevenASide = {
  id: "tuesday-7aside",
  orgId: "sutton-fc",
  time: "21:30",
  deadlineHours: 0,
  sport: { name: "Football 7-a-side", playersPerTeam: 7 },
};
const fiveASide = {
  id: "tuesday-5aside",
  orgId: "sutton-fc",
  time: "21:15",
  deadlineHours: 0,
  sport: { name: "Football 5-a-side", playersPerTeam: 5 },
};

function arrange(opts: {
  from: typeof sevenASide;
  to: typeof sevenASide;
  matchDate: Date;
}) {
  authMock.mockResolvedValue({ user: { id: "admin-1" } });
  requireOrgAdmin.mockResolvedValue(undefined);
  matchFindUnique.mockResolvedValue({
    id: "match-1",
    date: opts.matchDate,
    maxPlayers: opts.from.sport.playersPerTeam * 2,
    activity: opts.from,
  });
  activityFindFirst.mockResolvedValue(opts.to);
  matchUpdate.mockResolvedValue({});
  attendanceFindMany.mockResolvedValue([]);
  botJobCreate.mockResolvedValue({});
}

const updatePayload = () => matchUpdate.mock.calls[0][0].data as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("switchMatchFormat — kickoff follows the new activity's time", () => {
  it("THE HEADLINE: 7-a-side 21:30 → 5-a-side 21:15 writes date 21:15 London, same day, maxPlayers 10", async () => {
    arrange({ from: sevenASide, to: fiveASide, matchDate: TUE_2130_BST });

    await switchMatchFormat("match-1", "tuesday-5aside");

    const data = updatePayload();
    expect(data.activityId).toBe("tuesday-5aside");
    expect(data.maxPlayers).toBe(10);
    expect((data.date as Date).toISOString()).toBe("2026-09-08T20:15:00.000Z");
  });

  it("the reverse: 5-a-side 21:15 → 7-a-side 21:30 writes 21:30 and maxPlayers 14", async () => {
    arrange({ from: fiveASide, to: sevenASide, matchDate: TUE_2115_BST });

    await switchMatchFormat("match-1", "tuesday-7aside");

    const data = updatePayload();
    expect(data.maxPlayers).toBe(14);
    expect((data.date as Date).toISOString()).toBe("2026-09-08T20:30:00.000Z");
  });

  it("re-derives attendanceDeadline from the NEW kickoff and the NEW activity's deadlineHours", async () => {
    arrange({
      from: sevenASide,
      to: { ...fiveASide, deadlineHours: 5 },
      matchDate: TUE_2130_BST,
    });

    await switchMatchFormat("match-1", "tuesday-5aside");

    const data = updatePayload();
    expect((data.attendanceDeadline as Date).toISOString()).toBe(
      "2026-09-08T15:15:00.000Z", // 21:15 London − 5h
    );
  });

  it("deadlineHours 0 (Sutton's live value) yields deadline === kickoff, not kickoff − 5h", async () => {
    arrange({ from: sevenASide, to: fiveASide, matchDate: TUE_2130_BST });

    await switchMatchFormat("match-1", "tuesday-5aside");

    const data = updatePayload();
    expect((data.attendanceDeadline as Date).getTime()).toBe(
      (data.date as Date).getTime(),
    );
  });
});

describe("switchMatchFormat — when the kickoff must NOT move", () => {
  it("same-time formats: the update carries no date/deadline keys at all", async () => {
    arrange({
      from: sevenASide,
      to: { ...fiveASide, time: "21:30" },
      matchDate: TUE_2130_BST,
    });

    await switchMatchFormat("match-1", "tuesday-5aside");

    const data = updatePayload();
    expect(data.maxPlayers).toBe(10);
    expect(Object.keys(data).sort()).toEqual(["activityId", "maxPlayers"]);
  });

  it("a match sitting off its activity's default time is left where the admin put it", async () => {
    // e.g. a block booking created with an explicit `time` override.
    arrange({
      from: sevenASide,
      to: fiveASide,
      matchDate: new Date("2026-09-08T19:00:00.000Z"), // 20:00 London
    });

    await switchMatchFormat("match-1", "tuesday-5aside");

    const data = updatePayload();
    expect(Object.keys(data).sort()).toEqual(["activityId", "maxPlayers"]);
  });
});

describe("switchMatchFormat — the group announcement", () => {
  it("tells the group the new kickoff when it moved", async () => {
    arrange({ from: sevenASide, to: fiveASide, matchDate: TUE_2130_BST });

    await switchMatchFormat("match-1", "tuesday-5aside");

    const text = botJobCreate.mock.calls[0][0].data.text as string;
    expect(text).toContain("21:15");
    expect(text).toContain("21:30");
    expect(text).not.toContain("20:15"); // London wall clock, never UTC
  });

  it("says nothing about kickoff when it did not move", async () => {
    arrange({
      from: sevenASide,
      to: { ...fiveASide, time: "21:30" },
      matchDate: TUE_2130_BST,
    });

    await switchMatchFormat("match-1", "tuesday-5aside");

    const text = botJobCreate.mock.calls[0][0].data.text as string;
    expect(text).not.toMatch(/kickoff/i);
  });
});

describe("switchMatchFormat: the organisers announce the list (2026-10-14)", () => {
  it("the announcement, which lists who is playing, goes to the admin channel, not the players' group", async () => {
    arrange({ from: sevenASide, to: fiveASide, matchDate: TUE_2130_BST });
    matchFindUnique.mockResolvedValue({
      id: "match-1",
      date: TUE_2130_BST,
      maxPlayers: 14,
      activity: { ...sevenASide, org: { language: "en", listAnnouncer: "organisers" } },
    });

    await switchMatchFormat("match-1", "tuesday-5aside");

    expect(botJobCreate).not.toHaveBeenCalled();
    expect(sendAdminNotice).toHaveBeenCalledTimes(1);
    const notice = sendAdminNotice.mock.calls[0][0] as { orgId: string; text: string };
    expect(notice.orgId).toBe("sutton-fc");
    expect(notice.text.startsWith("📋 For the organisers, not posted in the players' group:\n\n")).toBe(true);
    expect(notice.text).toMatch(/kickoff/i);
  });

  it("default: the group post, no admin notice", async () => {
    arrange({ from: sevenASide, to: fiveASide, matchDate: TUE_2130_BST });
    await switchMatchFormat("match-1", "tuesday-5aside");
    expect(botJobCreate).toHaveBeenCalledTimes(1);
    expect(sendAdminNotice).not.toHaveBeenCalled();
  });
});
