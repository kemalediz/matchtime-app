/**
 * A queued pay link goes out only to someone who still owes AT SEND TIME
 * (Sutton, Tue 17 Nov 2026). The collector confirmed the fee at 23:01 UTC,
 * inside the club's quiet hours, so `releaseMatchPayments` queued 13 pay-link
 * DMs for 09:00. Between 23:13 and 23:40 he marked 8 of those players paid
 * on /collect ("Mark received"). Nothing looked again at 09:00, so all 8 got
 * "match fee ... £10.15, tap to pay" and one replied "I just paid".
 *
 * The rule (`payLinkNotOwedReason`) and the send-time check
 * (`payLinkJobVerdicts`) are pinned here; the scenario end to end runs
 * through the real `computeDuePosts` in pay-link-send-time-scheduler.test.ts.
 * db is mocked; nothing is sent; no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: {
    attendance: { findMany: vi.fn() },
    match: { findMany: vi.fn() },
    botJob: { deleteMany: vi.fn() },
  },
}));
vi.mock("../db", () => ({ db: h.db }));

import { payLinkAboutKey, parsePayLinkAboutKey, payLinkNotOwedReason } from "../pay-link-job-rules";
import { payLinkJobVerdicts } from "../pay-link-job";

const RELEASED = new Date("2026-11-17T23:01:02Z");

const owing = {
  status: "CONFIRMED",
  paidAt: null as Date | null,
  feeWaivedAt: null as Date | null,
  directPendingAt: null as Date | null,
  paymentMethod: null as string | null,
};
const liveMatch = { status: "TEAMS_PUBLISHED", feePerPlayer: 10.15, paymentLinksReleasedAt: RELEASED, collectorId: "col" };

describe("the about key a pay link is queued with", () => {
  it("names the match and the player, and reads back", () => {
    const key = payLinkAboutKey("m1", "u1");
    expect(key).toBe("m1:pay-link:u1");
    expect(parsePayLinkAboutKey(key)).toEqual({ matchId: "m1", userId: "u1" });
  });
  it("any other about key is not a pay link", () => {
    expect(parsePayLinkAboutKey(null)).toBeNull();
    expect(parsePayLinkAboutKey("m1:fee-confirm")).toBeNull();
    expect(parsePayLinkAboutKey("m1:format-list")).toBeNull();
    expect(parsePayLinkAboutKey("m1:pay-link:")).toBeNull();
    expect(parsePayLinkAboutKey(":pay-link:u1")).toBeNull();
  });
});

describe("payLinkNotOwedReason: does this player still owe for this match, now", () => {
  const userId = "u1";
  it("a confirmed, unpaid player on a live fee still owes", () => {
    expect(payLinkNotOwedReason({ userId, attendance: owing, match: liveMatch })).toBeNull();
  });
  it("marked paid on /collect (or paid by card) since the link was queued", () => {
    expect(payLinkNotOwedReason({ userId, attendance: { ...owing, paidAt: new Date() }, match: liveMatch })).toBe("paid");
  });
  it("given a free place", () => {
    expect(payLinkNotOwedReason({ userId, attendance: { ...owing, feeWaivedAt: new Date() }, match: liveMatch })).toBe("fee-waived");
  });
  it("said they are paying the collector directly", () => {
    expect(payLinkNotOwedReason({ userId, attendance: { ...owing, directPendingAt: new Date() }, match: liveMatch })).toBe(
      "direct-pending",
    );
  });
  it("dropped out, moved to the bench, or no longer in the squad at all", () => {
    expect(payLinkNotOwedReason({ userId, attendance: { ...owing, status: "DROPPED" }, match: liveMatch })).toBe("not-confirmed");
    expect(payLinkNotOwedReason({ userId, attendance: { ...owing, status: "BENCH" }, match: liveMatch })).toBe("not-confirmed");
    expect(payLinkNotOwedReason({ userId, attendance: null, match: liveMatch })).toBe("not-confirmed");
  });
  it("a monthly regular's place is paid for by the month", () => {
    expect(payLinkNotOwedReason({ userId, attendance: { ...owing, paymentMethod: "monthly" }, match: liveMatch })).toBe("monthly");
  });
  it("the collector never pays himself", () => {
    expect(payLinkNotOwedReason({ userId: "col", attendance: owing, match: liveMatch })).toBe("collector");
  });
  it("the fee was cancelled or the links withdrawn", () => {
    expect(payLinkNotOwedReason({ userId, attendance: owing, match: { ...liveMatch, feePerPlayer: null } })).toBe("no-fee");
    expect(payLinkNotOwedReason({ userId, attendance: owing, match: { ...liveMatch, paymentLinksReleasedAt: null } })).toBe("no-fee");
    expect(payLinkNotOwedReason({ userId, attendance: owing, match: null })).toBe("no-fee");
  });
  it("the match was cancelled", () => {
    expect(payLinkNotOwedReason({ userId, attendance: owing, match: { ...liveMatch, status: "CANCELLED" } })).toBe("match-cancelled");
  });
  it("paid wins over every other reason", () => {
    expect(
      payLinkNotOwedReason({
        userId,
        attendance: { ...owing, paidAt: new Date(), feeWaivedAt: new Date(), status: "DROPPED" },
        match: liveMatch,
      }),
    ).toBe("paid");
  });
});

describe("payLinkJobVerdicts: the send-time check on queued jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.db.match.findMany.mockResolvedValue([
      {
        id: "m1",
        status: "TEAMS_PUBLISHED",
        feePerPlayer: 10.15,
        paymentLinksReleasedAt: RELEASED,
        activity: { org: { paymentHolderId: "col" } },
      },
    ]);
    h.db.attendance.findMany.mockResolvedValue([
      { matchId: "m1", userId: "wasim", ...owing, paidAt: new Date("2026-11-17T23:13:13Z") },
      { matchId: "m1", userId: "ali", ...owing },
    ]);
    h.db.botJob.deleteMany.mockResolvedValue({ count: 1 });
  });

  const jobs = [
    { id: "j-wasim", aboutKey: payLinkAboutKey("m1", "wasim") },
    { id: "j-ali", aboutKey: payLinkAboutKey("m1", "ali") },
    { id: "j-other", aboutKey: null },
    { id: "j-list", aboutKey: "m1:format-list" },
  ];

  it("drops the paid player's queued link (deletes the unsent job) and sends the unpaid one", async () => {
    const v = await payLinkJobVerdicts(jobs);
    expect(v.get("j-wasim")).toBe("drop");
    expect(v.get("j-ali")).toBe("send");
    // Only pay-link jobs get a verdict; everything else is untouched.
    expect(v.has("j-other")).toBe(false);
    expect(v.has("j-list")).toBe(false);
    expect(h.db.botJob.deleteMany).toHaveBeenCalledTimes(1);
    expect(h.db.botJob.deleteMany).toHaveBeenCalledWith({ where: { id: "j-wasim", sentAt: null } });
  });

  it("one read for the matches and one for the attendances, whatever the number of jobs", async () => {
    await payLinkJobVerdicts(jobs);
    expect(h.db.match.findMany).toHaveBeenCalledTimes(1);
    expect(h.db.attendance.findMany).toHaveBeenCalledTimes(1);
  });

  it("a player with no attendance row any more is not sent the link", async () => {
    const v = await payLinkJobVerdicts([{ id: "j-gone", aboutKey: payLinkAboutKey("m1", "gone") }]);
    expect(v.get("j-gone")).toBe("drop");
  });

  it("no pay-link job: no reads at all", async () => {
    const v = await payLinkJobVerdicts([{ id: "x", aboutKey: null }]);
    expect(v.size).toBe(0);
    expect(h.db.match.findMany).not.toHaveBeenCalled();
    expect(h.db.attendance.findMany).not.toHaveBeenCalled();
  });

  it("a failed read holds every pay link for this poll: it stays queued, nothing is sent, nothing deleted", async () => {
    h.db.attendance.findMany.mockRejectedValue(new Error("db down"));
    const v = await payLinkJobVerdicts(jobs);
    expect(v.get("j-wasim")).toBe("hold");
    expect(v.get("j-ali")).toBe("hold");
    expect(h.db.botJob.deleteMany).not.toHaveBeenCalled();
  });

  it("a failed delete still never sends the link (held, tried again next poll)", async () => {
    h.db.botJob.deleteMany.mockRejectedValue(new Error("db down"));
    const v = await payLinkJobVerdicts(jobs);
    expect(v.get("j-wasim")).toBe("hold");
    expect(v.get("j-ali")).toBe("send");
  });
});
