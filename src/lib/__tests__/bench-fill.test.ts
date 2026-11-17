/**
 * THE BENCH FILLS AN OPEN PLACE, against an in-memory stand-in for the
 * Prisma calls `bench-fill.ts` makes (2026-11-17).
 *
 * The incident: Sutton FC, Tue 17 Nov 2026, 21:30 7-a-side, 14 places.
 * David dropped by the organiser, Recai on the bench. MatchTime said
 * "13/14, need 1 more" beside "Bench (1): Recai" and raced Recai alone
 * for the place. Here the REAL `fillOpenPlacesFromBench`, the REAL
 * `requestBenchConfirmationOnDrop` and the REAL team-slot fill run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Status = "CONFIRMED" | "BENCH" | "DROPPED";
const MATCH = "m1";
const ORG = "org1";
const HOUR = 3_600_000;

class World {
  match = {
    id: MATCH,
    date: new Date(Date.now() + 8 * HOUR),
    status: "UPCOMING",
    maxPlayers: 14,
    teamLabels: [] as string[],
  };
  org = {
    benchPickMode: "first-come",
    featureBench: true,
    language: "en",
    squadMode: "weekly",
    listAnnouncer: "matchtime",
    teamLabels: [] as string[],
  };
  att = new Map<string, { id: string; status: Status; position: number; respondedAt: Date; benchByChoice: boolean }>();
  /** What `adminNoticeSendAfter` answers (quiet hours): null = send now. */
  quietUntil: Date | null = null;
  /** A write that lands right after the fill moves somebody up (a racing
   *  OUT that waited on the squad lock): armed by the move, run on the
   *  next read. */
  raceAfterMove: (() => void) | null = null;
  private pendingRace: (() => void) | null = null;
  runRace() {
    const f = this.pendingRace;
    this.pendingRace = null;
    f?.();
  }
  armRace() {
    this.pendingRace = this.raceAfterMove;
    this.raceAfterMove = null;
  }
  names = new Map<string, string>();
  phones = new Map<string, string | null>();
  optedOut = new Set<string>();
  events: Array<{ userId: string; fromStatus: string | null; toStatus: string | null; note: string | null; cause?: string; at: number }> = [];
  offers: Array<{ id: string; replacingUserId: string | null; resolvedAt: Date | null; claimedByUserId: string | null; outcome: string | null; createdAt: number }> = [];
  tas: Array<{ id: string; userId: string; team: "RED" | "YELLOW" }> = [];
  jobs: Array<{ kind: string; phone?: string | null; text: string; sendAfter?: Date | null; mentions?: string[] }> = [];
  adminNotices: string[] = [];
  squadCompleteCalls: Array<{ lead?: string | null; mentions?: string[]; sendAfter?: Date | null }> = [];
  squadCompleteResult: "group" | "organisers" | null = "group";
  /** An attendance change on the match within the last two minutes. */
  recentChange = false;
  private clock = 0;
  private seq = 0;

  add(userId: string, status: Status, opts: { name?: string; phone?: string | null } = {}) {
    const position = this.att.size + 1;
    this.att.set(userId, { id: `a-${userId}`, status, position, respondedAt: new Date(1_000 * position), benchByChoice: false });
    this.names.set(userId, opts.name ?? userId);
    this.phones.set(userId, opts.phone === undefined ? `+447700900${String(100 + position).padStart(3, "0")}` : opts.phone);
    this.events.push({ userId, fromStatus: null, toStatus: status, note: status === "BENCH" ? "squad full, no slot to give" : null, at: ++this.clock });
  }
  set(userId: string, status: Status, note: string | null = null) {
    const row = this.att.get(userId)!;
    this.events.push({ userId, fromStatus: row.status, toStatus: status, note, at: ++this.clock });
    row.status = status;
  }
  count(status: Status) {
    return [...this.att.values()].filter((a) => a.status === status).length;
  }
  statusOf(userId: string) {
    return this.att.get(userId)?.status;
  }
  openOffer(replacingUserId: string | null) {
    this.offers.push({ id: `o${++this.seq}`, replacingUserId, resolvedAt: null, claimedByUserId: null, outcome: null, createdAt: ++this.clock });
  }

  db() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const w = this;
    const rowsOf = () => [...w.att.entries()].map(([userId, a]) => ({ userId, ...a }));
    const client = {
      $executeRaw: async () => 0,
      $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
      match: {
        findUnique: async () => ({
          ...w.match,
          attendances: rowsOf().map((r) => ({ userId: r.userId, status: r.status })),
          activity: { name: "Tuesday 7-a-side", orgId: ORG, sport: { teamLabels: [] }, org: { ...w.org } },
        }),
        findMany: async () => [
          { id: MATCH, maxPlayers: w.match.maxPlayers, attendances: rowsOf().filter((r) => r.status !== "DROPPED").map((r) => ({ status: r.status })) },
        ],
      },
      organisation: { findUnique: async () => ({ benchPickMode: w.org.benchPickMode, featureBench: w.org.featureBench }) },
      attendance: {
        findMany: async (args: { where: { status?: Status | { in: Status[] }; userId?: { in: string[] } } }) => {
          w.runRace();
          const st = args.where.status;
          return rowsOf().filter(
            (r) =>
              (!st || (typeof st === "string" ? r.status === st : st.in.includes(r.status))) &&
              (!args.where.userId || args.where.userId.in.includes(r.userId)),
          );
        },
        updateMany: async (args: { where: { id: string; status: Status }; data: { status: Status; benchByChoice?: boolean } }) => {
          const hit = rowsOf().find((r) => r.id === args.where.id && r.status === args.where.status);
          if (!hit) return { count: 0 };
          w.att.get(hit.userId)!.status = args.data.status;
          if (args.data.benchByChoice !== undefined) w.att.get(hit.userId)!.benchByChoice = args.data.benchByChoice;
          if (args.data.status === "CONFIRMED") w.armRace();
          return { count: 1 };
        },
        count: async (args: { where: { status: Status } }) => w.count(args.where.status),
      },
      attendanceEvent: {
        // The sweep's two-minute grace: a change on the match just now.
        findFirst: async () => (w.recentChange ? { id: "e-recent" } : null),
        findMany: async (args: { where: { userId: { in: string[] }; toStatus: string } }) =>
          w.events
            .filter((e) => args.where.userId.in.includes(e.userId) && e.toStatus === args.where.toStatus)
            .sort((a, b) => a.at - b.at),
        create: async (args: { data: { userId: string; fromStatus: string | null; toStatus: string | null; note: string | null; cause: string } }) => {
          w.events.push({ ...args.data, at: ++w.clock });
          return args.data;
        },
      },
      teamAssignment: {
        findMany: async () => w.tas.map((t) => ({ ...t })),
        update: async (args: { where: { id: string }; data: { userId: string } }) => {
          w.tas.find((t) => t.id === args.where.id)!.userId = args.data.userId;
        },
        count: async () => w.tas.length,
      },
      benchSlotOffer: {
        findMany: async () => w.offers.filter((o) => !o.resolvedAt).sort((a, b) => a.createdAt - b.createdAt),
        updateMany: async (args: { where: { id?: string; replacingUserId?: { in: string[] } }; data: Record<string, unknown> }) => {
          let count = 0;
          for (const o of w.offers) {
            if (o.resolvedAt) continue;
            if (args.where.id && o.id !== args.where.id) continue;
            if (args.where.replacingUserId && !args.where.replacingUserId.in.includes(o.replacingUserId ?? "")) continue;
            Object.assign(o, args.data);
            count++;
          }
          return { count };
        },
        create: async (args: { data: { replacingUserId: string | null } }) => w.openOffer(args.data.replacingUserId),
        findFirst: async () => null,
      },
      user: {
        findMany: async (args: { where: { id: { in: string[] } } }) =>
          args.where.id.in.map((id) => ({ id, name: w.names.get(id) ?? null, phoneNumber: w.phones.get(id) ?? null })),
        findUnique: async (args: { where: { id: string } }) => ({ name: w.names.get(args.where.id) ?? null }),
      },
      membership: {
        findMany: async (args: { where: { userId: { in: string[] } } }) =>
          args.where.userId.in.filter((u) => w.optedOut.has(u)).map((userId) => ({ userId })),
      },
      botJob: {
        create: async (args: { data: { kind: string; phone?: string | null; text: string; sendAfter?: Date | null; mentions?: string[] } }) => {
          w.jobs.push(args.data);
          return args.data;
        },
      },
    };
    return client;
  }
}

