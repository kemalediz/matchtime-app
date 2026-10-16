/**
 * The pay link `releaseMatchPayments` queues names only the club's
 * available methods, and the collector by name (FNF, 2026-10-16: the
 * 22:45 links promised bank, card and Apple Pay to a direct-only club).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const botJobs: Array<{ phone: string; text: string }> = [];
let matchRow: Record<string, unknown> | null = null;
const users: Record<string, { name: string | null }> = {};

vi.mock("../db", () => ({
  db: {
    match: {
      findUnique: async () => matchRow,
      update: async () => ({}),
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => users[where.id] ?? null,
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

const FNF_SWITCHES = { payMethodPayByBank: false, payMethodCard: false, payMethodDirect: true, stripeChargesEnabled: false };
const LIVE_SWITCHES = { payMethodPayByBank: true, payMethodCard: true, payMethodDirect: true, stripeChargesEnabled: true };

function att(id: string, name: string, phone: string) {
  return { userId: id, status: "CONFIRMED", paymentMethod: null, paidAt: null, user: { id, name, phoneNumber: phone } };
}

function match(org: Record<string, unknown>, attendances: ReturnType<typeof att>[]) {
  return {
    id: "m1",
    feePerPlayer: 8,
    activity: { name: "Friday Night Football", orgId: "org", org: { paymentHolderId: "col", ...org } },
    attendances,
  };
}

beforeEach(() => {
  botJobs.length = 0;
  for (const k of Object.keys(users)) delete users[k];
});

describe("releaseMatchPayments writes the pay link from the club's available methods", () => {
  it("FNF (direct only, collector not in the squad): names Raihan, no card or bank", async () => {
    users.col = { name: "Raihan Ahmed" };
    matchRow = match({ language: "en", ...FNF_SWITCHES }, [att("ali", "Ali Khan", "+447700900001")]);
    expect(await releaseMatchPayments("m1")).toBe(1);
    expect(botJobs[0].text).toContain("Pay Raihan directly, by cash or transfer.");
    expect(botJobs[0].text).not.toMatch(/card|bank|Apple|organiser/i);
  });

  it("FNF in Turkish", async () => {
    users.col = { name: "Raihan Ahmed" };
    matchRow = match({ language: "tr", ...FNF_SWITCHES }, [att("ali", "Ali Khan", "+447700900001")]);
    await releaseMatchPayments("m1");
    expect(botJobs[0].text).toContain("Ödemeyi doğrudan Raihan ile, nakit ya da havaleyle hallediyorsun.");
    expect(botJobs[0].text).not.toMatch(/kart|banka|Apple/i);
  });

  it("everything live, collector in the squad: all three, named from the squad row", async () => {
    matchRow = match({ language: "en", ...LIVE_SWITCHES }, [
      att("ali", "Ali Khan", "+447700900001"),
      att("col", "Elvin Aliyev", "+447700900002"),
    ]);
    expect(await releaseMatchPayments("m1")).toBe(1);
    expect(botJobs[0].text).toContain("Tap to pay (bank, card, Apple or Google Pay, or pay Elvin directly):");
  });

  it("card and bank on but Stripe not connected: direct only", async () => {
    users.col = { name: "Raihan Ahmed" };
    matchRow = match({ language: "en", ...LIVE_SWITCHES, stripeChargesEnabled: false }, [
      att("ali", "Ali Khan", "+447700900001"),
    ]);
    await releaseMatchPayments("m1");
    expect(botJobs[0].text).toContain("Pay Raihan directly, by cash or transfer.");
    expect(botJobs[0].text).not.toMatch(/card|bank/i);
  });
});
