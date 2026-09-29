/**
 * SEVERAL DROPS, SEVERAL JOINS, ONE SHEET: Sutton FC, 29 September 2026.
 *
 * Teams published with 14 on the sheet. Then (UTC):
 *
 *   06:29  Elnur   CONFIRMED → DROPPED   (self)
 *   06:55  Burak   CONFIRMED → DROPPED   (admin)
 *   07:15  Abid    CONFIRMED → DROPPED   (self)
 *   07:37  Youssef BENCH     → DROPPED
 *   07:47  Mojib   null      → CONFIRMED (self IN, engine)
 *   07:57  David   BENCH     → DROPPED   (admin)
 *   07:57  Hamzah  null      → CONFIRMED (third-party IN, engine)
 *   08:05  Ozgur   BENCH     → CONFIRMED (bench claim of ELNUR's offer)
 *
 * What prod ended with: Mojib in Burak's slot and Hamzah in Elnur's
 * (both right), ABID STILL ON RED (his slot never passed on) and OZGUR ON
 * NO TEAM, announced as "replacing Elnur" whose slot Hamzah already had.
 *
 * The world below is an in-memory stand-in for the handful of Prisma
 * calls the two seat-assigning paths make, so the REAL
 * `resolveBenchConfirmation` and the REAL `moveNamedSlot` /
 * `fillVacatedSlots` run against it. The engine's half is driven the way
 * `analyze/route.ts` drives it: `decideSlotInherits` over a snapshot,
 * then one `moveNamedSlot` per decided move.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── the in-memory world ─────────────────────────────────────────────────

type Status = "CONFIRMED" | "BENCH" | "DROPPED";
interface Offer {
  id: string;
  replacingUserId: string | null;
  resolvedAt: Date | null;
  claimedByUserId: string | null;
  outcome: string | null;
  createdAt: number;
}

const MATCH = "m1";

class World {
  att = new Map<string, { status: Status; position: number }>();
  tas: Array<{ id: string; userId: string; team: "RED" | "YELLOW" }> = [];
  offers: Offer[] = [];
  jobs: string[] = [];
  events: Array<{ userId: string; note: string | null }> = [];
  locks = 0;
  staleOfferRead = false;
  private seq = 0;
  private clock = 0;
  nextPos = 0;

  confirm(userId: string) {
    const prev = this.att.get(userId);
    this.att.set(userId, { status: "CONFIRMED", position: prev?.position ?? ++this.nextPos });
  }
  /** `cancelAttendance`'s shape: DROPPED, and an offer when a confirmed
   *  player leaves with somebody on the bench to receive it. */
  drop(userId: string) {
    const prev = this.att.get(userId)!;
    this.att.set(userId, { ...prev, status: "DROPPED" });
    const benchExists = [...this.att.values()].some((a) => a.status === "BENCH");
    if (prev.status === "CONFIRMED" && benchExists) {
      this.offers.push({
        id: `offer-${++this.seq}`,
        replacingUserId: userId,
        resolvedAt: null,
        claimedByUserId: null,
        outcome: null,
        createdAt: ++this.clock,
      });
    }
  }
  sheet(team?: "RED" | "YELLOW") {
    return this.tas.filter((t) => !team || t.team === team).map((t) => t.userId);
  }
  openOffers() {
    return this.offers.filter((o) => o.resolvedAt === null);
  }
  confirmedCount() {
    return [...this.att.values()].filter((a) => a.status === "CONFIRMED").length;
  }

  /** Every Prisma call either path makes, and nothing else. */
  client() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const w = this;
    const c = {
      $executeRaw: async () => {
        w.locks++;
        return 1;
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(c),
      attendance: {
        findUnique: async ({ where }: { where: { matchId_userId: { userId: string } } }) => {
          const a = w.att.get(where.matchId_userId.userId);
          return a ? { ...a, match: { activity: { orgId: "org1" } } } : null;
        },
        findMany: async () =>
          [...w.att.entries()].map(([userId, a]) => ({ userId, status: a.status, position: a.position })),
        update: async ({ where, data }: { where: { matchId_userId: { userId: string } }; data: { status: Status } }) => {
          const a = w.att.get(where.matchId_userId.userId)!;
          a.status = data.status;
          return a;
        },
      },
      teamAssignment: {
        findMany: async () => w.tas.map((t) => ({ ...t })),
        count: async () => w.tas.length,
        findUnique: async ({ where }: { where: { matchId_userId: { userId: string } } }) =>
          w.tas.find((t) => t.userId === where.matchId_userId.userId) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: { userId: string } }) => {
          if (w.tas.some((t) => t.userId === data.userId)) throw new Error("unique violation");
          const row = w.tas.find((t) => t.id === where.id);
          if (!row) throw new Error("P2025");
          row.userId = data.userId;
          return row;
        },
        delete: async ({ where }: { where: { matchId_userId: { userId: string } } }) => {
          w.tas = w.tas.filter((t) => t.userId !== where.matchId_userId.userId);
        },
        upsert: async ({ create }: { create: { userId: string; team: "RED" | "YELLOW" } }) => {
          w.tas.push({ id: `ta-z-${create.userId}`, userId: create.userId, team: create.team });
        },
      },
      benchSlotOffer: {
        findMany: async () =>
          // `staleOfferRead`: the read happened a moment before another
          // claimant resolved one of these, which is the race.
          [...(w.staleOfferRead ? w.offers : w.openOffers())]
            .map((o) => ({ ...o }))
            .sort((a, b) => a.createdAt - b.createdAt),
        updateMany: async ({
          where,
          data,
        }: {
          where: { id?: string; replacingUserId?: { in: string[] }; resolvedAt: null };
          data: Partial<Offer>;
        }) => {
          let count = 0;
          for (const o of w.offers) {
            if (o.resolvedAt !== null) continue;
            if (where.id && o.id !== where.id) continue;
            if (where.replacingUserId && !where.replacingUserId.in.includes(o.replacingUserId ?? "")) continue;
            Object.assign(o, data);
            count++;
          }
          return { count };
        },
      },
      user: {
        findUnique: async ({ where }: { where: { id: string } }) => ({ name: NAMES[where.id] ?? where.id }),
      },
      match: {
        findUnique: async () => ({
          maxPlayers: 14,
          teamLabels: [],
          activity: {
            sport: { teamLabels: [] },
            org: { id: "org1", teamLabels: [], language: "en" },
          },
          attendances: [...w.att.values()].filter((a) => a.status === "CONFIRMED"),
        }),
      },
      botJob: {
        create: async ({ data }: { data: { text: string } }) => {
          w.jobs.push(data.text);
        },
      },
    };
    return c;
  }
}