let world: World;

vi.mock("@/lib/db", () => ({
  get db() {
    return world.db();
  },
}));
vi.mock("../db", () => ({
  get db() {
    return world.db();
  },
}));
vi.mock("../squad-announce", () => ({
  announceSquadFullIfJustFilled: async (_m: string, opts: { lead?: string | null } = {}) => {
    world.squadCompleteCalls.push(opts);
    return world.squadCompleteResult;
  },
}));
vi.mock("../admin-channel", () => ({
  sendAdminNotice: async (req: { text: string }) => {
    world.adminNotices.push(req.text);
    return { channel: "dm", queued: 1 };
  },
}));
vi.mock("../club-quiet-hours", () => ({ loadClubQuietHours: async () => ({ on: false, from: "23:00", to: "09:00" }) }));
vi.mock("../rolling-squad-rules", () => ({ adminNoticeSendAfter: () => world.quietUntil }));
const monthlyHook = vi.fn();
const payg = vi.fn();
vi.mock("../monthly-week", () => ({
  afterMonthlyAttendanceChange: (...a: unknown[]) => monthlyHook(...a),
  ensureOpenPlaceOffers: (...a: unknown[]) => payg(...a),
}));

import { fillOpenPlacesFromBench, sweepBenchFill } from "../bench-fill";
import { requestBenchConfirmationOnDrop } from "../bot-scheduler";

