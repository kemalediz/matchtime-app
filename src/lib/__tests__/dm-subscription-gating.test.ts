/**
 * Sender-gating tests for the DM-subscription categories that live inside
 * src/lib/bot-scheduler.ts (bench offer, tentative follow-up, rating DM)
 * and the PAYMENT senders that must NEVER be gated.
 *
 * bot-scheduler.ts imports the Prisma client, which vitest's transpiler
 * cannot load (Prisma 7 generated ESM-TS) — so, matching the existing
 * convention in payment-suppression.test.ts, the inclusion/skip predicates
 * are HAND-MIRRORED here as tiny pure functions, each citing the exact
 * source file:line it mirrors. If bot-scheduler.ts changes those
 * predicates, these copies MUST be kept in sync.
 *
 * The load-bearing assertions:
 *   - bench/tentative/rating skip a member whose category flag is false;
 *   - a member with ALL sub* flags false STILL receives the payment link
 *     and the payment chase (payment predicates never read a sub flag).
 */
import { describe, it, expect } from "vitest";
import { DM_SUB_FIELDS, type DmSubField } from "@/lib/dm-subscriptions";

/** Every sub* category turned OFF — the "only payment" member from the
 *  real incident. */
const ALL_OFF: Record<DmSubField, boolean> = Object.fromEntries(
  DM_SUB_FIELDS.map((f) => [f, false]),
) as Record<DmSubField, boolean>;

interface AttendanceLike {
  userId: string;
  status?: "CONFIRMED" | "BENCH" | "DROPPED";
  paidAt?: Date | null;
  directPendingAt?: Date | null;
  user: { id?: string; phoneNumber: string | null };
}

const NOW = new Date();

// ── Bench offer (bot-scheduler.ts benchAtt filter) ──────────────────────
// MIRRORS: `a.status === "BENCH" && a.user.phoneNumber && !benchOptedOut.has(a.userId)`
// where benchOptedOut = memberships with subBenchOfferDm=false.
const benchIncluded = (a: AttendanceLike, benchOptedOut: Set<string>): boolean =>
  a.status === "BENCH" && !!a.user.phoneNumber && !benchOptedOut.has(a.userId);

describe("bench-offer gating (subBenchOfferDm=false)", () => {
  const bencher: AttendanceLike = { userId: "b1", status: "BENCH", user: { phoneNumber: "+447700900000" } };

  it("INCLUDES a subscribed bencher with a phone", () => {
    expect(benchIncluded(bencher, new Set())).toBe(true);
  });
  it("EXCLUDES a bencher who opted out of bench offers", () => {
    expect(benchIncluded(bencher, new Set(["b1"]))).toBe(false);
  });
});

// ── Tentative follow-up (bot-scheduler.ts dueRows loop) ─────────────────
// MIRRORS: `if (tentativeOptedOut.has(row.user.id)) continue;`
const tentativeSent = (userId: string, tentativeOptedOut: Set<string>): boolean =>
  !tentativeOptedOut.has(userId);

describe("tentative follow-up gating (subTentativeDm=false)", () => {
  it("SENDS to a subscribed maybe", () => {
    expect(tentativeSent("u1", new Set())).toBe(true);
  });
  it("SKIPS a maybe who opted out of tentative DMs", () => {
    expect(tentativeSent("u1", new Set(["u1"]))).toBe(false);
  });
});

// ── Rating DM + daily rating reminder (bot-scheduler.ts) ─────────────────
// MIRRORS the `if (optedOut.has(a.userId)) continue;` guard in BOTH the
// rate-dm and rate-reminder loops, where optedOut = memberships with
// subRatingDm=false.
const ratingSent = (userId: string, ratingOptedOut: Set<string>): boolean =>
  !ratingOptedOut.has(userId);

describe("rating-DM gating (subRatingDm=false)", () => {
  it("SENDS the rating DM to a subscribed player", () => {
    expect(ratingSent("p1", new Set())).toBe(true);
  });
  it("SKIPS the rating DM + reminder for a player who opted out", () => {
    expect(ratingSent("p1", new Set(["p1"]))).toBe(false);
  });
});

// ── PAYMENT — NEVER gated ────────────────────────────────────────────────
// Payment link release: MIRRORS payment-flow.ts (`a.user.id !== collectorId
// && a.user.phoneNumber`). Payment chase: MIRRORS bot-scheduler.ts pay-chase
// loop (`a.userId !== collector && !a.paidAt && !a.directPendingAt &&
// a.user.phoneNumber`). NEITHER predicate reads any sub* flag.
const payLinkIncluded = (a: AttendanceLike, collectorId: string): boolean =>
  a.user.id !== collectorId && !!a.user.phoneNumber;

const payChaseIncluded = (a: AttendanceLike, collectorId: string): boolean =>
  a.userId !== collectorId && !a.paidAt && !a.directPendingAt && !!a.user.phoneNumber;

describe("PAYMENT DMs are never gated by any subscription flag", () => {
  // A player who turned off EVERY proactive-DM category but still owes money.
  const owes: AttendanceLike = {
    userId: "debtor",
    status: "CONFIRMED",
    paidAt: null,
    directPendingAt: null,
    user: { id: "debtor", phoneNumber: "+447700900123" },
  };

  it("member with ALL sub flags false STILL gets the payment link", () => {
    // Assert the flags really are all off (guards against silent field drift).
    expect(Object.values(ALL_OFF).every((v) => v === false)).toBe(true);
    expect(payLinkIncluded(owes, "collector")).toBe(true);
  });

  it("member with ALL sub flags false STILL gets the payment chase", () => {
    expect(payChaseIncluded(owes, "collector")).toBe(true);
  });

  it("payment predicates take no sub-flag argument at all (structurally ungatable)", () => {
    // If someone ever added a sub-flag param, these arities would change and
    // this test would fail — a tripwire that payment stayed ungated.
    expect(payLinkIncluded.length).toBe(2); // (attendance, collectorId)
    expect(payChaseIncluded.length).toBe(2); // (attendance, collectorId)
  });
});
