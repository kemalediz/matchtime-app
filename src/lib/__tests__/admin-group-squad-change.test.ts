/**
 * One squad change typed in the admin group (2026-10-14): the wiring.
 * Since 2026-10-16 the SHARED router has already run
 * (`admin-group-understand.ts`) and its route is handed in. The attendance
 * engine is mocked at its module boundary; what is under test is what this
 * module hands it and what it says back. No database, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  attendance: { findUnique: vi.fn(), count: vi.fn() },
  match: { findUnique: vi.fn() },
  user: { findMany: vi.fn() },
  membership: { findMany: vi.fn() },
  userAlias: { findMany: vi.fn() },
  pendingBenchConfirmation: { findMany: vi.fn() },
  sentNotification: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

const engine = vi.hoisted(() => ({ runAttendanceEngineBatch: vi.fn() }));
vi.mock("@/lib/attendance-engine-batch", () => engine);
const att = vi.hoisted(() => ({ registerAttendance: vi.fn(), cancelAttendance: vi.fn() }));
vi.mock("@/lib/attendance", () => att);
const budget = vi.hoisted(() => ({
  getAiBudgetStatus: vi.fn(),
  withOrgAiBudget: vi.fn((_k: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock("@/lib/ai-budget", () => budget);
const tentative = vi.hoisted(() => ({ recordTentative: vi.fn(), resolveTentative: vi.fn() }));
vi.mock("@/lib/tentative-store", () => tentative);
const prov = vi.hoisted(() => ({ resolveOrProvisionByName: vi.fn() }));
vi.mock("@/lib/resolve-or-provision-name", () => prov);

import { handleAdminSquadChange } from "../admin-group-squad-change";
import type { AttendanceFacts, Claim, Route, SquadState } from "../pipeline/types";

const MATCH_ID = "m1";
const input = {
  orgId: "org-fnf",
  lang: "en",
  messageId: "wa-1",
  text: "Shehryar out",
  senderUserId: "u-admin",
  senderName: "Raihan",
  sentAt: null,
  now: new Date("2026-10-14T12:00:00Z"),
};

/** The route the shared router gave, handed to every call below. */
let route: Route = "other_att";
function routed(r: string) {
  route = r as Route;
}

type EngineArgs = Parameters<typeof import("../attendance-engine-batch").runAttendanceEngineBatch>[0];

function engineDoes(fn: (args: EngineArgs) => Promise<void>, outcome: Record<string, unknown> = {}) {
  engine.runAttendanceEngineBatch.mockImplementation(async (args: EngineArgs) => {
    await fn(args);
    return {
      ownedIds: new Set(["wa-1"]),
      outcomes: new Map([
        [
          "wa-1",
          { failures: [], recordTentativeForUserIds: [], claimCount: 1, ...outcome },
        ],
      ]),
      matchId: MATCH_ID,
      degradations: [],
      squadPostForMessageId: null,
      cost: { usd: 0, calls: 0, ms: 0 },
    };
  });
}

function claim(over: Partial<Claim> = {}): Claim {
  return {
    subject: "other",
    personRef: "Shehryar",
    personNamed: true,
    polarity: "in",
    contingent: false,
    conditionOn: "none",
    tense: "present",
    basis: "decision",
    reported: false,
    confidence: 0.95,
    replaces: "",
    ...over,
  };
}
const self = (over: Partial<Claim> = {}) => claim({ subject: "sender", personRef: "", personNamed: false, ...over });

/** Run the facts through the hook this module handed the engine, against
 *  a squad state, as the real runner does before `decide()`. */
