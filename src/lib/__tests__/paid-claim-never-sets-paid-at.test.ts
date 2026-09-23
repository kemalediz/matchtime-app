/**
 * ══════════════════════════════════════════════════════════════════════
 * A PLAYER'S "PAID" NEVER MARKS THEM PAID.
 * ══════════════════════════════════════════════════════════════════════
 *
 * MatchTime cannot see money arrive. When a player DMs "Paid" (or taps
 * "Pay the collector directly" on the pay page), the only thing that may
 * happen is a PENDING state, `directPendingAt`, plus a DM to the money
 * collector with a link to confirm. `Attendance.paidAt` is set by exactly
 * two things: the collector's confirmation (`confirmDirectPayment`) and a
 * genuinely settled Stripe payment (`applyCheckoutEvent`).
 *
 * If this file goes red, something on the player-claim path has started
 * writing `paidAt`. Do not "fix" the test. A player saying they paid is
 * not money in the collector's account, and Sutton FC is live with real
 * money.
 *
 * Three independent proofs:
 *   1. the whole DM path, end to end against a recording database, with
 *      the classifier saying "paid": every write it makes is inspected;
 *   2. the shared settle-directly function, in every state it can meet;
 *   3. the source of both modules, so a future edit that writes the
 *      column is caught even on a branch no test drives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type Call = { model: string; method: string; args: unknown };
const calls: Call[] = [];
/** "model.method" → what the mock returns. */
const returns = new Map<string, (args: unknown) => unknown>();

vi.mock("@/lib/db", () => {
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async (args: unknown) => {
          calls.push({ model: name, method, args });
          const fn = returns.get(`${name}.${method}`);
          return fn ? fn(args) : null;
        },
      },
    );
  return { db: new Proxy({}, { get: (_t, name: string) => model(name) }) };
});
vi.mock("@/lib/magic-link", () => ({
  signMagicLinkToken: () => "tok",
  MAGIC_LINK_TTL: { actionNudge: 60, bookmark: 60 },
}));
vi.mock("@/lib/short-link", () => ({
  buildShortMagicLinkUrl: async () => "https://mt.example/s/x",
}));

import { handlePaymentClaimDm, PAYMENT_CLAIM_STUB_FILE_ENV } from "@/lib/payment-claim";
import { markDirectPaymentPending } from "@/lib/direct-payment";

const ORG = {
  id: "org-sutton",
  name: "Sutton FC",
  language: "en",
  stripeConnectAccountId: "acct_1",
  stripeChargesEnabled: true,
  payMethodPayByBank: false,
  payMethodCard: true,
  payMethodDirect: true,
  paymentHolderId: "u-kemal",
  paymentCollectionEnabled: true,
};
const MATCH = {
  id: "m-tue",
  feePerPlayer: 8,
  status: "COMPLETED",
  date: new Date("2026-09-22T20:30:00Z"),
  activity: { name: "Tuesday 7-a-side", orgId: ORG.id, org: ORG },
};

/** Every `data` payload any write carried, however deeply nested. */
function writtenData(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const c of calls) {
    if (!/^(create|update|updateMany|upsert|createMany)$/.test(c.method)) continue;
    const a = c.args as Record<string, unknown> | undefined;
    for (const k of ["data", "create", "update"]) {
      const d = a?.[k];
      if (d && typeof d === "object") out.push(d as Record<string, unknown>);
    }
  }
  return out;
}

function mentionsPaidAt(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  return Object.entries(v as Record<string, unknown>).some(([k, x]) => k === "paidAt" || mentionsPaidAt(x));
}

