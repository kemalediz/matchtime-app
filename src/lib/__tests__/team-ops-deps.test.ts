/**
 * §10 STEP 8 — `buildTeamOpsApplyDeps`, the production half of the
 * `generate` apply layer.
 *
 * A separate file from `owner-deps.test.ts` only because the deps and
 * the engine that consumes them were written in parallel; it belongs
 * beside the score and admin-ops cases in that file, and folding it in
 * is a copy-paste.
 *
 * Same brief as its neighbours, and the same single worry: a query whose
 * shape quietly changed while being lifted out of a 900-line function.
 * Each case below pins a clause `executeVerdict` had
 * (`route.ts:3553-3617`) that a reimplementation would be easy to drop —
 * the three statuses, the 24-hour grace window, the `date: asc`
 * ordering, the already-CONFIRMED short circuit, the UNCHANGED position,
 * and the event's exact note.
 *
 * They run against a stubbed Prisma surface rather than a database: the
 * question is "does it ASK for the right rows", which is what a fake can
 * answer and a live database cannot without a fixture per case.
 */
import { describe, expect, it, vi } from "vitest";
import { buildTeamClearDeps, buildTeamOpsApplyDeps } from "../owner-deps";

const NOW = new Date("2026-09-01T18:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

describe("selecting the match to build teams for", () => {
  it("asks for the three shipped statuses inside the 24-hour grace window", async () => {
    const findFirst = vi.fn(async (_a: unknown) => ({ id: "m1" }));
    const deps = buildTeamOpsApplyDeps({
      orgId: "org-1",
      db: { match: { findFirst }, attendance: {}, $transaction: async () => {} } as AnyDb,
    });

    expect(await deps.selectTeamsMatch("org-1", NOW)).toEqual({ id: "m1" });
    const arg = findFirst.mock.calls[0][0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
      select: unknown;
    };
    expect(arg.where).toEqual({
      activity: { orgId: "org-1" },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      // The grace window is what makes "generate the teams" still work
      // at 9pm for an 8:30pm deadline.
      attendanceDeadline: { gt: new Date(NOW.getTime() - DAY_MS) },
    });
    // The SOONEST qualifying match, never the most recently created.
    expect(arg.orderBy).toEqual({ date: "asc" });
    expect(arg.select).toEqual({ id: true, date: true });
  });

  it("does NOT ask for the registration match's shape", async () => {
    // `selectRegistrationMatch` returns nothing while a match is still
    // in flight — which is exactly the state "generate the teams" is
    // asked in. If this query ever grows that rule, team generation goes
    // dark on match night and nothing else fails.
    const findFirst = vi.fn(async (_a: unknown) => null);
    const deps = buildTeamOpsApplyDeps({
      orgId: "org-1",
      db: { match: { findFirst }, attendance: {}, $transaction: async () => {} } as AnyDb,
    });
    await deps.selectTeamsMatch("org-1", NOW);
    const where = (findFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.status).toEqual({
      in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"],
    });
    expect(Object.keys(where).sort()).toEqual(["activity", "attendanceDeadline", "status"]);
  });

  it("uses the org the RUNNER named for the query", async () => {
    // The constructor's `orgId` is bound for `AttendanceEvent.orgId`.
    // The match lookup takes the org of the request it is serving.
    const findFirst = vi.fn(async (_a: unknown) => null);
    const deps = buildTeamOpsApplyDeps({
      orgId: "org-audit",
      db: { match: { findFirst }, attendance: {}, $transaction: async () => {} } as AnyDb,
    });
    await deps.selectTeamsMatch("org-request", NOW);
    expect((findFirst.mock.calls[0][0] as { where: { activity: unknown } }).where.activity).toEqual({
      orgId: "org-request",
    });
  });

  it("returns null rather than throwing when nothing qualifies", async () => {
    const deps = buildTeamOpsApplyDeps({
      orgId: "org-1",
      db: {
        match: { findFirst: async () => null },
        attendance: {},
        $transaction: async () => {},
      } as AnyDb,
    });
    expect(await deps.selectTeamsMatch("org-1", NOW)).toBeNull();
  });
});

describe("force-including a named player", () => {
  function stub(row: { id: string; status: string; position: number } | null) {
    const update = vi.fn(async (_a: unknown) => ({}));
    const create = vi.fn(async (_a: unknown) => ({}));
    /** Set when the row was read INSIDE the transaction callback. Read
     *  outside it, the check and the write have a gap between them. */
    let readInsideTx = false;
    let insideTx = false;
    const db = {
      match: {},
      attendance: {},
      $transaction: async (fn: (tx: unknown) => Promise<void>) => {
        insideTx = true;
        await fn({
          attendance: {
            findUnique: async () => {
              readInsideTx = insideTx;
              return row;
            },
            update,
          },
          attendanceEvent: { create },
        });
        insideTx = false;
      },
    } as AnyDb;
    return { db, update, create, readInsideTx: () => readInsideTx };
  }

  const call = {
    matchId: "m1",
    userId: "u-zair",
    ref: "Zair",
    sourceRef: "wa-1",
    actorUserId: "u-kemal",
  };

  it("flips a BENCH row and records the event in ONE transaction", async () => {
    const { db, update, create, readInsideTx } = stub({
      id: "a1",
      status: "BENCH",
      position: 9,
    });
    await buildTeamOpsApplyDeps({ orgId: "org-1", db }).forceConfirm(call);

    // The read and the write are in the same transaction, so the
    // already-CONFIRMED check cannot be raced.
    expect(readInsideTx()).toBe(true);
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0][0]).toEqual({
      where: { id: "a1" },
      data: { status: "CONFIRMED" },
    });

    expect(create).toHaveBeenCalledOnce();
    const data = (create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      matchId: "m1",
      userId: "u-zair",
      orgId: "org-1",
      fromStatus: "BENCH",
      toStatus: "CONFIRMED",
      cause: "admin-message",
      actorKind: "admin",
      actorUserId: "u-kemal",
      sourceRef: "wa-1",
      // `route.ts:3614` verbatim, including the quotes around the words
      // the message actually used.
      note: 'force-included in a team-generation request as "Zair"',
    });
    // A force-include is an admin overriding the format, not a player
    // joining the queue: it must not renumber the squad behind them.
    expect(data.fromPosition).toBe(9);
    expect(data.toPosition).toBe(9);
  });

  it("does nothing at all for a row that is already CONFIRMED", async () => {
    // `route.ts:3588`'s `if (target.status !== "CONFIRMED")`. An audit
    // log full of CONFIRMED → CONFIRMED hides the real moves, and
    // re-running "generate the teams including Ibrahim" must not claim
    // he moved when he did not.
    const { db, update, create } = stub({ id: "a1", status: "CONFIRMED", position: 3 });
    await buildTeamOpsApplyDeps({ orgId: "org-1", db }).forceConfirm(call);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("does nothing when the row vanished between the state load and the write", async () => {
    // The engine resolved against the match's own attendance rows, so a
    // missing row means the two reads disagree. Nothing to flip.
    const { db, update, create } = stub(null);
    const deps = buildTeamOpsApplyDeps({ orgId: "org-1", db });
    await deps.forceConfirm({ ...call, userId: "u-ghost", actorUserId: null });
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("records the event under the org the deps were BOUND to", async () => {
    // `AttendanceEvent` is tenant-scoped and `forceConfirm`'s signature
    // carries no org, so this is the only place it can come from.
    const { db, create } = stub({ id: "a1", status: "DROPPED", position: 4 });
    await buildTeamOpsApplyDeps({ orgId: "org-sutton", db }).forceConfirm(call);
    expect((create.mock.calls[0][0] as { data: { orgId: string } }).data.orgId).toBe("org-sutton");
  });
});

// ── "@Match Time clear the teams" (2026-09-29) ─────────────────────────


describe("buildTeamClearDeps", () => {
  it("an admin is an OWNER or ADMIN membership that has not left, in THIS org", async () => {
    const findFirst = vi.fn(async (_a: unknown) => ({ id: "mem-1" }));
    const deps = buildTeamClearDeps({
      orgId: "org-1",
      now: NOW,
      db: { membership: { findFirst } } as AnyDb,
    });
    expect(await deps.isAdmin("u-1")).toBe(true);
    expect((findFirst.mock.calls[0][0] as { where: unknown }).where).toEqual({
      orgId: "org-1",
      userId: "u-1",
      role: { in: ["OWNER", "ADMIN"] },
      leftAt: null,
    });
  });

  it("a member without that role is not an admin", async () => {
    const deps = buildTeamClearDeps({
      orgId: "org-1",
      now: NOW,
      db: { membership: { findFirst: async () => null } } as AnyDb,
    });
    expect(await deps.isAdmin("u-2")).toBe(false);
  });

  it("clears on the SAME match the balancer would build for", async () => {
    const findFirst = vi.fn(async (_a: unknown) => ({ id: "m1", date: NOW }));
    const deps = buildTeamClearDeps({
      orgId: "org-1",
      now: NOW,
      db: { match: { findFirst } } as AnyDb,
    });
    expect(await deps.selectTeamsMatch()).toEqual({ id: "m1", date: NOW });
    const arg = findFirst.mock.calls[0][0] as { where: unknown; orderBy: unknown };
    expect(arg.where).toEqual({
      activity: { orgId: "org-1" },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      attendanceDeadline: { gt: new Date(NOW.getTime() - DAY_MS) },
    });
    expect(arg.orderBy).toEqual({ date: "asc" });
  });

  it("deletes the rows and resets the status in ONE transaction, and reports both", async () => {
    const deleteMany = vi.fn(async (_a: unknown) => ({ count: 14 }));
    const updateMany = vi.fn(async (_a: unknown) => ({ count: 1 }));
    const tx = { teamAssignment: { deleteMany }, match: { updateMany } };
    const $transaction = vi.fn(async (fn: (t: unknown) => unknown) => fn(tx));
    const deps = buildTeamClearDeps({ orgId: "org-1", now: NOW, db: { $transaction } as AnyDb });
    expect(await deps.clearTeams("m1")).toEqual({ deleted: 14, statusReset: true });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0][0]).toEqual({ where: { matchId: "m1" } });
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: "m1", status: { in: ["TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
      data: { status: "UPCOMING" },
    });
  });
});
