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
// The engine's own squad loader, and whether the rolling squad of the match
// it picks is still to be carried over (2026-10-17). Called only when a
// test's engine double calls `deps.loadState`, as the real runner does.
const loadState = vi.hoisted(() => ({ loadSquadState: vi.fn() }));
vi.mock("@/lib/pipeline/load-state", () => loadState);
const rolling = vi.hoisted(() => ({ rollingSeedPendingAt: vi.fn() }));
vi.mock("@/lib/rolling-squad", () => rolling);
// The count line's facts (squad-count.ts): confirmed from the count double
// below, an empty bench unless a test puts someone on it.
const squadCount = vi.hoisted(() => ({ loadSquadCount: vi.fn() }));
vi.mock("@/lib/squad-count", () => squadCount);

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
  // What the HQ squad reader read (2026-10-30): the change, as the engine's facts.
  reading: { changes: [{ name: "Shehryar", userId: "u-shehryar", to: "out" as const, replaces: "" }], alsoAsks: false },
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
    reported: false,
    confidence: 0.95,
    replaces: "",
    ...over,
  };
}

/** Run the facts through the hook this module handed the engine, against
 *  a squad state, as the real runner does before `decide()`. */
function vetThrough(
  a: EngineArgs,
  claims: Claim[],
  rows: SquadState["rows"],
  body?: string,
  sideRequests: AttendanceFacts["sideRequests"] = [],
): AttendanceFacts {
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
  return a.deps.vetFacts!({ message, facts: { kind: "attendance", claims, affirmation: null, sideRequests }, state });
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
  squadCount.loadSquadCount.mockImplementation(async () => ({
    confirmed: await dbMock.attendance.count(),
    maxPlayers: 18,
    bench: [],
    benchPickMode: "first-come",
  }));
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

  // FNF HQ 2026-10-18 18:16: "Akram out" was answered "17 of 18." with
  // Uncle Najib on the bench, in a club whose organisers pick.
  it("the incident: the count says the bench, and how to bring someone in, read after the write", async () => {
    routed("other_att");
    statuses.set("u-shehryar", "CONFIRMED");
    squadCount.loadSquadCount.mockResolvedValue({ confirmed: 17, maxPlayers: 18, bench: ["Uncle Najib"], benchPickMode: "organiser" });
    engineDoes(async (a) => {
      await a.deps.cancelAttendance("u-shehryar", MATCH_ID, { cause: "admin-message", actorKind: "admin", actorUserId: "u-admin", sourceRef: "wa-1" });
    });
    const r = await handleAdminSquadChange({ ...input, route });
    expect(r).toEqual({
      handled: true,
      outcome: "squad-changed",
      replyText:
        'Done: Shehryar out. 17 of 18, 1 on the bench (Uncle Najib). A place is free. Just tell me who should come in from the bench, in your own words (for example Uncle Najib).',
    });
    expect(squadCount.loadSquadCount).toHaveBeenCalledWith(MATCH_ID);
    expect(squadCount.loadSquadCount.mock.invocationCallOrder[0]).toBeGreaterThan(att.cancelAttendance.mock.invocationCallOrder[0]);
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


  it("routed unsure (the caller hands it over only when addressed to MatchTime): the engine decides the reader's change, about others", async () => {
    engineDoes(async () => {}, { claimCount: 0 });
    await handleAdminSquadChange({ ...input, route: "unsure" });
    expect(engine.runAttendanceEngineBatch).toHaveBeenCalledTimes(1);
    expect((engine.runAttendanceEngineBatch.mock.calls[0][0] as EngineArgs).messages[0].route).toBe("other_att");
  });

  it("the sender's own change only: decided as about the sender", async () => {
    engineDoes(async () => {}, { claimCount: 0 });
    await handleAdminSquadChange({ ...input, route: "other_att", reading: { changes: [{ name: "Raihan", userId: "u-admin", to: "out", replaces: "" }], alsoAsks: false } });
    expect((engine.runAttendanceEngineBatch.mock.calls[0][0] as EngineArgs).messages[0].route).toBe("self_att");
  });

  // 2026-10-30: the HQ squad reader read the message; its change IS the
  // engine's facts, so no extractor is asked (at the AI cap or not), and no
  // code reads the words (the floor, the name list).
  it("the engine is handed the reader's change as its facts: no extractor, no floor", async () => {
    routed("other_att");
    const reading = {
      changes: [
        { name: "Yaseen", userId: null, to: "out" as const, replaces: "" },
        { name: "Mo Ali", userId: "u-mo", to: "in" as const, replaces: "Shehryar" },
      ],
      alsoAsks: false,
    };
    engineDoes(async (a) => {
      expect(a.deps.presetFacts?.(a.messages[0])).toEqual({
        kind: "attendance",
        affirmation: null,
        sideRequests: [],
        claims: [
          claim({ personRef: "Yaseen", polarity: "out", confidence: 1 }),
          claim({ personRef: "Mo Ali", polarity: "in", confidence: 1, replaces: "Shehryar" }),
        ],
      });
      expect(a.deps.presetFacts?.({ ...a.messages[0], waMessageId: "other" })).toBeNull();
      expect(a.deps.aiCapped).toBeUndefined();
    });
    await handleAdminSquadChange({ ...input, route, text: "Yaseen out, Mo instead of Shehryar", reading });
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

  // FNF HQ 2026-10-24 13:47: "Glazers is out now.\n\n@Match Time what is the
  // list?" Glazers had left the club and been dropped minutes before: on no
  // roster. The extractor read the OUT; nothing moved; MatchTime said nothing.
  describe("the incident: an OUT for someone not on the list, beside a question to MatchTime", () => {
    const TEXT = "Glazers is out now.\n\n@Match Time what is the list?";
    const glazersOut = (a: EngineArgs) => void vetThrough(a, [claim({ personRef: "Glazers", polarity: "out", confidence: 1 })], [], TEXT);
    const glazers = (alsoAsks: boolean) => ({ changes: [{ name: "Glazers", userId: null, to: "out" as const, replaces: "" }], alsoAsks });

    it("says Glazers is not on the list, nothing written, and passes on that the message also asks MatchTime something", async () => {
      routed("other_att");
      engineDoes(async (a) => glazersOut(a), { claimCount: 1 });
      const r = await handleAdminSquadChange({ ...input, route, text: TEXT, addressed: true, reading: glazers(true) });
      expect(r).toEqual({
        handled: true,
        outcome: "squad-not-on-list",
        replyText: "I can't find Glazers on the list for Fri 20:30, so nothing changed.",
        alsoAsks: true,
      });
      expect(att.cancelAttendance).not.toHaveBeenCalled();
    });

    it("an organiser's untagged instruction: the same line, and no question passed on when none was asked", async () => {
      routed("other_att");
      engineDoes(async (a) => glazersOut(a), { claimCount: 1 });
      const r = await handleAdminSquadChange({ ...input, route, text: "Glazers is out now", organiser: true, reading: glazers(false) });
      expect(r).toEqual({ handled: true, outcome: "squad-not-on-list", replyText: "I can't find Glazers on the list for Fri 20:30, so nothing changed." });
    });

    it("a change that says nothing still passes the question on", async () => {
      routed("other_att");
      engineDoes(async (a) => void vetThrough(a, [], [], TEXT), { claimCount: 0 });
      expect(await handleAdminSquadChange({ ...input, route, text: TEXT, reading: glazers(true) })).toEqual({ handled: false, why: "not-a-squad-change", alsoAsks: true });
    });
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












  describe("the next game's list is not set yet (rolling squad still to carry over)", () => {
    const DUE = new Date("2026-10-17T07:00:00Z"); // 08:00 London, Saturday
    beforeEach(() => {
      loadState.loadSquadState.mockResolvedValue({ matchId: MATCH_ID, roster: [] });
      rolling.rollingSeedPendingAt.mockResolvedValue(DUE);
    });

    it("a clear instruction: nothing written, one line saying the list is not set yet and when it will be", async () => {
      routed("other_att");
      statuses.set("u-shehryar", "CONFIRMED");
      engineDoes(
        async (a) => {
          await a.deps.loadState!("org-fnf", input.now);
          const kept = vetThrough(a, [claim({ personRef: "Shehryar", polarity: "out" })], []);
          expect(kept.claims).toEqual([]);
        },
        { claimCount: 0 },
      );
      const r = await handleAdminSquadChange({ ...input, route });
      expect(r).toEqual({
        handled: true,
        outcome: "squad-not-set",
        replyText: "The list for Fri 20:30 isn't set yet: last week's squad carries over at 08:00 on Saturday. Send it again after that.",
      });
      expect(rolling.rollingSeedPendingAt).toHaveBeenCalledWith(MATCH_ID, input.now);
      expect(att.cancelAttendance).not.toHaveBeenCalled();
    });


    it("the list is set (nothing pending): applied as usual", async () => {
      rolling.rollingSeedPendingAt.mockResolvedValue(null);
      routed("other_att");
      statuses.set("u-shehryar", "CONFIRMED");
      engineDoes(async (a) => {
        await a.deps.loadState!("org-fnf", input.now);
        const kept = vetThrough(a, [claim({ personRef: "Shehryar", polarity: "out" })], []);
        expect(kept.claims).toHaveLength(1);
        await a.deps.cancelAttendance("u-shehryar", MATCH_ID, { cause: "admin-message", actorKind: "admin", actorUserId: "u-admin", sourceRef: "wa-1" });
      });
      expect((await handleAdminSquadChange({ ...input, route }))?.handled).toBe(true);
    });
  });

  // 2026-10-20 (Kemal and FNF's Raihan): anyone in the club changes who
  // plays in HQ, with an organiser's standing. The engine reads that off the
  // roster, so the sender, and only the sender, is an organiser there.
  it("the sender acts with an organiser's standing in the engine, whatever their role; nobody else is changed", async () => {
    loadState.loadSquadState.mockResolvedValue({
      matchId: MATCH_ID,
      roster: [
        { userId: "u-admin", name: "Omar", isAdmin: true, hasPhone: true },
        { userId: "u-ah", name: "Abdul-Hafeez", isAdmin: false, hasPhone: true },
        { userId: "u-dev", name: "Dev", isAdmin: false, hasPhone: true },
      ],
    });
    rolling.rollingSeedPendingAt.mockResolvedValue(null);
    routed("other_att");
    let roster: Array<{ userId: string; isAdmin: boolean }> = [];
    engineDoes(async (a) => {
      roster = (await a.deps.loadState!("org-fnf", input.now)).roster;
      expect(a.messages[0]).toMatchObject({ senderUserId: "u-ah", senderIsAdmin: true });
    });
    await handleAdminSquadChange({ ...input, route, senderUserId: "u-ah", senderName: "Abdul-Hafeez", text: "Naim is out" });
    expect(roster.map((m) => [m.userId, m.isAdmin])).toEqual([
      ["u-admin", true],
      ["u-ah", true],
      ["u-dev", false],
    ]);
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
