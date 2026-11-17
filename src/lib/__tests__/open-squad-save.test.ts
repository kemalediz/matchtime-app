/**
 * SWITCHING THE OPEN SQUAD ON OR OFF (2026-11-17, and review of #623): the
 * one core the settings page and the WhatsApp tag both use (`setOpenSquad`).
 *
 *   on   the flag and the bench promotion are ONE transaction: every
 *        BENCH row on a game still to be played goes straight to CONFIRMED
 *        (no attendance-writer guards in the way), each with its event,
 *        and the reply names them. Idempotent: "already on" still empties
 *        any bench left behind. No format is asked for.
 *   off  the flag is cleared; the places fall back to the format, and
 *        nobody is bumped (the month's cap is lifted for the rest of the
 *        month: `squad-month.ts`, tested in open-squad-off-monthly).
 *   same nothing is written to the flag; the reply says it was already so.
 *
 * And the safety net: while the setting is on, any BENCH row on an upcoming
 * match is promoted by the same function (`promoteOpenSquadBench`), run
 * from the scheduler's existing bench sweep.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  org: { openSquad: false, language: "en" as string | null },
  bench: [] as Array<{ id: string; matchId: string; userId: string; position: number; user: { name: string | null } }>,
  promoted: [] as string[],
  events: [] as Array<{ userId: string; fromStatus: string; toStatus: string; cause: string }>,
  updates: [] as Array<Record<string, unknown>>,
  inTx: false,
  txWrites: [] as string[],
}));

vi.mock("../db", () => {
  const client = {
    organisation: {
      findUnique: async () => ({ ...h.org }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        h.updates.push(data);
        h.txWrites.push(h.inTx ? "org:tx" : "org:no-tx");
        if (typeof data.openSquad === "boolean") h.org.openSquad = data.openSquad;
        return { ...h.org };
      },
    },
    attendance: {
      findMany: async () => h.bench.filter((b) => !h.promoted.includes(b.userId)),
      updateMany: async ({ where }: { where: { id: string; status: string } }) => {
        const row = h.bench.find((b) => b.id === where.id);
        if (!row || h.promoted.includes(row.userId)) return { count: 0 };
        h.promoted.push(row.userId);
        h.txWrites.push(h.inTx ? "att:tx" : "att:no-tx");
        return { count: 1 };
      },
    },
    attendanceEvent: {
      create: async ({ data }: { data: { userId: string; fromStatus: string; toStatus: string; cause: string } }) => {
        h.events.push(data);
        return {};
      },
    },
    activity: {
      findFirst: async () => ({ name: "Football 7-a-side", minPlayers: 12, sport: { playersPerTeam: 7 }, matches: [{ maxPlayers: 14 }] }),
    },
    match: { findMany: async () => [] },
    $executeRaw: async () => 0,
  };
  return {
    db: {
      ...client,
      $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => {
        h.inTx = true;
        try {
          return await fn(client);
        } finally {
          h.inTx = false;
        }
      },
    },
  };
});
vi.mock("../open-squad-seat", () => ({ seatOpenSquadLateIns: vi.fn(async () => ({ seated: 0 })) }));
vi.mock("../monthly-week", () => ({ afterMonthlyAttendanceChange: vi.fn(async () => {}) }));
const lift = vi.hoisted(() => vi.fn(async () => 1));
vi.mock("../squad-month", () => ({ liftMonthCapForOpenSquadOff: lift }));

import { promoteOpenSquadBench, setOpenSquad } from "../open-squad-save";

const NOW = new Date("2026-11-17T18:00:00Z");
const benchRow = (userId: string, name: string, matchId = "m1") => ({ id: `a-${userId}`, matchId, userId, position: 15, user: { name } });

beforeEach(() => {
  h.org = { openSquad: false, language: "en" };
  h.bench = [];
  h.promoted = [];
  h.events = [];
  h.updates = [];
  h.txWrites = [];
});

describe("setOpenSquad", () => {
  it("on: sets the flag, records it as the organiser's choice, and says what it means", async () => {
    const r = await setOpenSquad({ orgId: "vets", on: true, actorUserId: "owner", now: NOW });
    expect(r.outcome).toBe("open-squad-on");
    expect(h.org.openSquad).toBe(true);
    expect(h.updates[0]).toMatchObject({ openSquad: true, settingsSetByOrganiser: { push: ["openSquad"] } });
    expect(r.replyText).toBe(
      "✅ Done: no squad limit and no bench from now on. Everyone who says *IN* plays, and the teams are split evenly between whoever is in. I'll only ask for players while you're below 12.",
    );
  });

  it("on: the flag and every bench row promoted in ONE transaction, straight to CONFIRMED, each with its event, and named", async () => {
    h.bench = [benchRow("recai", "Recai Demir"), benchRow("ali", "Ali Khan")];
    const r = await setOpenSquad({ orgId: "vets", on: true, actorUserId: "owner", now: NOW });
    expect(h.promoted).toEqual(["recai", "ali"]);
    expect(h.txWrites).toEqual(["org:tx", "att:tx", "att:tx"]);
    expect(h.events).toEqual([
      expect.objectContaining({ userId: "recai", fromStatus: "BENCH", toStatus: "CONFIRMED", cause: "bench-moved-up" }),
      expect.objectContaining({ userId: "ali", fromStatus: "BENCH", toStatus: "CONFIRMED", cause: "bench-moved-up" }),
    ]);
    expect(r.replyText).toContain("Recai Demir and Ali Khan were on the bench and are in now.");
  });

  it("already on: no flag write, but a bench left behind is still emptied (idempotent)", async () => {
    h.org.openSquad = true;
    h.bench = [benchRow("recai", "Recai Demir")];
    const r = await setOpenSquad({ orgId: "vets", on: true, actorUserId: "owner", now: NOW });
    expect(r.outcome).toBe("open-squad-unchanged");
    expect(h.updates).toHaveLength(0);
    expect(h.promoted).toEqual(["recai"]);
    expect(r.replyText).toContain("No change: there is already no squad limit.");
    expect(r.replyText).toContain("Recai Demir was on the bench and is in now.");
    // A second time: nothing left to do.
    h.events = [];
    await setOpenSquad({ orgId: "vets", on: true, actorUserId: "owner", now: NOW });
    expect(h.events).toEqual([]);
  });

  it("off: clears the flag, nobody is moved, and the reply names the game's own places", async () => {
    h.org.openSquad = true;
    const r = await setOpenSquad({ orgId: "vets", on: false, actorUserId: "owner", now: NOW });
    expect(r.outcome).toBe("open-squad-off");
    expect(h.org.openSquad).toBe(false);
    expect(h.promoted).toEqual([]);
    // The running month keeps room for every regular it signed.
    expect(lift).toHaveBeenCalledWith("vets", NOW);
    expect(r.replyText).toBe(
      "✅ Done: the squad has a limit again, *Football 7-a-side* with 14 places. Everyone already in stays in; anyone who says *IN* after it is full goes on the bench.",
    );
  });

  it("Turkish", async () => {
    h.org = { openSquad: false, language: "tr" };
    const on = await setOpenSquad({ orgId: "vets", on: true, actorUserId: "owner", now: NOW });
    expect(on.replyText).toBe(
      "✅ Tamam: artık kadro sınırı ve yedek yok. *VARIM* yazan herkes oynar, takımlar gelenler arasında eşit bölünür. Yalnızca 12 kişinin altındayken oyuncu ararım.",
    );
  });
});

describe("promoteOpenSquadBench (the safety net)", () => {
  it("with the setting on: every bench row of an upcoming game is promoted", async () => {
    h.org.openSquad = true;
    h.bench = [benchRow("recai", "Recai Demir"), benchRow("zed", "Zed", "m2")];
    expect(await promoteOpenSquadBench("vets", NOW)).toBe(2);
    expect(h.promoted).toEqual(["recai", "zed"]);
    expect(h.events.every((e) => e.cause === "bench-moved-up")).toBe(true);
  });

  it("off: nothing", async () => {
    h.bench = [benchRow("recai", "Recai Demir")];
    expect(await promoteOpenSquadBench("vets", NOW)).toBe(0);
    expect(h.promoted).toEqual([]);
  });
});
