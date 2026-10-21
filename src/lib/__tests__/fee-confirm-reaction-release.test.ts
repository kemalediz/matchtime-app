/**
 * `confirmCollectorFeeByReaction`: the ✅ reaction's release goes through
 * the SAME compare-and-set the typed "yes" uses, and the same ack.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const orgFindMany = vi.fn();
const matchFindFirst = vi.fn();
const matchUpdateMany = vi.fn();
const matchFindUnique = vi.fn();
const botJobs: Array<{ phone: string; text: string }> = [];

vi.mock("../db", () => ({
  db: {
    organisation: { findMany: (...a: unknown[]) => orgFindMany(...a) },
    match: {
      findFirst: (...a: unknown[]) => matchFindFirst(...a),
      updateMany: (...a: unknown[]) => matchUpdateMany(...a),
      findUnique: (...a: unknown[]) => matchFindUnique(...a),
      update: async () => ({}),
    },
    user: { findUnique: async () => ({ name: "Kemal Ediz" }) },
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

import { confirmCollectorFeeByReaction } from "../payment-flow";
import { buildFeeReleasedAck } from "../dm-copy";
import { dayLabel } from "../i18n/dates";

const SWITCHES = { payMethodPayByBank: false, payMethodCard: true, payMethodDirect: true, stripeChargesEnabled: true };
const DATE = new Date("2026-10-20T20:30:00Z");
const PENDING = {
  id: "m1",
  date: DATE,
  feePendingConfirm: 10.15,
  feePerPlayer: null,
  activity: { name: "Tuesday 7-a-side", orgId: "org", org: { language: "en", ...SWITCHES } },
};

beforeEach(() => {
  vi.clearAllMocks();
  botJobs.length = 0;
  orgFindMany.mockResolvedValue([{ id: "org" }]);
  matchFindFirst.mockResolvedValue(PENDING);
  matchUpdateMany.mockResolvedValue({ count: 1 });
  matchFindUnique.mockResolvedValue({
    id: "m1",
    feePerPlayer: 10.15,
    activity: { name: "Tuesday 7-a-side", orgId: "org", org: { paymentHolderId: "kemal", language: "en", ...SWITCHES } },
    attendances: [
      { userId: "ali", status: "CONFIRMED", paymentMethod: null, paidAt: null, user: { id: "ali", name: "Ali", phoneNumber: "+447700900001" } },
    ],
  });
});

describe("confirmCollectorFeeByReaction", () => {
  it("claims the match with the typed yes's compare-and-set, releases, and returns the typed yes's ack", async () => {
    const res = await confirmCollectorFeeByReaction("kemal", "m1");
    // Scoped to the clubs this user collects for, and to THIS match.
    expect(orgFindMany.mock.calls[0][0].where).toEqual({ paymentHolderId: "kemal", paymentCollectionEnabled: true });
    expect(matchFindFirst.mock.calls[0][0].where).toMatchObject({ id: "m1", paymentLinksReleasedAt: null });
    // Compare-and-set: only while the links have not gone out.
    expect(matchUpdateMany).toHaveBeenCalledTimes(1);
    expect(matchUpdateMany.mock.calls[0][0].where).toEqual({ id: "m1", paymentLinksReleasedAt: null });
    expect(matchUpdateMany.mock.calls[0][0].data).toMatchObject({
      feePerPlayer: 10.15,
      feePendingConfirm: null,
      feeSetByUserId: "kemal",
    });
    expect(botJobs).toHaveLength(1);
    expect(res).toEqual({
      matchId: "m1",
      orgId: "org",
      released: 1,
      reply: buildFeeReleasedAck({
        released: 1,
        fee: 10.15,
        matchName: "Tuesday 7-a-side",
        matchWhen: dayLabel("en", DATE),
        methods: ["card", "direct"],
        lang: "en",
      }),
    });
  });

  it("nothing pending: null, nothing claimed", async () => {
    matchFindFirst.mockResolvedValue({ ...PENDING, feePendingConfirm: null });
    expect(await confirmCollectorFeeByReaction("kemal", "m1")).toBeNull();
    expect(matchUpdateMany).not.toHaveBeenCalled();
    expect(botJobs).toHaveLength(0);
  });

  it("already released by another yes (claim lost): null, no links, no ack", async () => {
    matchUpdateMany.mockResolvedValue({ count: 0 });
    expect(await confirmCollectorFeeByReaction("kemal", "m1")).toBeNull();
    expect(botJobs).toHaveLength(0);
  });

  it("not a match this user collects for: null", async () => {
    orgFindMany.mockResolvedValue([]);
    expect(await confirmCollectorFeeByReaction("someone", "m1")).toBeNull();
    expect(matchUpdateMany).not.toHaveBeenCalled();
  });

  it("the match is not open for a fee (released, outside the window): null", async () => {
    matchFindFirst.mockResolvedValue(null);
    expect(await confirmCollectorFeeByReaction("kemal", "m1")).toBeNull();
    expect(matchUpdateMany).not.toHaveBeenCalled();
  });
});