const NAMES: Record<string, string> = {
  elnur: "Elnur Mammadov",
  burak: "Burak Yildiz",
  abid: "Abid Kazmi",
  mojib: "Mojib",
  hamzah: "Hamzah",
  ozgur: "Ozgur",
  youssef: "Youssef",
  david: "David",
};

let world: World;

vi.mock("../db", () => ({
  get db() {
    return world.client();
  },
}));
vi.mock("../attendance-events", () => ({
  recordAttendanceEvent: async (_tx: unknown, t: { userId: string }, ctx: { note?: string | null }) => {
    world.events.push({ userId: t.userId, note: ctx.note ?? null });
  },
}));
vi.mock("../squad-announce", () => ({ announceSquadFullIfJustFilled: async () => {} }));
vi.mock("../team-labels", () => ({ resolveTeamLabels: () => ["Red", "Yellow"] }));

import { resolveBenchConfirmation } from "../bench-confirmation";
import { fillVacatedSlots, moveNamedSlot, type SlotFillTx } from "../team-slot-fill";
import { decideSlotInherits } from "../team-slot-inherit";

// ── the two paths, as production drives them ──────────────────────────

/** `analyze/route.ts`: the engine decides from a snapshot, then the
 *  apply layer moves each decided slot. Returns what it would announce. */
async function engineSettle(w: World): Promise<Array<{ from: string; to: string }>> {
  const decided = decideSlotInherits({
    rows: [...w.att.entries()].map(([userId, a]) => ({ userId, ...a })),
    teams: w.tas.map((t) => ({ userId: t.userId, team: t.team })),
  });
  for (const m of decided) {
    await moveNamedSlot(w.client() as unknown as SlotFillTx, MATCH, m.fromUserId, m.toUserId);
  }
  return decided.map((m) => ({ from: m.fromUserId, to: m.toUserId }));
}

async function benchClaim(userId: string) {
  return resolveBenchConfirmation({ matchId: MATCH, userId, decision: true });
}