const PLAYERS = ["kemal", "elvin", "idris", "wasim", "habib", "elnur", "mustafa", "ibrahim", "david", "aydin", "sait", "ersan", "ersin", "abu"];

/** The squad at 13:33: fourteen confirmed, Recai on the bench, David out. */
function incident(): World {
  const w = new World();
  for (const p of PLAYERS) w.add(p, "CONFIRMED", { name: p === "david" ? "David" : p });
  w.add("recai", "BENCH", { name: "Recai Gunay" });
  w.set("david", "DROPPED");
  return w;
}

beforeEach(() => {
  monthlyHook.mockReset();
  payg.mockReset();
});

describe("a drop in a first-come club", () => {
  it("THE INCIDENT: Recai moves up, is DMed, the group line names him, no offer is opened", async () => {
    world = incident();
    await requestBenchConfirmationOnDrop(MATCH, "david");

    expect(world.statusOf("recai")).toBe("CONFIRMED");
    expect(world.count("CONFIRMED")).toBe(14);
    expect(world.count("BENCH")).toBe(0);
    expect(world.offers).toEqual([]);

    const moved = world.events.filter((e) => e.cause === "bench-moved-up");
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ userId: "recai", fromStatus: "BENCH", toStatus: "CONFIRMED" });

    // The squad is full again: the line rides on the squad-complete post.
    expect(world.squadCompleteCalls).toEqual([{ lead: "⬆️ *Recai Gunay* moves up from the bench, replacing *David* 🙌", sendAfter: null, mentions: [] }]);
    expect(world.jobs.filter((j) => j.kind === "group")).toEqual([]);

    const dms = world.jobs.filter((j) => j.kind === "dm");
    expect(dms).toHaveLength(1);
    expect(dms[0].phone).toBe(world.phones.get("recai")!.replace(/^\+/, ""));
    expect(dms[0].text).toContain("Hi Recai, a place opened for Tuesday 7-a-side");
    expect(dms[0].text).toContain("reply *OUT* here");
    expect(dms[0].text).not.toMatch(/first to claim/i);
  });

  it("two on the bench: the first in bench order moves up, the second stays", async () => {
    world = incident();
    world.add("zed", "BENCH", { name: "Zed" });
    await requestBenchConfirmationOnDrop(MATCH, "david");
    expect(world.statusOf("recai")).toBe("CONFIRMED");
    expect(world.statusOf("zed")).toBe("BENCH");
    expect(world.offers).toEqual([]);
  });

  it("the squad-complete post not the group's to make (teams out, monthly list): the line goes on its own, with the count", async () => {
    world = incident();
    world.squadCompleteResult = null;
    await requestBenchConfirmationOnDrop(MATCH, "david");
    expect(world.jobs.filter((j) => j.kind === "group").map((j) => j.text)).toEqual([
      "⬆️ *Recai Gunay* moves up from the bench, replacing *David*. Squad *14/14* 🙌",
    ]);
  });

  it("with a team sheet he takes David's slot and the line names the team", async () => {
    world = incident();
    world.tas = PLAYERS.map((p, i) => ({ id: `t${String(i).padStart(2, "0")}`, userId: p, team: i % 2 === 0 ? "RED" : "YELLOW" }));
    world.squadCompleteResult = null; // teams out: the roster is not the news
    await requestBenchConfirmationOnDrop(MATCH, "david");
    expect(world.tas.find((t) => t.userId === "recai")?.team).toBe("RED");
    expect(world.tas.some((t) => t.userId === "david")).toBe(false);
    const line = world.jobs.find((j) => j.kind === "group")!.text;
    expect(line.split("\n")[0]).toBe("⬆️ *Recai Gunay* moves up from the bench and takes *David*'s place on *Red* 🙌");
  });

  it("a player who switched bench messages off still moves up, but gets no DM", async () => {
    world = incident();
    world.optedOut.add("recai");
    await requestBenchConfirmationOnDrop(MATCH, "david");
    expect(world.statusOf("recai")).toBe("CONFIRMED");
    expect(world.jobs.filter((j) => j.kind === "dm")).toEqual([]);
  });

  it("a player who chose the bench while places were open is left there; nobody else waiting means no race either", async () => {
    world = new World();
    for (const p of PLAYERS) world.add(p, "CONFIRMED");
    world.add("chose", "BENCH");
    world.att.get("chose")!.benchByChoice = true;
    world.set("david", "DROPPED");
    await requestBenchConfirmationOnDrop(MATCH, "david");
    expect(world.statusOf("chose")).toBe("BENCH");
    expect(world.offers).toEqual([]);
    expect(world.jobs).toEqual([]);
  });

  it("a reserve who asked for the bench on a FULL squad moves up in his turn", async () => {
    world = incident();
    // benchByChoice false: asked for the bench when there was no room.
    await requestBenchConfirmationOnDrop(MATCH, "david");
    expect(world.statusOf("recai")).toBe("CONFIRMED");
  });

  it("then the moved-up player says OUT: the next one on the bench moves up", async () => {
    world = incident();
    world.add("zed", "BENCH", { name: "Zed" });
    await requestBenchConfirmationOnDrop(MATCH, "david");
    world.set("recai", "DROPPED");
    world.squadCompleteCalls = [];
    await requestBenchConfirmationOnDrop(MATCH, "recai");
    expect(world.statusOf("zed")).toBe("CONFIRMED");
    expect(world.squadCompleteCalls[0].lead).toBe("⬆️ *Zed* moves up from the bench, replacing *Recai Gunay* 🙌");
  });

  it("then the moved-up player says OUT with nobody left: the place stays open, no offer, no race", async () => {
    world = incident();
    await requestBenchConfirmationOnDrop(MATCH, "david");
    world.set("recai", "DROPPED");
    const jobsBefore = world.jobs.length;
    await requestBenchConfirmationOnDrop(MATCH, "recai");
    expect(world.count("CONFIRMED")).toBe(13);
    expect(world.offers).toEqual([]);
    expect(world.jobs.length).toBe(jobsBefore);
  });

  it("an old open offer is closed when the bench fills its place", async () => {
    world = incident();
    world.openOffer("david");
    await fillOpenPlacesFromBench(MATCH, { actorKind: "scheduler", sourceRef: "scheduler:bench-fill" });
    expect(world.offers[0]).toMatchObject({ outcome: "bench-moved-up", claimedByUserId: "recai" });
    expect(world.offers[0].resolvedAt).not.toBeNull();
  });
});

