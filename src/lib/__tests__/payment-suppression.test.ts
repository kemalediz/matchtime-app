/**
 * Unit tests for the payment-chase SUPPRESSION predicates in
 * src/lib/bot-scheduler.ts.
 *
 * bot-scheduler.ts imports the Prisma client, which Playwright/vitest's
 * transpiler cannot load (Prisma 7 generated ESM-TS). So rather than
 * import the module, the three suppression predicates are HAND-MIRRORED
 * here as tiny pure functions, each citing the exact source file:line it
 * mirrors. If bot-scheduler.ts changes those predicates, these copies
 * MUST be kept in sync — they are not auto-derived.
 *
 * They are the gate logic behind:
 *   - the per-player "still outstanding" pay-link DM,
 *   - the collector "X will pay you directly" confirm-receipt nudge,
 *   - the group "N payments still pending" unpaid tail count.
 */
import { describe, it, expect } from "vitest";

/** Minimal attendance-like shape — only the fields the predicates read. */
interface AttendanceLike {
  userId: string;
  paidAt: Date | null;
  directPendingAt: Date | null;
  user: { phoneNumber: string | null };
}

const COLLECTOR = "user-collector";
const NOW = new Date();

const make = (over: Partial<AttendanceLike> & { userId: string }): AttendanceLike => ({
  paidAt: null,
  directPendingAt: null,
  user: { phoneNumber: "+447700900000" },
  ...over,
});

/**
 * Per-player pay-link DM inclusion gate.
 * MIRRORS bot-scheduler.ts:1371-1374 (the four `continue` guards inside
 * the `for (const a of confirmed)` loop). A player gets the DM only when
 * ALL guards pass.
 */
const payChaseIncluded = (a: AttendanceLike, collectorId: string): boolean =>
  a.userId !== collectorId && // :1371 collector doesn't pay
  !a.paidAt && // :1372 already paid → suppressed
  !a.directPendingAt && // :1373 handled by collector nudge instead
  !!a.user.phoneNumber; // :1374 no phone → can't DM

/**
 * Collector confirm-receipt nudge gate (per attendance).
 * MIRRORS bot-scheduler.ts:1403 — `confirmed.filter(a => !a.paidAt && a.directPendingAt)`.
 */
const isPendingDirect = (a: AttendanceLike): boolean =>
  !a.paidAt && !!a.directPendingAt;

/**
 * Unpaid-tail count.
 * MIRRORS bot-scheduler.ts:260-273 — exclude the payer/collector, then
 * count confirmed attendances with paidAt == null, then subtract
 * aggregate PaymentCredit counts (floored at 0).
 */
const unpaidTailCount = (
  confirmed: AttendanceLike[],
  payerId: string | null,
  creditCount = 0,
): number => {
  const eligible = payerId ? confirmed.filter((a) => a.userId !== payerId) : confirmed;
  const unpaidPeople = eligible.filter((a) => a.paidAt == null).length;
  return Math.max(0, unpaidPeople - creditCount);
};

describe("pay-chase per-player DM inclusion (bot-scheduler.ts:1371-1374)", () => {
  it("INCLUDES an unpaid player who has a phone, is not the collector, and is not direct-pending", () => {
    expect(payChaseIncluded(make({ userId: "p1" }), COLLECTOR)).toBe(true);
  });

  it("EXCLUDES a player whose paidAt is set (:1372 — the suppression under test)", () => {
    expect(payChaseIncluded(make({ userId: "p1", paidAt: NOW }), COLLECTOR)).toBe(false);
  });

  it("EXCLUDES the collector themselves (:1371)", () => {
    expect(payChaseIncluded(make({ userId: COLLECTOR }), COLLECTOR)).toBe(false);
  });

  it("EXCLUDES a direct-pending player — routed to the collector nudge (:1373)", () => {
    expect(payChaseIncluded(make({ userId: "p1", directPendingAt: NOW }), COLLECTOR)).toBe(false);
  });

  it("EXCLUDES a player with no phone number (:1374)", () => {
    expect(
      payChaseIncluded(make({ userId: "p1", user: { phoneNumber: null } }), COLLECTOR),
    ).toBe(false);
  });
});

describe("collector confirm-receipt nudge predicate (bot-scheduler.ts:1403)", () => {
  it("is TRUE for an unpaid, direct-pending attendance", () => {
    expect(isPendingDirect(make({ userId: "g", directPendingAt: NOW }))).toBe(true);
  });

  it("is FALSE once paidAt is set (direct payment confirmed)", () => {
    expect(isPendingDirect(make({ userId: "g", paidAt: NOW, directPendingAt: NOW }))).toBe(false);
  });

  it("is FALSE when neither paidAt nor directPendingAt is set (electronic-pay player)", () => {
    expect(isPendingDirect(make({ userId: "g" }))).toBe(false);
  });
});

describe("unpaid-tail count (bot-scheduler.ts:260-273)", () => {
  // 4 confirmed: collector (payer, excluded), one paid, two unpaid.
  const confirmed: AttendanceLike[] = [
    make({ userId: COLLECTOR }), // payer → excluded
    make({ userId: "paid1", paidAt: NOW }), // paid → not counted
    make({ userId: "unpaid1" }), // unpaid
    make({ userId: "unpaid2" }), // unpaid
  ];

  it("counts only non-payer unpaid attendances → 2", () => {
    expect(unpaidTailCount(confirmed, COLLECTOR)).toBe(2);
  });

  it("drops to 1 after one of the unpaid is marked paid", () => {
    const after = confirmed.map((a) =>
      a.userId === "unpaid1" ? { ...a, paidAt: NOW } : a,
    );
    expect(unpaidTailCount(after, COLLECTOR)).toBe(1);
  });

  it("subtracts aggregate PaymentCredit count, floored at 0", () => {
    // 2 unpaid - 1 credit = 1
    expect(unpaidTailCount(confirmed, COLLECTOR, 1)).toBe(1);
    // 2 unpaid - 5 credits = 0 (never negative)
    expect(unpaidTailCount(confirmed, COLLECTOR, 5)).toBe(0);
  });

  it("includes everyone (no payer exclusion) when payerId is null", () => {
    // null payer → collector row is now counted as unpaid too → 3
    expect(unpaidTailCount(confirmed, null)).toBe(3);
  });
});