function vetThrough(a: EngineArgs, claims: Claim[], rows: SquadState["rows"], body?: string): AttendanceFacts {
  expect(a.deps.vetFacts).toBeTypeOf("function");
  const state = {
    matchId: MATCH_ID,
    maxPlayers: 18,
    kickoffLabel: "Fri 20:30",
    rows,
    roster: [
      { userId: "u-admin", name: "Omar", isAdmin: true, hasPhone: true },
      { userId: "u-shehryar", name: "Shehryar", isAdmin: false, hasPhone: true },
      { userId: "u-dev", name: "Dev", isAdmin: false, hasPhone: true },
      { userId: "u-kofi", name: "Kofi", isAdmin: false, hasPhone: true },
    ],
  } as unknown as SquadState;
  const message = { ...a.messages[0], ...(body ? { body } : {}) };
  return a.deps.vetFacts!({ message, facts: { kind: "attendance", claims, affirmation: null, sideRequests: [] }, state });
}

const statuses = new Map<string, string>();

beforeEach(() => {
  vi.clearAllMocks();
  statuses.clear();
  budget.getAiBudgetStatus.mockResolvedValue({ capped: false });
  tentative.recordTentative.mockResolvedValue(null);
  tentative.resolveTentative.mockResolvedValue(undefined);
  dbMock.attendance.findUnique.mockImplementation(async ({ where }: { where: { matchId_userId: { userId: string } } }) => {
    const s = statuses.get(where.matchId_userId.userId);
    return s ? { status: s } : null;
  });
  dbMock.attendance.count.mockResolvedValue(17);
  dbMock.match.findUnique.mockResolvedValue({ date: new Date("2026-10-16T19:00:00Z"), maxPlayers: 18 });
  dbMock.user.findMany.mockResolvedValue([
    { id: "u-shehryar", name: "Shehryar" },
    { id: "u-bilal", name: "Bilal" },
  ]);
  att.cancelAttendance.mockImplementation(async (userId: string) => {
    statuses.set(userId, "DROPPED");
    return { status: "DROPPED" };
  });
  att.registerAttendance.mockImplementation(async (userId: string) => {
    statuses.set(userId, "CONFIRMED");
    return { status: "CONFIRMED" };
  });
});