describe("telling him reliably (review of #622)", () => {
  it("opted out of bench DMs: no DM, and he is @tagged in the group line", async () => {
    world = incident();
    world.optedOut.add("recai");
    world.squadCompleteResult = null;
    await requestBenchConfirmationOnDrop(MATCH, "david");
    const phone = world.phones.get("recai")!.replace(/^\+/, "");
    const line = world.jobs.find((j) => j.kind === "group")!;
    expect(line.text).toContain(`⬆️ @${phone} moves up from the bench`);
    expect(line.mentions).toEqual([phone]);
    expect(world.jobs.filter((j) => j.kind === "dm")).toEqual([]);
  });

  it("quiet hours would hold the DM past kickoff: the DM goes now and he is tagged", async () => {
    world = incident();
    world.quietUntil = new Date(world.match.date.getTime() + HOUR); // quiet ends after kickoff
    await requestBenchConfirmationOnDrop(MATCH, "david");
    const dm = world.jobs.find((j) => j.kind === "dm")!;
    expect(dm.sendAfter ?? null).toBeNull();
    expect(world.squadCompleteCalls[0].mentions).toEqual([world.phones.get("recai")!.replace(/^\+/, "")]);
  });

  it("quiet hours ending before kickoff: the DM waits for them, no tag", async () => {
    world = incident();
    const until = new Date(world.match.date.getTime() - HOUR);
    world.quietUntil = until;
    await requestBenchConfirmationOnDrop(MATCH, "david");
    expect(world.jobs.find((j) => j.kind === "dm")!.sendAfter).toEqual(until);
    expect(world.squadCompleteCalls[0].mentions).toEqual([]);
  });

  it("an OUT that lands right after the fill: no DM and no line for him", async () => {
    world = incident();
    world.raceAfterMove = () => {
      world.att.get("recai")!.status = "DROPPED";
    };
    await requestBenchConfirmationOnDrop(MATCH, "david");
    expect(world.jobs.filter((j) => j.kind === "dm")).toEqual([]);
    expect(world.squadCompleteCalls).toEqual([]);
    expect(world.jobs.filter((j) => j.kind === "group")).toEqual([]);
  });
});