const RED = ["burak", "elnur", "abid", "r4", "r5", "r6", "r7"];
const YELLOW = ["y1", "y2", "y3", "y4", "y5", "y6", "y7"];

/** Fourteen confirmed and on the sheet (red block then yellow, the order
 *  the balancer writes), and a bench of three. */
function sutton(): World {
  const w = new World();
  for (const u of [...RED, ...YELLOW]) w.confirm(u);
  w.tas = [
    ...RED.map((userId, i) => ({ id: `ta-${String(i + 1).padStart(2, "0")}`, userId, team: "RED" as const })),
    ...YELLOW.map((userId, i) => ({ id: `ta-${String(i + 8).padStart(2, "0")}`, userId, team: "YELLOW" as const })),
  ];
  for (const u of ["youssef", "david", "ozgur"]) {
    w.att.set(u, { status: "BENCH", position: ++w.nextPos });
  }
  return w;
}

/** No sheet may name somebody who is not playing, and no slot is held
 *  twice. Checked after EVERY step of every scenario. */
function assertSheetHonest(w: World) {
  const holders = w.sheet();
  expect(new Set(holders).size).toBe(holders.length);
}

beforeEach(() => {
  world = sutton();
});

describe("THE INCIDENT, replayed step by step", () => {
  it("ends with Red 7 and Yellow 7, nobody dropped on the sheet, each arrival in the slot it inherited", async () => {
    world.drop("elnur"); // 06:29
    world.drop("burak"); // 06:55
    world.drop("abid"); // 07:15
    world.drop("youssef"); // 07:37 (bench, no slot)
    expect(world.openOffers().map((o) => o.replacingUserId)).toEqual(["elnur", "burak", "abid"]);

    world.confirm("mojib"); // 07:47
    expect(await engineSettle(world)).toEqual([{ from: "burak", to: "mojib" }]);
    assertSheetHonest(world);

    world.drop("david"); // 07:57 (bench)
    world.confirm("hamzah"); // 07:57
    expect(await engineSettle(world)).toEqual([{ from: "elnur", to: "hamzah" }]);
    assertSheetHonest(world);

    // Refilled slots are no longer advertised to the bench.
    expect(world.openOffers().map((o) => o.replacingUserId)).toEqual(["abid"]);

    const res = await benchClaim("ozgur"); // 08:05
    expect(res).toMatchObject({ kind: "confirmed", droppedUserName: "Abid Kazmi", teamLabel: "Red" });

    expect(world.sheet("RED")).toEqual(["mojib", "hamzah", "ozgur", "r4", "r5", "r6", "r7"]);
    expect(world.sheet("YELLOW")).toEqual(YELLOW);
    for (const u of world.sheet()) expect(world.att.get(u)?.status).toBe("CONFIRMED");
    expect(world.confirmedCount()).toBe(14);

    // The words name the slot actually inherited.
    const post = world.jobs.at(-1)!;
    expect(post).toContain("*Ozgur*");
    expect(post).toContain("*Abid Kazmi*");
    expect(post).not.toContain("Elnur");
    // And so does the audit log.
    expect(world.events.at(-1)).toEqual({ userId: "ozgur", note: "claimed the slot vacated by abid" });
    expect(world.openOffers()).toEqual([]);
  });
});

