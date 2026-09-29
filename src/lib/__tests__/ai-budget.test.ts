/**
 * The daily AI spend cap: the rule, the day, and the database half's
 * failure mode. The SQL itself (atomic reservation under concurrency) is
 * exercised against a real Postgres by `e2e/api/ai-daily-cap.spec.ts`.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  organisation: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const silentMock = vi.hoisted(() => ({ isSilentGroup: vi.fn(async (_g: string) => false) }));
vi.mock("../club-approval", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../club-approval")>()),
  isSilentGroup: (g: string) => silentMock.isSilentGroup(g),
}));

import {
  aiAllowanceUsd,
  londonDay,
  prismaAiBudgetLedger,
  getAiBudgetStatus,
  onboardingGroupKey,
  onboardingUserKey,
  pickCapReplyMessage,
  DAILY_CAP_USD,
  NEW_CLUB_CAP_USD,
  NEW_CLUB_WINDOW_DAYS,
  CALL_RESERVE_USD,
} from "../ai-budget";
import { AiBudgetExceededError } from "../ai-budget-context";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-29T12:00:00Z");

/** Sutton FC's real shape: created in the spring, live, no override,
 *  approved by the migration's default with no `approvedAt`. */
const sutton = {
  createdAt: new Date("2026-04-06T10:00:00Z"),
  aiDailyCapUsd: null as number | null,
  aiWindowStartAt: null as Date | null,
  whatsappBotEnabled: true,
  whatsappGroupId: "120363000000000000@g.us",
  approvalStatus: "approved",
  approvedAt: null as Date | null,
};

describe("aiAllowanceUsd: how much a club may spend today", () => {
  it("an established club gets $1.00 a day (Sutton FC)", () => {
    expect(DAILY_CAP_USD).toBe(1);
    expect(aiAllowanceUsd(sutton, NOW)).toBe(1);
  });

  it("a club in its first four weeks gets $0.25 a day", () => {
    expect(NEW_CLUB_CAP_USD).toBe(0.25);
    expect(NEW_CLUB_WINDOW_DAYS).toBe(28);
    const fresh = { ...sutton, createdAt: new Date(NOW.getTime() - 3 * DAY) };
    expect(aiAllowanceUsd(fresh, NOW)).toBe(0.25);
  });

  it("the window is exactly 28 days: a second before is new, the boundary is established", () => {
    const start = new Date(NOW.getTime() - 28 * DAY);
    expect(aiAllowanceUsd({ ...sutton, createdAt: new Date(start.getTime() + 1000) }, NOW)).toBe(0.25);
    expect(aiAllowanceUsd({ ...sutton, createdAt: start }, NOW)).toBe(1);
  });

  it("aiWindowStartAt, when set, starts the window instead of createdAt", () => {
    // Created long ago, but approved (went live) yesterday.
    const approvedYesterday = { ...sutton, aiWindowStartAt: new Date(NOW.getTime() - DAY) };
    expect(aiAllowanceUsd(approvedYesterday, NOW)).toBe(0.25);
    // Created yesterday, window start pinned to long ago.
    const pinnedOld = {
      ...sutton,
      createdAt: new Date(NOW.getTime() - DAY),
      aiWindowStartAt: new Date(NOW.getTime() - 60 * DAY),
    };
    expect(aiAllowanceUsd(pinnedOld, NOW)).toBe(1);
  });

  it("the platform owner's override wins over both defaults", () => {
    expect(aiAllowanceUsd({ ...sutton, aiDailyCapUsd: 2.5 }, NOW)).toBe(2.5);
    const fresh = { ...sutton, createdAt: new Date(NOW.getTime() - DAY), aiDailyCapUsd: 0.75 };
    expect(aiAllowanceUsd(fresh, NOW)).toBe(0.75);
    // A negative override is nonsense and reads as "spend nothing".
    expect(aiAllowanceUsd({ ...sutton, aiDailyCapUsd: -1 }, NOW)).toBe(0);
  });

  it("a club that is not live spends nothing, and the override cannot lift that", () => {
    expect(aiAllowanceUsd({ ...sutton, whatsappBotEnabled: false }, NOW)).toBe(0);
    expect(aiAllowanceUsd({ ...sutton, whatsappGroupId: null }, NOW)).toBe(0);
    expect(aiAllowanceUsd({ ...sutton, whatsappBotEnabled: false, aiDailyCapUsd: 5 }, NOW)).toBe(0);
  });

  it("spend before a club exists (onboarding) gets the new-club allowance", () => {
    expect(aiAllowanceUsd(null, NOW)).toBe(0.25);
  });
});

