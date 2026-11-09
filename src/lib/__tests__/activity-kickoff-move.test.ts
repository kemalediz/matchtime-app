/**
 * `moveGamesWithActivity`: the writes that follow a weekly game's new
 * kickoff (Kemal, 2026-11-09, "silently"). A mocked transaction client:
 * no database, no model, no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The club's partner-ask cut-off is read by its owner (club-partnership.ts).
const club = vi.hoisted(() => ({ cutoff: null as number | null }));
vi.mock("../db", () => ({ db: { organisation: { findUnique: async () => ({ partnerAskCutoffHours: club.cutoff }) } } }));

import { moveGamesWithActivity, NOT_PLAYED_STATUSES } from "../activity-kickoff-move";
import { londonDateTimeToUtc } from "../london-time";

const at = (date: string, time: string) => londonDateTimeToUtc(date, time);
const H = 3600_000;
const NOW = at("2026-11-09", "09:00");
const TONIGHT = at("2026-11-09", "20:30");
const NEXT_WEEK = at("2026-11-16", "20:30");

type Row = Record<string, unknown>;
function makeTx(games: Array<{ id: string; date: Date }>, opts: { askCutoff?: number | null } = {}) {
  club.cutoff = opts.askCutoff ?? null;
  const calls = {
    matchFind: [] as Row[],
    matchUpdates: [] as Array<{ where: Row; data: Row }>,
    askUpdates: [] as Array<{ where: Row; data: Row }>,
    tentativeUpdates: [] as Array<{ where: Row; data: Row }>,
    offerUpdates: [] as Array<{ where: Row; data: Row }>,
  };
  const never = vi.fn(async () => {
    throw new Error("nothing may be sent about a move");
  });
  const tx = {
    match: {
      findMany: vi.fn(async (args: Row) => {
        calls.matchFind.push(args);
        return games.map((g) => ({ ...g, attendanceDeadline: new Date(g.date.getTime() - 5 * H) }));
      }),
      updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
        calls.matchUpdates.push(args);
        return { count: 1 };
      }),
    },
    partnerAsk: {
      findMany: vi.fn(async ({ where }: { where: { matchId: string } }) =>
        where.matchId === "tonight" ? [{ id: "ask-1", status: "posted", closesAt: TONIGHT }] : [],
      ),
      updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
        calls.askUpdates.push(args);
        return { count: 1 };
      }),
    },
    tentativeAvailability: {
      updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
        calls.tentativeUpdates.push(args);
        return { count: 1 };
      }),
    },
    poolOffer: {
      updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
        calls.offerUpdates.push(args);
        return { count: 1 };
      }),
    },
    botJob: { create: never, createMany: never },
    sentNotification: { create: never, upsert: never },
    platformJob: { create: never },
  };
  return { tx, calls, never };
}

const MONDAY_2030 = { dayOfWeek: 1, time: "20:30" };
const MONDAY_2015 = { dayOfWeek: 1, time: "20:15" };

describe("moveGamesWithActivity", () => {
  let t: ReturnType<typeof makeTx>;
  beforeEach(() => {
    t = makeTx([
      { id: "tonight", date: TONIGHT },
      { id: "next-week", date: NEXT_WEEK },
    ]);
  });

  it("reads only this activity's games still to be played: not completed or cancelled, not historical, kickoff ahead", async () => {
    await moveGamesWithActivity(t.tx as never, { activityId: "vets", orgId: "club", before: MONDAY_2030, after: MONDAY_2015, now: NOW });
    expect(t.calls.matchFind[0]).toMatchObject({
      where: { activityId: "vets", status: { in: [...NOT_PLAYED_STATUSES] }, isHistorical: false, date: { gt: NOW } },
    });
    expect(NOT_PLAYED_STATUSES).toEqual(["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"]);
  });

  it("20:30 to 20:15: tonight's and next week's games move, each guarded on the kickoff it was read at", async () => {
    const res = await moveGamesWithActivity(t.tx as never, { activityId: "vets", orgId: "club", before: MONDAY_2030, after: MONDAY_2015, now: NOW });
    expect(t.calls.matchUpdates).toEqual([
      {
        where: { id: "tonight", date: TONIGHT, status: { in: [...NOT_PLAYED_STATUSES] } },
        data: { date: at("2026-11-09", "20:15"), attendanceDeadline: at("2026-11-09", "15:15") },
      },
      {
        where: { id: "next-week", date: NEXT_WEEK, status: { in: [...NOT_PLAYED_STATUSES] } },
        data: { date: at("2026-11-16", "20:15"), attendanceDeadline: at("2026-11-16", "15:15") },
      },
    ]);
    expect(res.moved.map((m) => m.matchId)).toEqual(["tonight", "next-week"]);
  });

  it("an open partner ask follows the new kickoff in the same write, so the sweep finds nothing moved and tells nobody", async () => {
    await moveGamesWithActivity(t.tx as never, { activityId: "vets", orgId: "club", before: MONDAY_2030, after: MONDAY_2015, now: NOW });
    const kickoff = at("2026-11-09", "20:15");
    expect(t.calls.askUpdates).toEqual([
      {
        where: { id: "ask-1", status: "posted", closesAt: TONIGHT },
        data: { closesAt: kickoff, postBy: new Date(kickoff.getTime() - 2 * H) }, // the default cut-off
      },
    ]);
  });

  it("the partner-ask cut-off is the club's own", async () => {
    t = makeTx([{ id: "tonight", date: TONIGHT }], { askCutoff: 6 });
    await moveGamesWithActivity(t.tx as never, { activityId: "vets", orgId: "club", before: MONDAY_2030, after: MONDAY_2015, now: NOW });
    expect(t.calls.askUpdates[0].data.postBy).toEqual(at("2026-11-09", "14:15"));
  });

  it("a maybe's follow-up not yet due is re-timed from the new kickoff; pool offers still open end at the new kickoff", async () => {
    await moveGamesWithActivity(t.tx as never, { activityId: "vets", orgId: "club", before: MONDAY_2030, after: MONDAY_2015, now: NOW });
    expect(t.calls.tentativeUpdates[1]).toEqual({
      where: { matchId: "next-week", resolvedAt: null, notifiedAt: null, dueAt: { gt: NOW } },
      data: { dueAt: at("2026-11-15", "20:15") },
    });
    expect(t.calls.offerUpdates[0]).toEqual({
      where: { matchId: "tonight", resolvedAt: null, outcome: null },
      data: { expiresAt: at("2026-11-09", "20:15") },
    });
  });

  it("nothing is posted or sent: no bot job, no sent-notification, no platform job", async () => {
    await moveGamesWithActivity(t.tx as never, { activityId: "vets", orgId: "club", before: MONDAY_2030, after: MONDAY_2015, now: NOW });
    expect(t.never).not.toHaveBeenCalled();
  });

  it("a game that changed under us (already moved or played) is skipped, and nothing follows it", async () => {
    t.tx.match.updateMany.mockResolvedValueOnce({ count: 0 } as never);
    const res = await moveGamesWithActivity(t.tx as never, { activityId: "vets", orgId: "club", before: MONDAY_2030, after: MONDAY_2015, now: NOW });
    expect(res.moved.map((m) => m.matchId)).toEqual(["next-week"]);
    expect(t.calls.askUpdates).toEqual([]);
    expect(t.calls.offerUpdates.map((u) => u.where.matchId)).toEqual(["next-week"]);
  });

  it("a game set to another time by hand stays and is reported", async () => {
    t = makeTx([{ id: "block", date: at("2026-11-09", "20:00") }]);
    const res = await moveGamesWithActivity(t.tx as never, { activityId: "vets", orgId: "club", before: MONDAY_2030, after: MONDAY_2015, now: NOW });
    expect(t.calls.matchUpdates).toEqual([]);
    expect(res.stayed).toEqual([{ matchId: "block", reason: "set-by-hand" }]);
  });

  it("a save that changes neither the day nor the time reads nothing and writes nothing", async () => {
    const res = await moveGamesWithActivity(t.tx as never, { activityId: "vets", orgId: "club", before: MONDAY_2030, after: MONDAY_2030, now: NOW });
    expect(t.tx.match.findMany).not.toHaveBeenCalled();
    expect(res).toEqual({ moved: [], stayed: [] });
  });
});
