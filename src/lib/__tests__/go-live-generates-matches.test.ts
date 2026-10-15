/**
 * GOING LIVE MAKES THE CLUB'S UPCOMING GAMES AT ONCE (2026-10-15).
 *
 * Club FNF went live at 22:12 London; its games were made only by the
 * 00:00 UTC cron, so the squad list pasted at 22:13 had no game to go on.
 * `goLiveClub` (every door: GO by WhatsApp, the Go live button, the
 * owner's Go live now) now runs the cron's own generator for that club
 * right after the go-live commits. A failure there is logged and never
 * undoes the go-live; a refusal generates nothing.
 *
 * The transaction is mocked to return its outcome: what it does inside is
 * pinned by the e2e go-live specs. No network, no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: { $transaction: vi.fn() },
  generate: vi.fn(),
  cancelSetupDm: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("../generate-upcoming-matches", () => ({ generateUpcomingMatches: h.generate }));
vi.mock("../club-setup-dm-cancel", () => ({ cancelSetupDm: h.cancelSetupDm }));

import { goLiveClub } from "../club-setup";

const NOW = new Date("2026-10-15T21:12:00Z");
const WENT_LIVE = {
  outcome: "went-live",
  orgId: "org-fnf",
  club: "FNF",
  group: "FNF Fridays",
  language: "en",
  liveAt: NOW,
  liveBy: "user:u-org",
  hello: "hello",
  purgedJobs: 0,
  quietedMatches: 0,
  freePeriodStarted: false,
  freePeriodNote: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.cancelSetupDm.mockResolvedValue(undefined);
  h.generate.mockResolvedValue({ created: 1, createdMatchIds: ["m-1"], skippedDormantOrgs: 0, skippedNotApprovedOrgs: 0, skippedBillingPausedOrgs: 0 });
});

describe("goLiveClub: the club's games are made at go-live", () => {
  it("went live: the cron's generator runs for this club, at the go-live instant", async () => {
    h.db.$transaction.mockResolvedValue(WENT_LIVE);
    const r = await goLiveClub("org-fnf", "user:u-org", NOW, { billingEnabled: false, learningEnabled: false });
    expect(r.outcome).toBe("went-live");
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate).toHaveBeenCalledWith({ orgId: "org-fnf", now: NOW });
  });

  it("after the commit, not inside it: the transaction has returned before generation starts", async () => {
    const order: string[] = [];
    h.db.$transaction.mockImplementation(async () => {
      order.push("tx");
      return WENT_LIVE;
    });
    h.generate.mockImplementation(async () => {
      order.push("generate");
      return { created: 0, createdMatchIds: [] };
    });
    await goLiveClub("org-fnf", "user:u-org", NOW, { billingEnabled: false });
    expect(order).toEqual(["tx", "generate"]);
  });

  it("a generation failure is logged and never undoes the go-live", async () => {
    h.db.$transaction.mockResolvedValue(WENT_LIVE);
    h.generate.mockRejectedValue(new Error("connection reset"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await goLiveClub("org-fnf", "user:u-org", NOW, { billingEnabled: false });
    expect(r.outcome).toBe("went-live");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it.each([
    { outcome: "already-live", orgId: "org-fnf", club: "FNF", group: "FNF", language: "en", liveAt: NOW, liveBy: "u" },
    { outcome: "still-reading", orgId: "org-fnf", club: "FNF", group: "FNF", language: "en" },
    { outcome: "removed-from-group", orgId: "org-fnf", club: "FNF", group: "FNF", language: "en" },
    { outcome: "billing-paused", orgId: "org-fnf", club: "FNF", group: "FNF", language: "en" },
    { outcome: "not-setting-up", orgId: "org-fnf" },
  ])("$outcome: nothing is generated", async (result) => {
    h.db.$transaction.mockResolvedValue(result);
    await goLiveClub("org-fnf", "user:u-org", NOW, { billingEnabled: false });
    expect(h.generate).not.toHaveBeenCalled();
  });
});
