/**
 * Monthly squad, slice 5 (plan 5.6): a regular's place is paid for by the
 * month, so the per-match payment paths never reach them, and a weekly
 * club's paths are what they always were.
 *
 * Here: the pay links (`releaseMatchPayments`) and the marker itself. The
 * daily chase, the payment poll and the fee question are pinned through
 * the real scheduler in `monthly-week-scheduler.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const botJobs: Array<{ phone: string; text: string }> = [];
let matchRow: Record<string, unknown> | null = null;
const matchUpdate = vi.fn(async () => ({}));

vi.mock("../db", () => ({
  db: {
    match: {
      findUnique: async () => matchRow,
      update: (...a: unknown[]) => matchUpdate(...(a as [])),
    },
    botJob: {
      create: async ({ data }: { data: { phone: string; text: string } }) => {
        botJobs.push(data);
        return data;
      },
    },
  },
}));
vi.mock("../short-link", () => ({ buildShortMagicLinkUrl: async () => "https://mt.test/l/pay" }));
vi.mock("../magic-link", () => ({ signMagicLinkToken: () => "token", MAGIC_LINK_TTL: { bookmark: 1, actionNudge: 1 } }));

import { releaseMatchPayments } from "../payment-flow";
import { MONTHLY_PAYMENT_METHOD, isMonthlyRow } from "../monthly-week";

function att(id: string, paymentMethod: string | null) {
  return { userId: id, status: "CONFIRMED", paymentMethod, user: { id, name: id, phoneNumber: `+44770090${id.length}${id.charCodeAt(0)}` } };
}

function match(attendances: ReturnType<typeof att>[]) {
  return {
    id: "m1",
    feePerPlayer: 8,
    activity: { name: "Monday 7-a-side", orgId: "org", org: { paymentHolderId: "sam", language: "en" } },
    attendances,
  };
}

beforeEach(() => {
  botJobs.length = 0;
  matchUpdate.mockClear();
});

describe("releaseMatchPayments", () => {
  it("MONTHLY: a regular never gets a pay link; the PAYG player does; the collector never does", async () => {
    matchRow = match([att("alex", "monthly"), att("bilal", "monthly"), att("omar", null), att("sam", "monthly")]);
    expect(await releaseMatchPayments("m1")).toBe(1);
    expect(botJobs).toHaveLength(1);
    expect(botJobs[0].phone).toBe(att("omar", null).user.phoneNumber.replace(/^\+/, ""));
    expect(matchUpdate).toHaveBeenCalledTimes(1);
  });

  it("WEEKLY: everyone but the collector gets a link, as before", async () => {
    matchRow = match([att("alex", null), att("bilal", "card"), att("omar", "direct"), att("sam", null)]);
    expect(await releaseMatchPayments("m1")).toBe(3);
    expect(botJobs).toHaveLength(3);
  });
});

describe("the marker", () => {
  it("is exactly 'monthly', and nothing a weekly row carries matches it", () => {
    expect(MONTHLY_PAYMENT_METHOD).toBe("monthly");
    expect(isMonthlyRow({ paymentMethod: "monthly" })).toBe(true);
    for (const pm of [null, undefined, "card", "direct", "pay_by_bank", "Monthly", ""]) {
      expect(isMonthlyRow({ paymentMethod: pm })).toBe(false);
    }
  });
});
