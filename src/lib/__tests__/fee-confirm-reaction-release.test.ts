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
// The monthly staging rules (monthly-week.ts) are their own tests; here
// only WHETHER the typed yes's staging step is asked, and with what.
const stagePaygFeeForReply = vi.fn();
vi.mock("../monthly-week", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../monthly-week")>()),
  stagePaygFeeForReply: (...a: unknown[]) => stagePaygFeeForReply(...a),
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
  stagePaygFeeForReply.mockResolvedValue(null);
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
    const res = await confirmCollectorFeeByReaction("kemal", "m1", "m1:fee-confirm");
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
    expect(await confirmCollectorFeeByReaction("kemal", "m1", "m1:fee-confirm")).toBeNull();
    expect(matchUpdateMany).not.toHaveBeenCalled();
    expect(botJobs).toHaveLength(0);
  });

  it("already released by another yes (claim lost): null, no links, no ack", async () => {
    matchUpdateMany.mockResolvedValue({ count: 0 });
    expect(await confirmCollectorFeeByReaction("kemal", "m1", "m1:fee-confirm")).toBeNull();
    expect(botJobs).toHaveLength(0);
  });

  it("not a match this user collects for: null", async () => {
    orgFindMany.mockResolvedValue([]);
    expect(await confirmCollectorFeeByReaction("someone", "m1", "m1:fee-confirm")).toBeNull();
    expect(matchUpdateMany).not.toHaveBeenCalled();
  });

  it("the match is not open for a fee (released, outside the window): null", async () => {
    matchFindFirst.mockResolvedValue(null);
    expect(await confirmCollectorFeeByReaction("kemal", "m1", "m1:fee-confirm")).toBeNull();
    expect(matchUpdateMany).not.toHaveBeenCalled();
  });
});

describe("confirmCollectorFeeByReaction on the monthly PAYG fee question (`<matchId>:fee-ask`)", () => {
  it("scopes the match by the question's own key, like a typed swipe-reply to it", async () => {
    await confirmCollectorFeeByReaction("kemal", "m1", "m1:fee-ask");
    expect(matchFindFirst.mock.calls[0][0].where).toMatchObject({ id: "m1", paymentLinksReleasedAt: null });
  });

  it("an amount already staged (the ack staged the PAYG price): released at it, staging not asked", async () => {
    matchFindFirst.mockResolvedValue({ ...PENDING, feePendingConfirm: 8 });
    const res = await confirmCollectorFeeByReaction("kemal", "m1", "m1:fee-ask");
    expect(stagePaygFeeForReply).not.toHaveBeenCalled();
    expect(matchUpdateMany.mock.calls[0][0].data).toMatchObject({ feePerPlayer: 8, feePendingConfirm: null });
    expect(res?.released).toBe(1);
  });

  it("nothing staged yet: the typed yes's staging step is asked with an explicit yes, and its amount is released", async () => {
    matchFindFirst.mockResolvedValue({ ...PENDING, feePendingConfirm: null, feePerPlayer: null });
    stagePaygFeeForReply.mockResolvedValue(8);
    const res = await confirmCollectorFeeByReaction("kemal", "m1", "m1:fee-ask:again");
    expect(stagePaygFeeForReply).toHaveBeenCalledTimes(1);
    expect(stagePaygFeeForReply).toHaveBeenCalledWith({ matchId: "m1", collectorUserId: "kemal", reply: "yes" });
    expect(matchUpdateMany).toHaveBeenCalledTimes(1);
    expect(matchUpdateMany.mock.calls[0][0].data).toMatchObject({ feePerPlayer: 8, feePendingConfirm: null, feeSetByUserId: "kemal" });
    expect(res?.released).toBe(1);
  });

  it("the staging rules refuse (declined, unsent, too late, another DM since): null, nothing released", async () => {
    matchFindFirst.mockResolvedValue({ ...PENDING, feePendingConfirm: null, feePerPlayer: null });
    stagePaygFeeForReply.mockResolvedValue(null);
    expect(await confirmCollectorFeeByReaction("kemal", "m1", "m1:fee-ask")).toBeNull();
    expect(matchUpdateMany).not.toHaveBeenCalled();
    expect(botJobs).toHaveLength(0);
  });

  it("staging that throws is nothing staged", async () => {
    matchFindFirst.mockResolvedValue({ ...PENDING, feePendingConfirm: null, feePerPlayer: null });
    stagePaygFeeForReply.mockRejectedValue(new Error("db down"));
    expect(await confirmCollectorFeeByReaction("kemal", "m1", "m1:fee-ask")).toBeNull();
    expect(matchUpdateMany).not.toHaveBeenCalled();
  });
});