let stubDir = "";
beforeEach(() => {
  calls.length = 0;
  returns.clear();
  returns.set("attendance.findMany", () => [
    {
      directPendingAt: null,
      match: {
        id: MATCH.id,
        date: MATCH.date,
        feePerPlayer: 8,
        activity: { name: MATCH.activity.name, org: { id: ORG.id, language: "en", paymentHolderId: "u-kemal" } },
      },
    },
  ]);
  returns.set("user.findUnique", (a) =>
    (a as { where: { id: string } }).where.id === "u-kemal"
      ? { name: "Kemal Ediz", phoneNumber: "+447700900001" }
      : { name: "Abid Kazmi", phoneNumber: "+447700900009" },
  );
  returns.set("match.findUnique", () => MATCH);
  returns.set("attendance.findUnique", () => ({
    matchId: MATCH.id,
    userId: "u-abid",
    status: "CONFIRMED",
    paidAt: null,
    directPendingAt: null,
    paymentMethod: null,
    paymentQuantity: 1,
  }));
  returns.set("attendance.updateMany", () => ({ count: 1 }));
  returns.set("sentNotification.create", () => ({ id: "sn1" }));
  returns.set("botJob.create", () => ({}));
  returns.set("botJob.findFirst", () => ({ text: "💷 Quick one Abid, your *£8* is still outstanding" }));

  // The classifier says "paid" for these bodies, through its test seam:
  // the model's answer is stubbed, every gate and write below it is real.
  stubDir = mkdtempSync(path.join(tmpdir(), "paid-claim-"));
  const file = path.join(stubDir, "stub.json");
  writeFileSync(file, JSON.stringify({ bodies: { Paid: "paid", ödedim: "paid" } }));
  process.env[PAYMENT_CLAIM_STUB_FILE_ENV] = file;
});
afterEach(() => {
  delete process.env[PAYMENT_CLAIM_STUB_FILE_ENV];
});

describe("A PLAYER'S CLAIM NEVER SETS paidAt", () => {
  it("the DM path, end to end: pending set, collector told, paidAt never written", async () => {
    const out = await handlePaymentClaimDm({
      userId: "u-abid",
      userName: "Abid Kazmi",
      text: "Paid",
      waMessageId: "wa-1",
      replyPhone: "447700900009",
    });
    expect(out.handled).toBe("paid-claim");

    const data = writtenData();
    // It DID write: the pending state, the collector's DM, the reply.
    expect(data.some((d) => d.directPendingAt instanceof Date)).toBe(true);
    expect(data.filter((d) => typeof d.text === "string").length).toBe(2);
    // And not one write, anywhere, mentions paidAt.
    for (const d of data) expect(mentionsPaidAt(d), JSON.stringify(d)).toBe(false);

    // Every attendance write is guarded on the row still being UNPAID, so
    // a claim can never touch a payment the collector already confirmed.
    for (const c of calls.filter((c) => c.model === "attendance" && /update/.test(c.method))) {
      expect((c.args as { where: Record<string, unknown> }).where.paidAt).toBeNull();
    }
  });

  it("in Turkish too", async () => {
    const out = await handlePaymentClaimDm({
      userId: "u-abid",
      userName: "Abid Kazmi",
      text: "ödedim",
      waMessageId: "wa-2",
      replyPhone: "447700900009",
    });
    expect(out.handled).toBe("paid-claim");
    for (const d of writtenData()) expect(mentionsPaidAt(d)).toBe(false);
  });

  it("the shared settle-directly function, fresh and repeat, from both callers", async () => {
    for (const via of ["pay-page", "dm-claim"] as const) {
      for (const pending of [null, new Date()]) {
        calls.length = 0;
        returns.set("attendance.findUnique", () => ({
          matchId: MATCH.id,
          userId: "u-abid",
          status: "CONFIRMED",
          paidAt: null,
          directPendingAt: pending,
          paymentMethod: pending ? "direct" : null,
          paymentQuantity: 1,
        }));
        const r = await markDirectPaymentPending({ userId: "u-abid", matchId: MATCH.id, via });
        expect(r.ok).toBe(true);
        for (const d of writtenData()) expect(mentionsPaidAt(d), `${via}`).toBe(false);
      }
    }
  });

  it("the source of the claim path never assigns paidAt", () => {
    for (const rel of ["../payment-claim.ts", "../direct-payment.ts"]) {
      const src = readFileSync(path.join(__dirname, rel), "utf8");
      // Allowed: a guard (`paidAt: null` in a where), a select
      // (`paidAt: true`) and passing the row's OWN value to the pure pay
      // guard (`paidAt: attendance.paidAt`). Anything else, a `new Date()`
      // above all, is a claim path marking somebody paid.
      const assignments = [...src.matchAll(/paidAt\s*:\s*([^,}\n]+)/g)].map((m) => m[1].trim());
      const allowed = (v: string) => v === "null" || v === "true" || /^[a-z]\w*\.paidAt$/.test(v);
      expect(assignments.filter((v) => !allowed(v)), rel).toEqual([]);
    }
  });
});
