/**
 * The writes behind "@Match Time move Monday's game to 8:15" and "@Match
 * Time from now on we kick off at 8:15" (Kemal, 2026-11-10), in
 * `activity-kickoff-move.ts`, the one place a kickoff moves:
 *
 *   moveOneGame            one game, and everything that hangs off its
 *                          kickoff, exactly as the weekly change moves each
 *                          of its games (#577), quietly;
 *   changeActivityKickoff  the weekly game's day or time, through the edit
 *                          form's own checks (`activityUpdateData`), and its
 *                          games still to be played with it
 *                          (`moveGamesWithActivity`), in one transaction.
 *
 * A mocked transaction client: no database, no model, no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const club = vi.hoisted(() => ({ cutoff: null as number | null }));
const txHolder = vi.hoisted(() => ({ tx: null as unknown }));
vi.mock("../db", () => ({
  db: {
    organisation: { findUnique: async () => ({ partnerAskCutoffHours: club.cutoff }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txHolder.tx),
  },
}));

import { changeActivityKickoff, moveOneGame, NOT_PLAYED_STATUSES } from "../activity-kickoff-move";
import { londonDateTimeToUtc } from "../london-time";

const at = (date: string, time: string) => londonDateTimeToUtc(date, time);
const H = 3600_000;
const NOW = at("2026-11-10", "10:00");
const MON = at("2026-11-16", "20:30");
const NEXT_MON = at("2026-11-23", "20:30");

type Row = Record<string, unknown>;
function makeTx(opts: { game?: Row | null; games?: Array<{ id: string; date: Date }>; activity?: Row | null } = {}) {
  const calls = {
    matchUpdates: [] as Array<{ where: Row; data: Row }>,
    activityUpdates: [] as Array<{ where: Row; data: Row }>,
    askUpdates: [] as Array<{ where: Row; data: Row }>,
    tentativeUpdates: [] as Array<{ where: Row; data: Row }>,
    offerUpdates: [] as Array<{ where: Row; data: Row }>,
  };
  const never = vi.fn(async () => {
    throw new Error("nothing may be sent about a move");
  });
  const tx = {
    match: {
      findFirst: vi.fn(async () => (opts.game === undefined ? { id: "mon", date: MON, attendanceDeadline: new Date(MON.getTime() - 5 * H), status: "UPCOMING" } : opts.game)),
      findMany: vi.fn(async () => (opts.games ?? []).map((g) => ({ ...g, attendanceDeadline: new Date(g.date.getTime() - 5 * H) }))),
      updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
        calls.matchUpdates.push(args);
        return { count: 1 };
      }),
    },
    activity: {
      findFirst: vi.fn(async () => (opts.activity === undefined ? { id: "vets", orgId: "club", name: "Monday Vets", dayOfWeek: 1, time: "20:30", feeSplitTotal: false, venue: "Goals" } : opts.activity)),
      update: vi.fn(async (args: { where: Row; data: Row }) => {
        calls.activityUpdates.push(args);
        return {};
      }),
    },
    partnerAsk: {
      findMany: vi.fn(async () => [{ id: "ask-1", status: "posted", closesAt: MON }]),
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
  txHolder.tx = tx;
  return { tx, calls, never };
}

describe("moveOneGame", () => {
  let t: ReturnType<typeof makeTx>;
  beforeEach(() => {
    club.cutoff = null;
    t = makeTx();
  });

  it("reads only the club's game still to be played, by its id", async () => {
    await moveOneGame({ matchId: "mon", orgId: "club", toDayOfWeek: null, toTime: "20:15", now: NOW });
    expect(t.tx.match.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "mon", activity: { orgId: "club" }, status: { in: [...NOT_PLAYED_STATUSES] }, isHistorical: false } }),
    );
  });

  it("moves the game and its deadline, guarded on the kickoff it was read at", async () => {
    const r = await moveOneGame({ matchId: "mon", orgId: "club", toDayOfWeek: null, toTime: "20:15", now: NOW });
    expect(r).toEqual({ moved: true, matchId: "mon", from: MON, to: at("2026-11-16", "20:15") });
    expect(t.calls.matchUpdates).toEqual([
      {
        where: { id: "mon", date: MON, status: { in: [...NOT_PLAYED_STATUSES] } },
        data: { date: at("2026-11-16", "20:15"), attendanceDeadline: at("2026-11-16", "15:15") },
      },
    ]);
  });

  it("everything that hangs off the kickoff follows it, as for the weekly change (#577)", async () => {
    await moveOneGame({ matchId: "mon", orgId: "club", toDayOfWeek: 3, toTime: "20:30", now: NOW });
    const kickoff = at("2026-11-18", "20:30");
    expect(t.calls.askUpdates).toEqual([{ where: { id: "ask-1", status: "posted", closesAt: MON }, data: { closesAt: kickoff, postBy: new Date(kickoff.getTime() - 2 * H) } }]);
    expect(t.calls.tentativeUpdates).toEqual([{ where: { matchId: "mon", resolvedAt: null, notifiedAt: null, dueAt: { gt: NOW } }, data: { dueAt: at("2026-11-17", "20:30") } }]);
    expect(t.calls.offerUpdates).toEqual([{ where: { matchId: "mon", resolvedAt: null, outcome: null }, data: { expiresAt: kickoff } }]);
  });

  it("nothing is posted or sent", async () => {
    await moveOneGame({ matchId: "mon", orgId: "club", toDayOfWeek: null, toTime: "20:15", now: NOW });
    expect(t.never).not.toHaveBeenCalled();
  });

  it("a game that stays says why, and nothing is written", async () => {
    const r = await moveOneGame({ matchId: "mon", orgId: "club", toDayOfWeek: null, toTime: "20:15", now: at("2026-11-16", "20:40") });
    expect(r).toEqual({ moved: false, matchId: "mon", reason: "started", from: MON });
    expect(t.calls.matchUpdates).toEqual([]);
  });

  it("a game not found (played, cancelled, another club's) is gone, and nothing is written", async () => {
    t = makeTx({ game: null });
    expect(await moveOneGame({ matchId: "x", orgId: "club", toDayOfWeek: null, toTime: "20:15", now: NOW })).toEqual({ moved: false, matchId: "x", reason: "gone", from: null });
    expect(t.calls.matchUpdates).toEqual([]);
  });

  it("a game that changed under us is gone, and nothing follows it", async () => {
    t.tx.match.updateMany.mockResolvedValueOnce({ count: 0 } as never);
    const r = await moveOneGame({ matchId: "mon", orgId: "club", toDayOfWeek: null, toTime: "20:15", now: NOW });
    expect(r.moved).toBe(false);
    expect(t.calls.askUpdates).toEqual([]);
    expect(t.calls.offerUpdates).toEqual([]);
  });
});

describe("changeActivityKickoff", () => {
  it("writes the activity's new time and moves its games with it, in one transaction", async () => {
    const t = makeTx({ games: [{ id: "mon", date: MON }, { id: "next", date: NEXT_MON }] });
    const r = await changeActivityKickoff({ activityId: "vets", orgId: "club", time: "20:15", now: NOW });
    expect(t.calls.activityUpdates).toEqual([{ where: { id: "vets" }, data: { time: "20:15" } }]);
    expect(r).toEqual({
      ok: true,
      activityName: "Monday Vets",
      before: { dayOfWeek: 1, time: "20:30" },
      after: { dayOfWeek: 1, time: "20:15" },
      moved: [
        { matchId: "mon", from: MON, to: at("2026-11-16", "20:15") },
        { matchId: "next", from: NEXT_MON, to: at("2026-11-23", "20:15") },
      ],
      stayed: [],
    });
  });

  it("a new day is written as the day, and the games go to it in their own weeks", async () => {
    const t = makeTx({ games: [{ id: "mon", date: MON }] });
    const r = await changeActivityKickoff({ activityId: "vets", orgId: "club", dayOfWeek: 2, now: NOW });
    expect(t.calls.activityUpdates).toEqual([{ where: { id: "vets" }, data: { dayOfWeek: 2 } }]);
    expect(r.ok && r.moved[0].to).toEqual(at("2026-11-17", "20:30"));
  });

  it("checks the time as the edit form does: an unreadable one writes nothing", async () => {
    const t = makeTx();
    expect(await changeActivityKickoff({ activityId: "vets", orgId: "club", time: "8.15", now: NOW })).toEqual({ ok: false, reason: "invalid" });
    expect(t.calls.activityUpdates).toEqual([]);
  });

  it("the same day and time is unchanged, and writes nothing", async () => {
    const t = makeTx();
    expect(await changeActivityKickoff({ activityId: "vets", orgId: "club", time: "20:30", dayOfWeek: 1, now: NOW })).toEqual({ ok: false, reason: "unchanged", activityName: "Monday Vets", kickoff: { dayOfWeek: 1, time: "20:30" } });
    expect(t.calls.activityUpdates).toEqual([]);
  });

  it("another club's activity is not found, and nothing is written", async () => {
    const t = makeTx({ activity: null });
    expect(await changeActivityKickoff({ activityId: "vets", orgId: "club", time: "20:15", now: NOW })).toEqual({ ok: false, reason: "not-found" });
    expect(t.tx.activity.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "vets", orgId: "club" } }));
    expect(t.calls.activityUpdates).toEqual([]);
  });

  it("nothing is posted or sent", async () => {
    const t = makeTx({ games: [{ id: "mon", date: MON }] });
    await changeActivityKickoff({ activityId: "vets", orgId: "club", time: "20:15", now: NOW });
    expect(t.never).not.toHaveBeenCalled();
  });
});
