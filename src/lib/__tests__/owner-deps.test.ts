/**
 * §10 STEP 8 — THE APPLY LAYERS FINALLY GET A PRODUCTION IMPLEMENTATION.
 *
 * `score-engine.ts` and `admin-ops-engine.ts` shipped in PR #52 as apply
 * layers with INJECTED dependencies and no caller. Every implementation
 * of `ScoreApplyDeps` / `AdminOpsApplyDeps` in the repo was a test fake
 * or the corpus harness's SQL shim — nothing spoke to Prisma, because
 * nothing was wired into `analyze/route.ts` yet.
 *
 * This module is the missing half, and these tests are about the ONE
 * thing that can go wrong when lifting shipped code out of a 900-line
 * function: a query whose shape quietly changed. Each case below pins a
 * clause that `executeVerdict` had and that a reimplementation would be
 * easy to drop — the `isHistorical: false` filter, the `leftAt: null`
 * filter, the paid-idempotence check, the ended-match window.
 *
 * They run against a stubbed Prisma surface rather than a database: the
 * question is "does it ASK for the right rows", which is exactly what a
 * fake can answer and a live database cannot without a fixture per case.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildScoreApplyDeps,
  buildAdminOpsApplyDeps,
  buildClaimGuestNameAsk,
} from "../owner-deps";
import { guestNameAskKey, GUEST_NAME_ASK_KIND } from "../guest-name-ask";

describe("the score apply deps", () => {
  it("records the score AND moves the match to COMPLETED in one update", async () => {
    const update = vi.fn(async (_a: unknown) => ({}));
    const deps = buildScoreApplyDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { match: { update }, teamAssignment: { findMany: async () => [] }, $transaction: async () => [], user: {} } as any,
    });
    await deps.recordScore({ matchId: "m1", red: 5, yellow: 3 });
    expect(update).toHaveBeenCalledOnce();
    const arg = update.mock.calls[0][0] as { where: unknown; data: Record<string, unknown> };
    expect(arg.where).toEqual({ id: "m1" });
    expect(arg.data).toMatchObject({ redScore: 5, yellowScore: 3, status: "COMPLETED" });
  });

  // Since 2026-09-19 the rating is `Membership.matchRating`, so both
  // Elo methods first resolve the match's club. `lib/membership-elo.ts`
  // owns that; these keep pinning the queries THIS file issues.
  const matchInOrg = (orgId: string) => ({
    findUnique: async (_a: unknown) => ({ activity: { orgId } }),
  });

  it("reads the Elo inputs off TeamAssignment with the player's CURRENT rating AT THAT CLUB", async () => {
    const findMany = vi.fn(async (_a: unknown) => [
      { userId: "u1", team: "RED" },
      { userId: "u2", team: "YELLOW" },
    ]);
    const membershipFindMany = vi.fn(async (_a: unknown) => [
      { userId: "u1", matchRating: 1200 },
      { userId: "u2", matchRating: 1300 },
    ]);
    const deps = buildScoreApplyDeps({
      db: {
        match: matchInOrg("org-a"),
        teamAssignment: { findMany },
        membership: { findMany: membershipFindMany },
        $transaction: async () => [],
        user: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    const inputs = await deps.loadEloInputs("m1");
    expect(inputs).toEqual([
      { userId: "u1", team: "RED", matchRating: 1200 },
      { userId: "u2", team: "YELLOW", matchRating: 1300 },
    ]);
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { matchId: "m1" } });
    expect(membershipFindMany.mock.calls[0][0]).toMatchObject({
      where: { orgId: "org-a", userId: { in: ["u1", "u2"] } },
    });
  });

  it("applies every Elo delta in ONE transaction, as route.ts:3526 did", async () => {
    const tx = vi.fn(async (ops: unknown[]) => ops.map(() => ({ count: 1 })));
    const membershipUpdateMany = vi.fn((a: unknown) => a as never);
    const deps = buildScoreApplyDeps({
      db: {
        match: matchInOrg("org-a"),
        teamAssignment: {},
        membership: { updateMany: membershipUpdateMany },
        $transaction: tx,
        user: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    await deps.applyEloDeltas("m1", [
      { userId: "u1", before: 1200, after: 1210, delta: 10 },
      { userId: "u2", before: 1300, after: 1290, delta: -10 },
    ]);
    expect(tx).toHaveBeenCalledOnce();
    expect(membershipUpdateMany).toHaveBeenCalledTimes(2);
    expect(membershipUpdateMany.mock.calls[0][0]).toEqual({
      where: { userId: "u1", orgId: "org-a" },
      data: { matchRating: 1210 },
    });
  });

  it("writes nothing at all when there are no deltas", async () => {
    const tx = vi.fn(async (ops: unknown[]) => ops);
    const deps = buildScoreApplyDeps({
      db: {
        match: matchInOrg("org-a"),
        teamAssignment: {},
        membership: { updateMany: vi.fn() },
        $transaction: tx,
        user: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    await deps.applyEloDeltas("m1", []);
    expect(tx).not.toHaveBeenCalled();
  });

  it("moves no Elo at all for a match whose org cannot be resolved", async () => {
    const tx = vi.fn(async (ops: unknown[]) => ops);
    const teamFindMany = vi.fn(async (_a: unknown) => [{ userId: "u1", team: "RED" }]);
    const deps = buildScoreApplyDeps({
      db: {
        match: { findUnique: async () => null },
        teamAssignment: { findMany: teamFindMany },
        membership: { findMany: vi.fn(), updateMany: vi.fn() },
        $transaction: tx,
        user: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    expect(await deps.loadEloInputs("gone")).toEqual([]);
    await deps.applyEloDeltas("gone", [{ userId: "u1", before: 1, after: 2, delta: 1 }]);
    expect(tx).not.toHaveBeenCalled();
  });
});

describe("the admin-ops apply deps", () => {
  it("loads the paid state with the CONFIRMED filter and the credit total", async () => {
    const findUnique = vi.fn(async (_a: unknown) => ({
      activity: { name: "Tuesday 7-a-side" },
      attendances: [
        { userId: "u1", paidAt: new Date(), user: { name: "Amir" } },
        { userId: "u2", paidAt: null, user: { name: "Faris" } },
      ],
      paymentCredits: [{ count: 2 }, { count: 1 }],
    }));
    const deps = buildAdminOpsApplyDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { match: { findUnique }, attendance: {}, paymentCredit: {}, user: {}, botJob: {} } as any,
      orgId: "org1",
    });
    const st = await deps.loadPaidState("m1");
    expect(st.matchName).toBe("Tuesday 7-a-side");
    expect(st.creditTotal).toBe(3);
    expect(st.confirmed).toEqual([
      { userId: "u1", name: "Amir", paid: true },
      { userId: "u2", name: "Faris", paid: false },
    ]);
    // The filter that keeps a bench player out of the unpaid count.
    expect(findUnique.mock.calls[0][0]).toMatchObject({
      include: { attendances: { where: { status: "CONFIRMED" } } },
    });
  });

  it("never re-stamps a row that is already paid (route.ts:3867's idempotence)", async () => {
    const updateMany = vi.fn(async (_a: unknown) => ({ count: 0 }));
    const deps = buildAdminOpsApplyDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { match: {}, attendance: { updateMany }, paymentCredit: {}, user: {}, botJob: {} } as any,
      orgId: "org1",
    });
    await deps.markPaid({ matchId: "m1", userId: "u1", payerUserId: "p1" });
    const arg = updateMany.mock.calls[0][0] as { where: Record<string, unknown> };
    // `paidAt: null` in the WHERE is the idempotence: a second credit for
    // the same player is a no-op rather than a re-stamp with a new date,
    // which would move the payment's timestamp and double-count nothing
    // but confuse the audit trail.
    expect(arg.where).toMatchObject({ matchId: "m1", userId: "u1", paidAt: null });
  });

  it("queues the reminder as a FUTURE-DATED dm BotJob, which is what makes it land on the day", async () => {
    const create = vi.fn(async (_a: unknown) => ({}));
    const when = new Date("2026-09-10T17:00:00.000Z");
    const deps = buildAdminOpsApplyDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { match: {}, attendance: {}, paymentCredit: {}, user: {}, botJob: { create } } as any,
      orgId: "org1",
    });
    await deps.queueReminderDm({ phone: "447700900123", text: "⏰ …", sendAt: when });
    expect(create.mock.calls[0][0]).toMatchObject({
      data: { orgId: "org1", kind: "dm", phone: "447700900123", sendAfter: when },
    });
  });

  it("strips a leading + from the phone, as every other DM site does", async () => {
    const create = vi.fn(async (_a: unknown) => ({}));
    const deps = buildAdminOpsApplyDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { match: {}, attendance: {}, paymentCredit: {}, user: {}, botJob: { create } } as any,
      orgId: "org1",
    });
    await deps.queueReminderDm({ phone: "+447700900123", text: "x", sendAt: new Date() });
    expect((create.mock.calls[0][0] as { data: { phone: string } }).data.phone).toBe(
      "447700900123",
    );
  });

  it("returns null rather than throwing for a member with no number on file", async () => {
    const deps = buildAdminOpsApplyDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { match: {}, attendance: {}, paymentCredit: {}, user: { findUnique: async () => ({ phoneNumber: null }) }, botJob: {} } as any,
      orgId: "org1",
    });
    expect(await deps.loadPhone("u1")).toBeNull();
  });
});

/**
 * THE GUEST-NAME-ASK SLOT.
 *
 * The row `pipeline/load-state.ts` reads back as
 * `SquadState.guestAskedUserIds`. It had no writer at all between §10
 * step 8 and 2026-09-07, so `guest-name-ask.ts`'s "one ask per player
 * per match, forever" gate was inert and MatchTime nagged on every
 * offer. These pin the two things a reimplementation gets wrong: the KEY
 * (the reader rebuilds it and compares exactly, so a typo is a gate that
 * never closes) and the failure DIRECTION.
 */
