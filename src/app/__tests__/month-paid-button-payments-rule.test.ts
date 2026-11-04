/**
 * THE MONTH PAGE'S "I'VE PAID" FOLLOWS THE ONE PAYMENTS RULE (club summary,
 * slice B3; decision K2, Kemal 2026-11-04).
 *
 * Before B3 `/month` offered "I've paid" whatever the club's payment flags
 * said (`canClaim` read only the amount, plan D3), and `sayMonthPaid`
 * recorded the claim. Now both follow `paymentMessagesOn` (tracking OR
 * collection): with both flags off there is no button and the action
 * records nothing; with either on, both work as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { orgRow } from "@/lib/club-summary/__tests__/fixtures";

const state: { org: Record<string, unknown>; claims: number } = { org: {}, claims: 0 };

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u-regular" } }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
  useRouter: () => ({ refresh() {}, push() {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/org", () => ({
  getUserOrg: async () => ({ orgId: state.org.id, org: state.org }),
}));
vi.mock("@/lib/db", () => ({
  db: {
    membership: { findMany: async () => [], findFirst: async () => null },
    user: { findUnique: async () => ({ name: "Davide Collector" }) },
    squadMonth: { findUnique: async () => ({ org: state.org }) },
  },
}));
const KICKOFF = new Date("2026-12-07T20:00:00.000Z");
vi.mock("@/lib/month-signup", async (orig) => ({
  ...(await orig<typeof import("@/lib/month-signup")>()),
  loadLiveMonths: async () => [
    {
      id: "sm-dec",
      orgId: state.org.id,
      open: true,
      kickoffs: [KICKOFF],
      firstKickoff: KICKOFF,
      startedMidMonth: false,
      matches: [],
      payByAt: null,
      members: [
        { userId: "u-regular", kind: "regular", out: false, waiting: false, slot: 1, paid: "none", amountDuePence: 3000, creditsApplied: 0, gamesCovered: 4, gamesCommitted: null, paygMatchIds: [] },
      ],
    },
  ],
}));
vi.mock("@/lib/month-close", () => ({ loadMonthMoney: async () => ({}), loadAwayView: async () => null }));
vi.mock("@/lib/month-payment", async (orig) => ({
  ...(await orig<typeof import("@/lib/month-payment")>()),
  mayConfirmPayments: async () => false,
  claimMonthPaid: async () => {
    state.claims += 1;
    return true;
  },
}));

import MonthPage from "@/app/month/page";
import { sayMonthPaid } from "@/app/actions/month-payment";

const VETS = (over: Record<string, unknown>) => ({
  ...orgRow({ id: "org-vets", name: "Vets MNF", squadMode: "monthly", paymentHolderId: "u-davide", ...over }),
  language: "en",
});

async function page(): Promise<string> {
  return renderToStaticMarkup((await MonthPage({ searchParams: Promise.resolve({}) })) as ReactElement);
}

beforeEach(() => {
  state.claims = 0;
});

describe("/month: 'I've paid'", () => {
  it("both flags off (the Vets): no button, and the action records nothing", async () => {
    state.org = VETS({ paymentTrackingEnabled: false, paymentCollectionEnabled: false });
    const html = await page();
    expect(html).toContain("month-page");
    expect(html).not.toContain('data-testid="month-paid"');
    expect(await sayMonthPaid("sm-dec")).toEqual({ ok: false });
    expect(state.claims).toBe(0);
  });

  it("tracking only, or collection only: the button, and the claim is recorded", async () => {
    for (const flags of [
      { paymentTrackingEnabled: true, paymentCollectionEnabled: false },
      { paymentTrackingEnabled: false, paymentCollectionEnabled: true },
    ]) {
      state.org = VETS(flags);
      state.claims = 0;
      expect(await page()).toContain('data-testid="month-paid"');
      expect(await sayMonthPaid("sm-dec")).toEqual({ ok: true });
      expect(state.claims).toBe(1);
    }
  });
});