describe("handleAdminSquadChange", () => {
  it("routes the one message, as tagged and from an admin, and applies it through the engine", async () => {
    routed("other_att");
    statuses.set("u-shehryar", "CONFIRMED");
    engineDoes(async (a) => {
      await a.deps.cancelAttendance("u-shehryar", MATCH_ID, { cause: "admin-message", actorKind: "admin", actorUserId: "u-admin", sourceRef: "wa-1" });
    });
    const r = await handleAdminSquadChange({ ...input, route });
    expect(r).toEqual({ handled: true, outcome: "squad-changed", replyText: "Done: Shehryar out. 17 of 18." });

    const args = engine.runAttendanceEngineBatch.mock.calls[0][0] as EngineArgs;
    expect(args.messages).toEqual([
      expect.objectContaining({ waMessageId: "wa-1", senderUserId: "u-admin", senderIsAdmin: true, tagged: true, route: "other_att", gated: false }),
    ]);
    expect(args.enabled).toBe(true);
    expect(args.history).toEqual([]);
    expect(att.cancelAttendance).toHaveBeenCalledTimes(1);
  });

  it("a swap: one out, one in, in one line", async () => {
    routed("other_att");
    statuses.set("u-shehryar", "CONFIRMED");
    dbMock.attendance.count.mockResolvedValue(18);
    engineDoes(async (a) => {
      const ev = { cause: "admin-message" as const, actorKind: "admin" as const, actorUserId: "u-admin", sourceRef: "wa-1" };
      await a.deps.cancelAttendance("u-shehryar", MATCH_ID, ev);
      await a.deps.registerAttendance("u-bilal", MATCH_ID, { event: ev });
    });
    const r = await handleAdminSquadChange({ ...input, route, text: "swap Shehryar for Bilal" });
    expect(r).toMatchObject({ handled: true, replyText: "Done: Shehryar out, Bilal in. 18 of 18." });
  });

  it("the writes it hands the real writers are marked as the admin group's (sourceRef admin-group:<id>)", async () => {
    routed("other_att");
    statuses.set("u-shehryar", "CONFIRMED");
    engineDoes(async (a) => {
      const ev = { cause: "admin-message" as const, actorKind: "admin" as const, actorUserId: "u-admin", sourceRef: "wa-1" };
      await a.deps.cancelAttendance("u-shehryar", MATCH_ID, ev);
      await a.deps.registerAttendance("u-bilal", MATCH_ID, { event: ev });
    });
    await handleAdminSquadChange({ ...input, route, text: "swap Shehryar for Bilal" });
    expect(att.cancelAttendance.mock.calls[0][2]).toMatchObject({ cause: "admin-message", sourceRef: "admin-group:wa-1" });
    expect(att.registerAttendance.mock.calls[0][2].event).toMatchObject({ cause: "admin-message", sourceRef: "admin-group:wa-1" });
  });

  it('"put Mo in": a new name an admin typed in HQ is resolved as deliberate, so a 2-letter name is added', async () => {
    routed("other_att");
    prov.resolveOrProvisionByName.mockResolvedValue({ userId: "u-mo", name: "Mo" });
    engineDoes(async (a) => {
      const who = await a.deps.resolveOrProvision("Mo");
      expect(who).toEqual({ userId: "u-mo", name: "Mo" });
    });
    await handleAdminSquadChange({ ...input, route, text: "put Mo in" });
    expect(prov.resolveOrProvisionByName).toHaveBeenCalledWith("org-fnf", "Mo", { adminConfirmed: true });
  });

  it("Turkish club: Turkish reply", async () => {
    routed("other_att");
    statuses.set("u-shehryar", "CONFIRMED");
    engineDoes(async (a) => {
      await a.deps.cancelAttendance("u-shehryar", MATCH_ID, { cause: "admin-message", actorKind: "admin", actorUserId: "u-admin", sourceRef: "wa-1" });
    });
    const r = await handleAdminSquadChange({ ...input, route, lang: "tr" });
    expect(r).toMatchObject({ replyText: "Tamam: Shehryar çıktı. 17/18." });
  });

  it.each(["none", "question", "balancer", "admin_ops", "score", "offer"])(
    "routed %s: no engine, no reply",
    async (route) => {
      routed(route);
      expect(await handleAdminSquadChange({ ...input, route: route as Route })).toEqual({ handled: false, why: "not-a-squad-change" });
      expect(engine.runAttendanceEngineBatch).not.toHaveBeenCalled();
    },
  );

  it("routed unsure (the caller hands it over only when addressed to MatchTime): the engine reads it, as in the players' group", async () => {
    routed("unsure");
    engineDoes(async () => {}, { claimCount: 0 });
    await handleAdminSquadChange({ ...input, route: "unsure" });
    expect(engine.runAttendanceEngineBatch).toHaveBeenCalledTimes(1);
    expect((engine.runAttendanceEngineBatch.mock.calls[0][0] as EngineArgs).messages[0].route).toBe("unsure");
  });

  it("at the daily AI cap: the engine is told, so only the floor reads it", async () => {
    budget.getAiBudgetStatus.mockResolvedValue({ capped: true });
    routed("other_att");
    engineDoes(async () => {}, { claimCount: 0 });
    await handleAdminSquadChange({ ...input, route });
    expect((engine.runAttendanceEngineBatch.mock.calls[0][0] as EngineArgs).deps.aiCapped).toBe(true);
  });

  it("the engine owned nothing (no match, attendance off): silent", async () => {
    routed("other_att");
    engine.runAttendanceEngineBatch.mockResolvedValue({ ownedIds: new Set(), outcomes: new Map(), matchId: null, degradations: [] });
    expect(await handleAdminSquadChange({ ...input, route })).toEqual({ handled: false, why: "no-match" });
  });

  it("an explicit claim the squad already says: says so", async () => {
    routed("other_att");
    statuses.set("u-shehryar", "DROPPED");
    engineDoes(async (a) => {
      vetThrough(a, [claim({ personRef: "Shehryar", polarity: "out" })], [{ userId: "u-shehryar", status: "DROPPED", position: 3 }]);
    });
    const r = await handleAdminSquadChange({ ...input, route });
    expect(r).toEqual({ handled: true, outcome: "squad-unchanged", replyText: "Nothing to change: the squad already says that. 17 of 18." });
  });

  it("no claim read at all: silent", async () => {
    routed("other_att");
    engineDoes(async () => {}, { claimCount: 0 });
    expect(await handleAdminSquadChange({ ...input, route })).toEqual({ handled: false, why: "not-a-squad-change" });
  });

  it("a write that failed is reported, never confirmed", async () => {
    routed("other_att");
    engineDoes(async () => {}, { failures: [{ action: "OUT", who: "Shehryar", error: "x" }] });
    const r = await handleAdminSquadChange({ ...input, route });
    expect(r).toEqual({
      handled: true,
      outcome: "squad-change-failed",
      replyText: "I couldn't change Shehryar. Please check the match page. 17 of 18.",
    });
  });

  it("engine maybes are still recorded for the 24h chase if the engine ever returns one", async () => {
    routed("other_att");
    dbMock.user.findMany.mockResolvedValue([{ id: "u-sait", name: "Sait" }]);
    engineDoes(async () => {}, { recordTentativeForUserIds: ["u-sait"] });
    const r = await handleAdminSquadChange({ ...input, route, text: "Sait is a maybe" });
    expect(tentative.recordTentative).toHaveBeenCalledWith(expect.objectContaining({ matchId: MATCH_ID, userId: "u-sait" }));
    expect(r).toMatchObject({ replyText: "Done: Sait a maybe. 17 of 18." });
  });

  // ── 2026-10-15: conversation in HQ is not an instruction ────────────
  // The live rehearsal's shapes, paraphrased, through the real vetting
  // hook this module hands the engine. The engine mock stands in for
  // `decide()`: it writes only what survives the hook.

  it("hands the engine a vetting hook that resolves names on the squad state and reads a bare IN/OUT as explicit", async () => {
    routed("self_att");
    engineDoes(async (a) => {
      const kept = vetThrough(a, [self({ polarity: "out" })], [{ userId: "u-admin", status: "CONFIRMED", position: 1 }], "out");
      expect(kept.claims).toHaveLength(1);
      await a.deps.cancelAttendance("u-admin", MATCH_ID, { cause: "admin-message", actorKind: "admin", actorUserId: "u-admin", sourceRef: "wa-1" });
    });
    dbMock.user.findMany.mockResolvedValue([{ id: "u-admin", name: "Omar" }]);
    statuses.set("u-admin", "CONFIRMED");
    const r = await handleAdminSquadChange({ ...input, route, senderName: "Omar", text: "out" });
    expect(r).toMatchObject({ handled: true, outcome: "squad-changed", replyText: "Done: Omar out. 17 of 18." });
  });

  it('a confirmed organiser saying he "might have to pull out": no write, no reply', async () => {
    routed("self_att");
    statuses.set("u-admin", "CONFIRMED");
    engineDoes(
      async (a) => {
        const kept = vetThrough(a, [self({ polarity: "out", contingent: true, conditionOn: "self" })], [
          { userId: "u-admin", status: "CONFIRMED", position: 1 },
        ]);
        expect(kept.claims).toEqual([]);
      },
      { claimCount: 0 },
    );
    expect(await handleAdminSquadChange({ ...input, route, text: "might have to pull out this week" })).toEqual({ handled: false, why: "not-a-squad-change" });
    expect(att.cancelAttendance).not.toHaveBeenCalled();
    expect(tentative.recordTentative).not.toHaveBeenCalled();
  });

  it("his next message about an injury: never applied, no reply", async () => {
    routed("self_att");
    statuses.set("u-admin", "CONFIRMED");
    engineDoes(
      async (a) => {
        const kept = vetThrough(a, [self({ polarity: "out", basis: "availability" })], [{ userId: "u-admin", status: "CONFIRMED", position: 1 }]);
        expect(kept.claims).toEqual([]);
      },
      { claimCount: 0 },
    );
    expect(await handleAdminSquadChange({ ...input, route, text: "my ankle is wrecked" })).toEqual({ handled: false, why: "not-a-squad-change" });
  });

  it("a plain self OUT said in conversation by a confirmed organiser: no write, one line with the command", async () => {
    routed("self_att");
    statuses.set("u-admin", "CONFIRMED");
    engineDoes(
      async (a) => {
        vetThrough(a, [self({ polarity: "out" })], [{ userId: "u-admin", status: "CONFIRMED", position: 1 }]);
      },
      { claimCount: 0 },
    );
    const r = await handleAdminSquadChange({ ...input, route, senderName: "Omar", text: "won't be around on friday" });
    expect(r).toEqual({ handled: true, outcome: "squad-question", replyText: 'To take yourself out of Fri 20:30, write "Omar out".' });
    expect(att.cancelAttendance).not.toHaveBeenCalled();
  });

  it("the same said by an organiser not in the squad: silence (not a false 'Nothing to change')", async () => {
    routed("self_att");
    engineDoes(async (a) => void vetThrough(a, [self({ polarity: "out" })], []), { claimCount: 0 });
    expect(await handleAdminSquadChange({ ...input, route, senderName: "Omar", text: "won't be around on friday" })).toEqual({ handled: false, why: "not-a-squad-change" });
  });

  it("a name nobody in the club has, said in passing: no write, says it does not know them and how to add them", async () => {
    routed("other_att");
    engineDoes(async (a) => void vetThrough(a, [claim({ personRef: "Zayn" })], []), { claimCount: 0 });
    const r = await handleAdminSquadChange({ ...input, route, text: "Zayn is around again" });
    expect(r).toEqual({ handled: true, outcome: "squad-question", replyText: 'I don\'t know Zayn yet. To add them, write "put Zayn in".' });
    expect(prov.resolveOrProvisionByName).not.toHaveBeenCalled();
  });

  it("a member mentioned in passing: silence", async () => {
    routed("other_att");
    engineDoes(async (a) => void vetThrough(a, [claim({ personRef: "Dev" })], []), { claimCount: 0 });
    expect(await handleAdminSquadChange({ ...input, route, text: "Dev is around again" })).toEqual({ handled: false, why: "not-a-squad-change" });
  });

  it("an admin reporting someone else's maybe in HQ: held, no tentative, no reply", async () => {
    routed("other_att");
    engineDoes(
      async (a) => {
        const kept = vetThrough(a, [claim({ personRef: "Dev", contingent: true, conditionOn: "self" })], []);
        expect(kept.claims).toEqual([]);
      },
      { claimCount: 0 },
    );
    expect(await handleAdminSquadChange({ ...input, route, text: "Dev is a maybe" })).toEqual({ handled: false, why: "not-a-squad-change" });
    expect(tentative.recordTentative).not.toHaveBeenCalled();
  });

  it("an explicit command still goes through the hook untouched", async () => {
    routed("other_att");
    engineDoes(async (a) => {
      const kept = vetThrough(a, [claim({ personRef: "Kofi" })], []);
      expect(kept.claims.map((c) => c.personRef)).toEqual(["Kofi"]);
    }, { claimCount: 1 });
    await handleAdminSquadChange({ ...input, route, text: "put Kofi in" });
  });

  it("logs ids and counts, never the text or a name", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    routed("other_att");
    statuses.set("u-shehryar", "CONFIRMED");
    engineDoes(async (a) => {
      await a.deps.cancelAttendance("u-shehryar", MATCH_ID, { cause: "admin-message", actorKind: "admin", actorUserId: "u-admin", sourceRef: "wa-1" });
    });
    await handleAdminSquadChange({ ...input, route });
    const lines = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(lines).not.toMatch(/Shehryar|Raihan|out\b/);
    log.mockRestore();
  });
});