describe("the sibling interleavings", () => {
  it("two drops, then two joins in ONE batch: first joiner takes the first vacancy on the sheet", async () => {
    world.drop("elnur");
    world.drop("abid");
    world.confirm("mojib");
    world.confirm("hamzah");
    expect(await engineSettle(world)).toEqual([
      { from: "elnur", to: "mojib" },
      { from: "abid", to: "hamzah" },
    ]);
    expect(world.sheet("RED")).toEqual(["burak", "mojib", "hamzah", "r4", "r5", "r6", "r7"]);
  });

  it("two drops, then two bench claims: each claimant gets a DIFFERENT slot, never the same one twice", async () => {
    world.drop("elnur");
    world.drop("abid");
    const a = await benchClaim("youssef");
    const b = await benchClaim("david");
    expect(a).toMatchObject({ kind: "confirmed", droppedUserName: "Elnur Mammadov" });
    expect(b).toMatchObject({ kind: "confirmed", droppedUserName: "Abid Kazmi" });
    expect(world.sheet("RED")).toEqual(["burak", "youssef", "david", "r4", "r5", "r6", "r7"]);
  });

  it("join BEFORE drop: the early joiner has no slot until one is vacated, then inherits it", async () => {
    world.confirm("mojib"); // over the sheet: nothing to inherit yet
    expect(await engineSettle(world)).toEqual([]);
    expect(world.sheet()).not.toContain("mojib");
    world.drop("abid");
    expect(await engineSettle(world)).toEqual([{ from: "abid", to: "mojib" }]);
    expect(world.sheet("RED")).toEqual(["burak", "elnur", "mojib", "r4", "r5", "r6", "r7"]);
  });

  it("a BENCH player's drop vacates no slot and moves nothing", async () => {
    world.drop("david");
    expect(await engineSettle(world)).toEqual([]);
    expect(world.sheet("RED")).toEqual(RED);
    expect(world.openOffers()).toEqual([]);
  });

  it("a dropped player who re-joins BEFORE anyone inherits keeps his own slot", async () => {
    world.drop("elnur");
    world.confirm("elnur");
    expect(await engineSettle(world)).toEqual([]);
    expect(world.sheet("RED")).toEqual(RED);
  });

  it("a dropped player who re-joins AFTER his slot was inherited is not put back, and nobody is listed twice", async () => {
    world.drop("elnur");
    world.confirm("mojib");
    await engineSettle(world);
    world.confirm("elnur");
    expect(await engineSettle(world)).toEqual([]);
    expect(world.sheet("RED")).toEqual(["burak", "mojib", "abid", "r4", "r5", "r6", "r7"]);
    assertSheetHonest(world);
  });

  it("a bench claim with no vacated slot to inherit is announced as an open slot, naming nobody", async () => {
    // The squad is short without a sheet vacancy: somebody dropped whose
    // slot a joiner already took, and one more claim arrives.
    world.drop("elnur");
    world.confirm("mojib");
    await engineSettle(world);
    world.offers.push({
      id: "offer-stray",
      replacingUserId: "elnur",
      resolvedAt: null,
      claimedByUserId: null,
      outcome: null,
      createdAt: 99,
    });
    const res = await benchClaim("ozgur");
    expect(res).toMatchObject({ kind: "confirmed", droppedUserName: null, teamLabel: null });
    expect(world.sheet()).not.toContain("ozgur");
    expect(world.jobs.at(-1)).not.toContain("Elnur");
  });
});

describe("concurrency: a decision taken on a stale snapshot", () => {
  it("a bench claim that loses the race for the oldest offer takes the next open one instead of being turned away", async () => {
    world.drop("elnur");
    world.drop("abid");
    // Youssef's claim resolves Elnur's offer; David read the offers just
    // before that and still sees it open.
    await benchClaim("youssef");
    world.staleOfferRead = true;
    const res = await benchClaim("david");
    expect(res).toMatchObject({ kind: "confirmed", droppedUserName: "Abid Kazmi" });
    expect(world.sheet("RED")).toEqual(["burak", "youssef", "david", "r4", "r5", "r6", "r7"]);
  });


  it("the engine decided Elnur's slot for Hamzah, a bench claim took it first: refused, and Hamzah is healed into the slot still free", async () => {
    world.drop("elnur");
    world.drop("abid");
    world.confirm("hamzah");
    const stale = decideSlotInherits({
      rows: [...world.att.entries()].map(([userId, a]) => ({ userId, ...a })),
      teams: world.tas.map((t) => ({ userId: t.userId, team: t.team })),
    });
    expect(stale).toEqual([
      { fromUserId: "elnur", toUserId: "hamzah", team: "RED" },
    ]);
    // A bench claim lands between the engine's read and its write. The
    // lowest-position arrival (Hamzah) is seated first by the fill, the
    // claimant gets what is left.
    await benchClaim("ozgur");
    const res = await moveNamedSlot(world.client() as unknown as SlotFillTx, MATCH, "elnur", "hamzah");
    expect(res.kind).toBe("refused");
    const held = world.sheet("RED");
    expect(held).toContain("hamzah");
    expect(held).toContain("ozgur");
    expect(held).not.toContain("elnur");
    expect(held).not.toContain("abid");
    assertSheetHonest(world);
  });

  it("every seat change takes the per-match lock", async () => {
    world.drop("elnur");
    world.confirm("mojib");
    const before = world.locks;
    await fillVacatedSlots(world.client() as unknown as SlotFillTx, MATCH);
    expect(world.locks).toBeGreaterThan(before);
  });
});