describe("aiAllowanceUsd and club approval (self-join slice 1)", () => {
  it("Sutton FC's real prod shape is unchanged: approved, no approvedAt, its $1.50 override", () => {
    expect(aiAllowanceUsd({ ...sutton, aiDailyCapUsd: 1.5 }, NOW)).toBe(1.5);
    expect(aiAllowanceUsd(sutton, NOW)).toBe(1);
  });

  it("a club that is not approved spends $0, whatever the override and whatever else is set", () => {
    for (const approvalStatus of ["draft", "pending", "rejected", "suspended"]) {
      // Even in a shape the CHECK constraint forbids (bot on, not approved).
      expect(aiAllowanceUsd({ ...sutton, approvalStatus }, NOW)).toBe(0);
      expect(aiAllowanceUsd({ ...sutton, approvalStatus, aiDailyCapUsd: 5 }, NOW)).toBe(0);
    }
  });

  it("the 4-week window starts at approvedAt when set, before aiWindowStartAt and createdAt", () => {
    // Created 60 days ago, waited in pending, approved yesterday: full new-club window.
    const approvedYesterday = {
      ...sutton,
      createdAt: new Date(NOW.getTime() - 60 * DAY),
      approvedAt: new Date(NOW.getTime() - DAY),
    };
    expect(aiAllowanceUsd(approvedYesterday, NOW)).toBe(0.25);
    // approvedAt wins over a stale aiWindowStartAt in either direction.
    expect(aiAllowanceUsd({ ...approvedYesterday, aiWindowStartAt: new Date(NOW.getTime() - 90 * DAY) }, NOW)).toBe(0.25);
    const approvedLongAgo = { ...sutton, approvedAt: new Date(NOW.getTime() - 30 * DAY) };
    expect(aiAllowanceUsd({ ...approvedLongAgo, aiWindowStartAt: new Date(NOW.getTime() - DAY) }, NOW)).toBe(1);
  });

  it("with approvedAt null the old rule holds: aiWindowStartAt, else createdAt", () => {
    expect(aiAllowanceUsd({ ...sutton, aiWindowStartAt: new Date(NOW.getTime() - DAY) }, NOW)).toBe(0.25);
    expect(aiAllowanceUsd({ ...sutton, createdAt: new Date(NOW.getTime() - DAY) }, NOW)).toBe(0.25);
  });
});

describe("the ledger's cap for spend with no club yet", () => {
  const ENV = process.env.SELF_JOIN_ENABLED;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    silentMock.isSilentGroup.mockResolvedValue(false);
    dbMock.$queryRaw.mockResolvedValue([{ ok: 1 }]);
    delete process.env.SELF_JOIN_ENABLED;
  });
  afterAll(() => {
    if (ENV === undefined) delete process.env.SELF_JOIN_ENABLED;
    else process.env.SELF_JOIN_ENABLED = ENV;
  });

  it("an ordinary unknown group's onboarding still gets the new-club allowance", async () => {
    const ledger = prismaAiBudgetLedger(() => NOW);
    const hold = await ledger.reserve(onboardingGroupKey("g-new"), "onboarding");
    expect(hold.reservedUsd).toBe(CALL_RESERVE_USD);
  });

  it("a SILENT group's onboarding key is allowed $0", async () => {
    silentMock.isSilentGroup.mockImplementation(async (g: string) => g === "g-pending");
    const ledger = prismaAiBudgetLedger(() => NOW);
    await expect(ledger.reserve(onboardingGroupKey("g-pending"), "onboarding")).rejects.toBeInstanceOf(
      AiBudgetExceededError,
    );
  });

  it("with self-join on, the retired in-group setup is allowed $0 for every group", async () => {
    process.env.SELF_JOIN_ENABLED = "1";
    const ledger = prismaAiBudgetLedger(() => NOW);
    await expect(ledger.reserve(onboardingGroupKey("g-new"), "onboarding")).rejects.toBeInstanceOf(
      AiBudgetExceededError,
    );
  });

  it("the web wizard's user key is unaffected by the group rules", async () => {
    process.env.SELF_JOIN_ENABLED = "1";
    silentMock.isSilentGroup.mockResolvedValue(true);
    const ledger = prismaAiBudgetLedger(() => NOW);
    const hold = await ledger.reserve(onboardingUserKey("u-1"), "wizard");
    expect(hold.reservedUsd).toBe(CALL_RESERVE_USD);
  });
});

describe("londonDay: the day the cap resets on is London's, not UTC's", () => {
  it("summer (BST): 23:59:59 London is still today, 00:00 London is tomorrow", () => {
    expect(londonDay(new Date("2026-09-28T22:59:59Z"))).toBe("2026-09-28");
    expect(londonDay(new Date("2026-09-28T23:00:00Z"))).toBe("2026-09-29");
  });

  it("winter (GMT): London midnight is UTC midnight", () => {
    expect(londonDay(new Date("2026-12-01T23:59:59Z"))).toBe("2026-12-01");
    expect(londonDay(new Date("2026-12-02T00:00:00Z"))).toBe("2026-12-02");
  });

  it("the clocks-go-back night is one day, not two", () => {
    // 2026-10-25 01:00 BST -> 01:00 GMT. Both sides are the 25th.
    expect(londonDay(new Date("2026-10-24T23:30:00Z"))).toBe("2026-10-25");
    expect(londonDay(new Date("2026-10-25T01:30:00Z"))).toBe("2026-10-25");
  });
});