describe("one message per fill when the organisers announce (review of #622)", () => {
  it("the squad completes: the line rides on their list update, no relay as well", async () => {
    world = incident();
    world.org.listAnnouncer = "organisers";
    world.squadCompleteResult = "organisers";
    await requestBenchConfirmationOnDrop(MATCH, "david");
    expect(world.squadCompleteCalls).toHaveLength(1);
    expect(world.adminNotices).toEqual([]);
    expect(world.jobs.filter((j) => j.kind === "group")).toEqual([]);
  });

  it("not complete: one relay to them, nothing in the players' group, no tags", async () => {
    world = incident();
    world.org.listAnnouncer = "organisers";
    world.add("zed", "BENCH");
    world.set("elvin", "DROPPED"); // two places open, one waiting... then the other
    world.att.get("zed")!.benchByChoice = true;
    world.optedOut.add("recai");
    await requestBenchConfirmationOnDrop(MATCH, "david");
    expect(world.adminNotices).toHaveLength(1);
    expect(world.adminNotices[0]).toContain("*Recai Gunay* moves up from the bench");
    expect(world.jobs.filter((j) => j.kind === "group")).toEqual([]);
  });
});

describe("a monthly club", () => {
  it("the first on the bench moves up and the month's bookkeeping runs for him", async () => {
    world = incident();
    world.org.squadMode = "monthly";
    await requestBenchConfirmationOnDrop(MATCH, "david");
    expect(world.statusOf("recai")).toBe("CONFIRMED");
    expect(monthlyHook).toHaveBeenCalledWith(MATCH, "recai", true);
  });

  it("nobody waiting: the place goes to the pay-as-you-go players, as before", async () => {
    world = new World();
    world.org.squadMode = "monthly";
    for (const p of PLAYERS) world.add(p, "CONFIRMED");
    world.set("david", "DROPPED");
    await requestBenchConfirmationOnDrop(MATCH, "david");
    expect(payg).toHaveBeenCalledWith(MATCH);
  });
});

describe("clubs the bench does not fill for", () => {
  it("an organiser-pick club: nobody moves, no offer (the organisers are asked)", async () => {
    world = incident();
    world.org.benchPickMode = "organiser";
    await requestBenchConfirmationOnDrop(MATCH, "david");
    expect(world.statusOf("recai")).toBe("BENCH");
    expect(world.offers).toEqual([]);
    expect(world.jobs).toEqual([]);
  });

  it("the bench switched off: as before, an offer row and nobody moved", async () => {
    world = incident();
    world.org.featureBench = false;
    await requestBenchConfirmationOnDrop(MATCH, "david");
    expect(world.statusOf("recai")).toBe("BENCH");
    expect(world.offers).toHaveLength(1);
  });

  it("a match that has kicked off: nobody moves", async () => {
    world = incident();
    world.match.date = new Date(Date.now() - HOUR);
    expect(await fillOpenPlacesFromBench(MATCH, { actorKind: "system", sourceRef: "x" })).toEqual({ moved: [] });
    expect(world.statusOf("recai")).toBe("BENCH");
  });
});

describe("the scheduler's safety net", () => {
  it("heals a squad left short beside a bench by any other path", async () => {
    world = incident();
    expect(await sweepBenchFill(ORG)).toBe(1);
    expect(world.statusOf("recai")).toBe("CONFIRMED");
    // A second poll has nothing to do.
    expect(await sweepBenchFill(ORG)).toBe(0);
  });

  it("leaves a match alone for two minutes after a change (an organiser's remove-then-add on the match page)", async () => {
    world = incident();
    world.recentChange = true;
    expect(await sweepBenchFill(ORG)).toBe(0);
    expect(world.statusOf("recai")).toBe("BENCH");
    world.recentChange = false;
    expect(await sweepBenchFill(ORG)).toBe(1);
  });

  it("does nothing for an organiser-pick club", async () => {
    world = incident();
    world.org.benchPickMode = "organiser";
    expect(await sweepBenchFill(ORG)).toBe(0);
    expect(world.statusOf("recai")).toBe("BENCH");
  });
});
