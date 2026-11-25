/**
 * The month's price question (`priceAsk`, reached through
 * `sweepMonthPayments` on every 30 s due-posts poll) claims its once-only
 * key by READING first (Disk IO, 2026-11-25). An INSERT that fails on the
 * unique key still writes WAL, and on Supabase any WAL in a two-minute
 * window forces a 16 MB WAL segment to disk, so an already-asked month must
 * not try the insert again on every poll.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  claimed: new Set<string>(),
  create: vi.fn(),
  notices: [] as unknown[],
}));

vi.mock("../db", () => ({
  db: {
    organisation: {
      findUnique: async () => ({
        squadMode: "monthly",
        approvalStatus: "approved",
        setupStage: "live",
        dormantAt: null,
        billingStatus: "exempt",
        billingPlan: "standard",
        billingPricePence: null,
        paymentHolderId: null,
        paymentTrackingEnabled: true,
        paymentCollectionEnabled: false,
      }),
    },
    sentNotification: {
      findUnique: async ({ where }: { where: { key: string } }) => (h.claimed.has(where.key) ? { id: "x" } : null),
      create: async (a: { data: { key: string } }) => {
        h.create(a);
        if (h.claimed.has(a.data.key)) throw Object.assign(new Error("unique"), { code: "P2002" });
        h.claimed.add(a.data.key);
        return a.data;
      },
    },
  },
}));
vi.mock("../admin-channel", () => ({
  sendAdminNotice: async (a: unknown) => {
    h.notices.push(a);
    return { channel: "dm", queued: 1 };
  },
}));

const { sweepMonthPayments } = await import("../month-payment");

const NOW = new Date("2026-11-25T10:00:00Z");
const month = {
  id: "mon1",
  orgId: "org1",
  activityId: "act1",
  activityName: "Wed 7s",
  monthStart: "2026-12-01",
  monthNumber: 12,
  status: "open",
  open: true,
  listOpenedAt: new Date("2026-11-20T10:00:00Z"),
  kickoffs: [new Date("2026-12-02T19:00:00Z")],
  startedMidMonth: false,
  firstKickoff: new Date("2026-12-02T19:00:00Z"),
  endsAt: null,
  maxRegulars: 14,
  fixture: {},
  matches: [],
  members: [],
  sharePerGamePence: null,
  concessionPerGamePence: null,
  venueCostPence: null,
  payByAt: null,
  pricedAt: null,
  summarySentAt: null,
  carriedFrom: null,
  language: "en",
};

beforeEach(() => {
  h.claimed.clear();
  h.create.mockClear();
  h.notices.length = 0;
});

describe("priceAsk's claim", () => {
  it("asks once, then every later poll reads the key and never tries the insert", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sweepMonthPayments("org1", NOW, [month as any]);
    expect(h.notices).toHaveLength(1);
    expect(h.create).toHaveBeenCalledTimes(1);
    for (let i = 1; i <= 5; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await sweepMonthPayments("org1", new Date(NOW.getTime() + i * 30_000), [month as any]);
    }
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.notices).toHaveLength(1);
  });
});