describe("the database ledger fails OPEN", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("when the usage table cannot be written, the call is allowed and nothing throws", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(sutton);
    dbMock.$queryRaw.mockRejectedValue(new Error("connection reset"));
    dbMock.$executeRaw.mockRejectedValue(new Error("connection reset"));
    const ledger = prismaAiBudgetLedger(() => NOW);
    const hold = await ledger.reserve("org-1", "router");
    expect(hold.reservedUsd).toBe(0);
    await expect(ledger.settle(hold, 0.003)).resolves.toBeUndefined();
    await expect(ledger.release(hold)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("when the org cannot be read, the call is allowed", async () => {
    dbMock.organisation.findUnique.mockRejectedValue(new Error("timeout"));
    const ledger = prismaAiBudgetLedger(() => NOW);
    const hold = await ledger.reserve("org-1", "router");
    expect(hold.reservedUsd).toBe(0);
  });

  it("a granted reservation holds CALL_RESERVE_USD on today's London day", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(sutton);
    dbMock.$queryRaw.mockResolvedValue([{ ok: 1 }]);
    const ledger = prismaAiBudgetLedger(() => NOW);
    const hold = await ledger.reserve("org-1", "router");
    expect(hold).toEqual({ key: "org-1", day: "2026-09-29", reservedUsd: CALL_RESERVE_USD });
  });

  it("a refused reservation throws AiBudgetExceededError and records the refusal", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(sutton);
    dbMock.$queryRaw.mockResolvedValue([]); // the conditional upsert matched nothing
    const ledger = prismaAiBudgetLedger(() => NOW);
    await expect(ledger.reserve("org-1", "router")).rejects.toBeInstanceOf(AiBudgetExceededError);
    const sql = dbMock.$queryRaw.mock.calls.map((c) => (c[0] as string[]).join("?"));
    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain(`"reservedUsd" = "OrgAiUsage"."reservedUsd" +`);
    expect(sql[1]).toContain(`"refusedCalls" = "OrgAiUsage"."refusedCalls" + 1`);
  });

  it("a club allowed $0 is refused without asking the database for a reservation", async () => {
    dbMock.organisation.findUnique.mockResolvedValue({ ...sutton, whatsappBotEnabled: false });
    dbMock.$queryRaw.mockResolvedValue([]);
    const ledger = prismaAiBudgetLedger(() => NOW);
    await expect(ledger.reserve("org-1", "router")).rejects.toBeInstanceOf(AiBudgetExceededError);
    const sql = dbMock.$queryRaw.mock.calls.map((c) => (c[0] as string[]).join("?"));
    // Only the refusal is recorded; no reservation is ever attempted.
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain(`"refusedCalls"`);
  });

  it("getAiBudgetStatus reports NOT capped when the table cannot be read", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(sutton);
    dbMock.$queryRaw.mockRejectedValue(new Error("relation does not exist"));
    const s = await getAiBudgetStatus("org-1", NOW);
    expect(s.capped).toBe(false);
    expect(s.failedOpen).toBe(true);
  });

  it("getAiBudgetStatus reports capped once spend plus holds reach the cap", async () => {
    dbMock.organisation.findUnique.mockResolvedValue(sutton);
    dbMock.$queryRaw.mockResolvedValue([{ costUsd: 0.97, reservedUsd: 0.03 }]);
    const s = await getAiBudgetStatus("org-1", NOW);
    expect(s).toMatchObject({ capped: true, capUsd: 1, spentUsd: 0.97 });
    dbMock.$queryRaw.mockResolvedValue([{ costUsd: 0.5, reservedUsd: 0 }]);
    expect((await getAiBudgetStatus("org-1", NOW)).capped).toBe(false);
  });
});

describe("pickCapReplyMessage: one polite line per club per day, to a tagged message only", () => {
  const m = (id: string, tagged: boolean) => ({ waMessageId: id, tagged });

  it("replies to the first tagged message when today's line is still unclaimed", async () => {
    const claim = vi.fn(async () => true);
    expect(await pickCapReplyMessage([m("a", false), m("b", true), m("c", true)], claim)).toBe("b");
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("says nothing when today's line was already sent", async () => {
    expect(await pickCapReplyMessage([m("b", true)], async () => false)).toBeNull();
  });

  it("never claims the line for an untagged batch, so it is still there for a tagged one later", async () => {
    const claim = vi.fn(async () => true);
    expect(await pickCapReplyMessage([m("a", false), m("b", false)], claim)).toBeNull();
    expect(claim).not.toHaveBeenCalled();
  });

  it("says nothing when the claim itself fails (silence is the safe side of a DB error)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await pickCapReplyMessage([m("b", true)], async () => {
        throw new Error("db down");
      }),
    ).toBeNull();
  });
});
