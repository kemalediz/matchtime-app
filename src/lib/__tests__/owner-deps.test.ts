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
import { fakeScoreDb, type FakeMatch } from "./fake-score-db";

describe("the score apply deps", () => {
  // Since 2026-10-07 both halves go through `lib/match-elo.ts`, the one
  // writer the dashboard shares, and `match-elo.test.ts` pins its
  // behaviour. These pin that THIS file hands it the right things, on
  // an in-memory database that keeps real state.
  const TEAMS = [
    { userId: "u1", team: "RED" as const },
    { userId: "u2", team: "YELLOW" as const },
  ];
  const fresh = (over: Partial<FakeMatch> = {}) =>
    fakeScoreDb({
      matches: [
        {
          id: "m1",
          orgId: "org-a",
          date: new Date("2026-10-06T19:30:00Z"),
          status: "TEAMS_PUBLISHED",
          redScore: null,
          yellowScore: null,
          eloApplied: null,
          teams: TEAMS,
          ...over,
        },
      ],
      ratings: { u1: 1200, u2: 1300 },
    });

  it("records the score AND moves the match to COMPLETED together", async () => {
    const f = fresh();
    const deps = buildScoreApplyDeps({ db: f.db });
    await deps.recordScore({ matchId: "m1", red: 5, yellow: 3 });
    expect(f.matches.get("m1")).toMatchObject({ redScore: 5, yellowScore: 3, status: "COMPLETED" });
    // Recording is not the Elo: nothing has moved yet.
    expect(Object.fromEntries(f.ratings)).toEqual({ u1: 1200, u2: 1300 });
  });

  it("moves the ratings of the players on the team sheet, at THAT club, and says how many", async () => {
    const f = fresh();
    const deps = buildScoreApplyDeps({ db: f.db });
    await deps.recordScore({ matchId: "m1", red: 5, yellow: 3 });
    expect(await deps.reconcileElo("m1")).toEqual({ moved: 2 });
    expect(f.ratings.get("u1")!).toBeGreaterThan(1200);
    expect(f.ratings.get("u2")!).toBeLessThan(1300);
  });

  it("a correction takes the first result's points back before adding the second's", async () => {
    const f = fresh();
    const deps = buildScoreApplyDeps({ db: f.db });
    await deps.recordScore({ matchId: "m1", red: 5, yellow: 3 });
    await deps.reconcileElo("m1");
    await deps.recordScore({ matchId: "m1", red: 3, yellow: 5, previous: { red: 5, yellow: 3 } });
    await deps.reconcileElo("m1");
    const corrected = Object.fromEntries(f.ratings);

    const g = fresh();
    const direct = buildScoreApplyDeps({ db: g.db });
    await direct.recordScore({ matchId: "m1", red: 3, yellow: 5 });
    await direct.reconcileElo("m1");
    expect(corrected).toEqual(Object.fromEntries(g.ratings));
  });

  it("refuses a correction decided against a result the match no longer has", async () => {
    const f = fresh({ redScore: 4, yellowScore: 4, status: "COMPLETED" });
    const deps = buildScoreApplyDeps({ db: f.db });
    await expect(
      deps.recordScore({ matchId: "m1", red: 3, yellow: 5, previous: { red: 5, yellow: 3 } }),
    ).rejects.toThrow(/reads 4-4/);
    expect(f.matches.get("m1")).toMatchObject({ redScore: 4, yellowScore: 4 });
  });

  it("reports ratings it had to leave alone as a sentence, and moves none", async () => {
    // An older match (scored before points were stored), with a later
    // match scored since: the old points cannot be recovered.
    const f = fakeScoreDb({
      matches: [
        {
          id: "m1",
          orgId: "org-a",
          date: new Date("2026-09-01T19:30:00Z"),
          status: "COMPLETED",
          redScore: 5,
          yellowScore: 3,
          eloApplied: null,
          teams: TEAMS,
        },
        {
          id: "m2",
          orgId: "org-a",
          date: new Date("2026-09-08T19:30:00Z"),
          status: "COMPLETED",
          redScore: 1,
          yellowScore: 1,
          eloApplied: null,
          teams: TEAMS,
        },
      ],
      ratings: { u1: 1200, u2: 1300 },
    });
    const deps = buildScoreApplyDeps({ db: f.db });
    await deps.recordScore({ matchId: "m1", red: 3, yellow: 5, previous: { red: 5, yellow: 3 } });
    const res = await deps.reconcileElo("m1");
    expect(res.moved).toBe(0);
    expect(res.left).toMatch(/still reflect 5-3/);
    expect(Object.fromEntries(f.ratings)).toEqual({ u1: 1200, u2: 1300 });
  });

  it("remembers the question: one row per match, the numbers in the key, the asker beside it", async () => {
    const f = fresh();
    const deps = buildScoreApplyDeps({ db: f.db });
    await deps.recordScoreAsk!({ matchId: "m1", first: 10, second: 7, askerUserId: "u1" });
    expect(f.notifications).toEqual([
      { key: "m1:score-ask:10-7", kind: "score-ask", matchId: "m1", targetUser: "u1" },
    ]);
    // A different scoreline REPLACES it; an unidentified sender is null.
    await deps.recordScoreAsk!({ matchId: "m1", first: 10, second: 6, askerUserId: null });
    expect(f.notifications).toEqual([
      { key: "m1:score-ask:10-6", kind: "score-ask", matchId: "m1", targetUser: null },
    ]);
    // Asking the same thing twice is not a unique-key failure.
    await deps.recordScoreAsk!({ matchId: "m1", first: 10, second: 6, askerUserId: "u2" });
    expect(f.notifications).toHaveLength(1);
  });

  it("recording a result closes the question", async () => {
    const f = fresh();
    const deps = buildScoreApplyDeps({ db: f.db });
    await deps.recordScoreAsk!({ matchId: "m1", first: 10, second: 7, askerUserId: "u1" });
    await deps.recordScore({ matchId: "m1", red: 10, yellow: 7 });
    expect(f.notifications).toEqual([]);
  });

  it("moves no Elo at all for a match that has gone", async () => {
    const f = fresh();
    const deps = buildScoreApplyDeps({ db: f.db });
    expect(await deps.reconcileElo("gone")).toEqual({ moved: 0 });
    expect(Object.fromEntries(f.ratings)).toEqual({ u1: 1200, u2: 1300 });
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
