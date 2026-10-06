/**
 * A REGULAR'S "PAID" FOR THE MONTH NEVER MARKS THEM PAID (D3).
 *
 * The month's twin of `paid-claim-never-sets-paid-at.test.ts`. MatchTime
 * cannot see a bank transfer arrive. "(paid)" on a list, a "paid" DM and
 * the "I've paid" button record a CLAIM (`paidClaimedAt`). The month's
 * `paidAt` is written by exactly one function, `writeConfirmed`, which
 * only the collector's own action reaches (the Months page, or their
 * explicit "PAID ..." reply to the digest).
 *
 * If this file goes red, something on a claim path has started writing
 * `paidAt`. Do not "fix" the test.
 *
 * Two proofs:
 *   1. the claim paths against a recording database: every write they
 *      make is inspected;
 *   2. the sources, so an edit on a branch no test drives is caught.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

type Call = { model: string; method: string; args: unknown };
const calls: Call[] = [];
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

import { claimMonthPaid, handlePlayerPaidDm } from "@/lib/month-payment";

const WRITES = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const writes = () => calls.filter((c) => WRITES.has(c.method));
const mentionsPaidAt = (v: unknown): boolean => JSON.stringify(v ?? null).includes('"paidAt"');

beforeEach(() => {
  calls.length = 0;
  returns.clear();
});

describe("a claim never writes paidAt", () => {
  it("claimMonthPaid: one write, a claim, and only on a row that is neither confirmed nor already claimed", async () => {
    returns.set("squadMonthMember.updateMany", () => ({ count: 1 }));
    expect(await claimMonthPaid({ monthId: "m", userId: "u", source: "list", amountPence: 3750 })).toBe(true);
    const w = writes();
    expect(w).toHaveLength(1);
    const { where, data } = w[0].args as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(Object.keys(data).sort()).toEqual(["paidClaimSource", "paidClaimedAmountPence", "paidClaimedAt"]);
    expect(where).toMatchObject({ paidAt: null, paidClaimedAt: null, kind: "regular", leftAt: null });
  });

  it("saying it again: nothing, unless the collector had answered 'not arrived', and then it is a NEW claim with a new time", async () => {
    // Already claimed, never declined: no second claim.
    returns.set("squadMonthMember.updateMany", () => ({ count: 0 }));
    returns.set("squadMonth.findUnique", () => ({ orgId: "org" }));
    returns.set("sentNotification.deleteMany", () => ({ count: 0 }));
    expect(await claimMonthPaid({ monthId: "m", userId: "u", source: "dm" })).toBe(false);
    expect(writes().filter((c) => c.model === "squadMonthMember")).toHaveLength(1);

    // Declined, then "paid" again: the decline is dropped and the claim re-stamped.
    calls.length = 0;
    const now = new Date("2026-10-29T11:30:00.000Z");
    let n = 0;
    returns.set("squadMonthMember.updateMany", () => ({ count: n++ === 0 ? 0 : 1 }));
    returns.set("sentNotification.deleteMany", () => ({ count: 1 }));
    expect(await claimMonthPaid({ monthId: "m", userId: "u", source: "dm", now })).toBe(true);
    const w = writes();
    expect(w.map((c) => `${c.model}.${c.method}`)).toEqual(["squadMonthMember.updateMany", "sentNotification.deleteMany", "squadMonthMember.updateMany"]);
    expect((w[1].args as { where: { key: string } }).where.key).toBe("org-org:mpy:declined:m:u");
    const again = w[2].args as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(again.data.paidClaimedAt).toEqual(now);
    expect(again.where).toMatchObject({ paidAt: null });
    for (const c of w) expect(mentionsPaidAt((c.args as { data?: unknown }).data)).toBe(false);
  });

  it("the 'paid' DM, end to end: a claim, an answer, and no paidAt anywhere", async () => {
    returns.set("squadMonthMember.findMany", () => [
      {
        monthId: "m",
        amountDuePence: 3750,
        paidClaimedAt: null,
        month: { orgId: "org", monthStart: new Date("2026-11-01T00:00:00.000Z"), org: { language: "en", paymentHolderId: "sam" } },
      },
    ]);
    returns.set("attendance.count", () => 0);
    returns.set("squadMonthMember.updateMany", () => ({ count: 1 }));
    returns.set("sentNotification.create", () => ({}));
    returns.set("user.findUnique", () => ({ name: "Sam Collector" }));
    const res = await handlePlayerPaidDm({ userId: "u", userName: "Alex Carter", text: "paid £37.50", replyPhone: "447700900002" });
    expect(res).toEqual({ handled: "month-paid-claim", monthId: "m", claimed: true });
    const w = writes();
    // The claim, the once-a-day key, the answer.
    expect(w.map((c) => `${c.model}.${c.method}`)).toEqual(["squadMonthMember.updateMany", "sentNotification.create", "botJob.create"]);
    for (const c of w) expect(mentionsPaidAt((c.args as { data?: unknown }).data), `${c.model}.${c.method}`).toBe(false);
    const dm = (w[2].args as { data: { text: string } }).data.text;
    expect(dm).toContain("you say you have paid £37.50 for November");
    expect(dm).toContain("Sam will confirm when it arrives");
  });

  it("not the fixed words, two months to pay for, or a per-match fee owed: nothing is read as a month claim, nothing is written", async () => {
    expect(await handlePlayerPaidDm({ userId: "u", userName: null, text: "have I paid?", replyPhone: "44" })).toBeNull();
    expect(calls).toEqual([]);

    returns.set("squadMonthMember.findMany", () => [{ monthId: "a" }, { monthId: "b" }]);
    expect(await handlePlayerPaidDm({ userId: "u", userName: null, text: "paid", replyPhone: "44" })).toBeNull();
    expect(writes()).toEqual([]);

    returns.set("squadMonthMember.findMany", () => [
      { monthId: "m", amountDuePence: 1, paidClaimedAt: null, month: { orgId: "org", monthStart: new Date(), org: { language: "en", paymentHolderId: null } } },
    ]);
    returns.set("attendance.count", () => 1);
    expect(await handlePlayerPaidDm({ userId: "u", userName: null, text: "paid", replyPhone: "44" })).toBeNull();
    expect(writes()).toEqual([]);
  });
});

describe("the sources: paidAt is written in one place", () => {
  const src = (file: string) => readFileSync(path.resolve(__dirname, "..", file), "utf8");
  /** `paidAt: <value>` where the value is a write: not a filter, a select or a type. */
  const paidAtWrites = (text: string) =>
    [...text.matchAll(/\bpaidAt:\s*([^,}\n]+)/g)].map((m) => m[1].trim()).filter((v) => v !== "true" && v !== "null" && !v.startsWith("{") && !v.startsWith("Date"));

  it("month-payment.ts sets it once, in writeConfirmed", () => {
    const text = src("month-payment.ts");
    expect(paidAtWrites(text)).toEqual(["now"]);
    const body = text.slice(text.indexOf("async function writeConfirmed("), text.indexOf("/** The collector confirms one regular's payment"));
    expect(body).toContain("paidAt: now");
    // And the one function that reaches it from a reply asks who is asking first.
    expect(text.slice(text.indexOf("export async function handleCollectorPaidReply"))).toContain("mayConfirmPayments");
    expect(text.slice(text.indexOf("export async function confirmMonthPaid"), text.indexOf("export async function unconfirmMonthPaid"))).toContain("mayConfirmPayments");
  });

  it("the sign-up, the pasted list and the copy never set it", () => {
    for (const file of ["month-signup.ts", "month-signup-rules.ts", "month-payment-rules.ts", "month-payment-copy.ts", "monthly-paste.ts"]) {
      expect(paidAtWrites(src(file)), file).toEqual([]);
    }
  });
});
