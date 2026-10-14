/**
 * One squad change typed in the admin group (2026-10-14): the wiring.
 * The router and the attendance engine are mocked at their module
 * boundary; what is under test is what this module hands them and what it
 * says back. No database, no model.
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

const gate = vi.hoisted(() => ({ gateBatch: vi.fn() }));
vi.mock("@/lib/pipeline/gate", () => gate);
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

function routed(route: string, skipped: string[] = []) {
  gate.gateBatch.mockResolvedValue({ routes: [{ messageId: "wa-1", route }], skipped, analysed: [], floorForced: [] });
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
    const r = await handleAdminSquadChange(input);
    expect(r).toEqual({ handled: true, outcome: "squad-changed", replyText: "Done: Shehryar out. 17 of 18." });

    expect(gate.gateBatch).toHaveBeenCalledWith([{ waMessageId: "wa-1", body: "Shehryar out", authorName: "Raihan" }], { capped: false });
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
    const r = await handleAdminSquadChange({ ...input, text: "swap Shehryar for Bilal" });
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
    await handleAdminSquadChange({ ...input, text: "swap Shehryar for Bilal" });
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
    await handleAdminSquadChange({ ...input, text: "put Mo in" });
    expect(prov.resolveOrProvisionByName).toHaveBeenCalledWith("org-fnf", "Mo", { adminConfirmed: true });
  });

  it("Turkish club: Turkish reply", async () => {
    routed("other_att");
    statuses.set("u-shehryar", "CONFIRMED");
    engineDoes(async (a) => {
      await a.deps.cancelAttendance("u-shehryar", MATCH_ID, { cause: "admin-message", actorKind: "admin", actorUserId: "u-admin", sourceRef: "wa-1" });
    });
    const r = await handleAdminSquadChange({ ...input, lang: "tr" });
    expect(r).toMatchObject({ replyText: "Tamam: Shehryar çıktı. 17/18." });
  });

  it.each(["none", "question", "balancer", "admin_ops", "score", "unsure", "offer"])(
    "routed %s: no engine, no reply",
    async (route) => {
      routed(route);
      expect(await handleAdminSquadChange(input)).toEqual({ handled: false, why: "not-a-squad-change" });
      expect(engine.runAttendanceEngineBatch).not.toHaveBeenCalled();
    },
  );

  it("skipped as banter by the gate: no engine", async () => {
    routed("other_att", ["wa-1"]);
    expect(await handleAdminSquadChange(input)).toEqual({ handled: false, why: "not-a-squad-change" });
    expect(engine.runAttendanceEngineBatch).not.toHaveBeenCalled();
  });

  it("at the daily AI cap: the gate and engine are told, so only the floor reads it", async () => {
    budget.getAiBudgetStatus.mockResolvedValue({ capped: true });
    routed("other_att");
    engineDoes(async () => {}, { claimCount: 0 });
    await handleAdminSquadChange(input);
    expect(gate.gateBatch.mock.calls[0][1]).toEqual({ capped: true });
    expect((engine.runAttendanceEngineBatch.mock.calls[0][0] as EngineArgs).deps.aiCapped).toBe(true);
  });

  it("the engine owned nothing (no match, attendance off): silent", async () => {
    routed("other_att");
    engine.runAttendanceEngineBatch.mockResolvedValue({ ownedIds: new Set(), outcomes: new Map(), matchId: null, degradations: [] });
    expect(await handleAdminSquadChange(input)).toEqual({ handled: false, why: "no-match" });
  });

  it("a claim that changes nothing: says so", async () => {
    routed("other_att");
    statuses.set("u-shehryar", "DROPPED");
    engineDoes(async () => {});
    const r = await handleAdminSquadChange(input);
    expect(r).toEqual({ handled: true, outcome: "squad-unchanged", replyText: "Nothing to change: the squad already says that. 17 of 18." });
  });

  it("no claim read at all: silent", async () => {
    routed("other_att");
    engineDoes(async () => {}, { claimCount: 0 });
    expect(await handleAdminSquadChange(input)).toEqual({ handled: false, why: "not-a-squad-change" });
  });

  it("a write that failed is reported, never confirmed", async () => {
    routed("other_att");
    engineDoes(async () => {}, { failures: [{ action: "OUT", who: "Shehryar", error: "x" }] });
    const r = await handleAdminSquadChange(input);
    expect(r).toEqual({
      handled: true,
      outcome: "squad-change-failed",
      replyText: "I couldn't change Shehryar. Please check the match page. 17 of 18.",
    });
  });

  it("an admin's maybe is recorded for the 24h chase", async () => {
    routed("other_att");
    dbMock.user.findMany.mockResolvedValue([{ id: "u-sait", name: "Sait" }]);
    engineDoes(async () => {}, { recordTentativeForUserIds: ["u-sait"] });
    const r = await handleAdminSquadChange({ ...input, text: "Sait is a maybe" });
    expect(tentative.recordTentative).toHaveBeenCalledWith(expect.objectContaining({ matchId: MATCH_ID, userId: "u-sait" }));
    expect(r).toMatchObject({ replyText: "Done: Sait a maybe. 17 of 18." });
  });

  it("logs ids and counts, never the text or a name", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    routed("other_att");
    statuses.set("u-shehryar", "CONFIRMED");
    engineDoes(async (a) => {
      await a.deps.cancelAttendance("u-shehryar", MATCH_ID, { cause: "admin-message", actorKind: "admin", actorUserId: "u-admin", sourceRef: "wa-1" });
    });
    await handleAdminSquadChange(input);
    const lines = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(lines).not.toMatch(/Shehryar|Raihan|out\b/);
    log.mockRestore();
  });
});