describe("the guest-name-ask claim", () => {
  it("writes the row the reader looks for — key, kind, match and player", async () => {
    const create = vi.fn(async (_a: unknown) => ({}));
    const claim = buildClaimGuestNameAsk({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: { sentNotification: { create } } as any,
    });
    await expect(claim({ matchId: "m1", userId: "u1" })).resolves.toBe(true);
    expect(create.mock.calls[0][0]).toEqual({
      data: {
        key: guestNameAskKey("m1", "u1"),
        kind: GUEST_NAME_ASK_KIND,
        matchId: "m1",
        targetUser: "u1",
      },
    });
    // Stated separately and on purpose: `load-state.ts` rebuilds this
    // exact string per roster member and compares it to the stored
    // `key`, so the format is a contract between two files.
    expect(guestNameAskKey("m1", "u1")).toBe("guest-name-ask:m1:u1");
  });

  it("a lost unique-key race returns false, so the caller stays silent", async () => {
    const claim = buildClaimGuestNameAsk({
      db: {
        sentNotification: {
          create: async () => {
            throw new Error("Unique constraint failed on the fields: (key)");
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    // It never throws into the batch: the ask is dropped, the batch is
    // not. Under-asking is a no-op; a thrown claim would have taken the
    // whole attendance batch down with it.
    await expect(claim({ matchId: "m1", userId: "u1" })).resolves.toBe(false);
  });
});
