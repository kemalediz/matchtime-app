/**
 * Payments in a MONTHLY club that tracks payments but takes no card
 * payments (round 2 of the review of #605). Its month's payments are live:
 * the priced list, players saying they paid, the collector's PAID ALL and
 * the reminders (month-payment.ts, gated on `paymentMessagesOn`; the HQ
 * `paid` gate is `monthly && paymentMessagesOn`). Yet the help called the
 * topic off: the admin group's menu said "payments ... (off here)" while
 * "help payments" gave the PAID ALL lines. Payments is now ON for such a
 * club, and its explainer describes the month's payments (bank transfer to
 * the collector, no pay link), never the card links it does not have.
 */
import { describe, expect, it } from "vitest";
import { buildHelpReply, helpTopicsOff, type HelpFeatures } from "@/lib/onboarding-conversation";
import { buildHqHelp, hqHelpTopicReply } from "@/lib/admin-group-help";
import type { OrgFeatures } from "@/lib/org-features";

const BASE: HelpFeatures = {
  attendance: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  statsQa: true,
  reminders: true,
  bench: true,
  paymentTracking: true,
  paymentCollection: false,
  monthly: true,
};
const WEEKLY_TRACKING_ONLY: HelpFeatures = { ...BASE, monthly: false };
const MONTHLY_NOTHING: HelpFeatures = { ...BASE, paymentTracking: false };
const HQ_GATES = { squad: false, graphics: true, picks: false, paid: true, free: true, pool: false };

describe("a monthly club that tracks payments, no card payments", () => {
  it("payments is on: no '(off here)' in the admin group's menu, listed for players", () => {
    expect(helpTopicsOff(BASE)).not.toContain("payments");
    const menu = buildHqHelp({ lang: "en", ...HQ_GATES, features: BASE });
    expect(menu).toMatch(/\*payments\*: [^\n]*\n/);
    expect(menu).not.toMatch(/\*payments\*: [^\n]*\(off here\)/);
    expect(buildHelpReply(null, BASE, "en", { audience: "group" })).toContain("💷 *payments*: paying the match fee");
  });

  it("'help payments' explains the month's payments, says it is on, and names no card link", () => {
    for (const audience of ["group", "admin"] as const) {
      const r = buildHelpReply("payments", BASE, "en", { audience });
      expect(r).toContain("*Paying for the month: how it works*");
      expect(r).toContain("bank transfer");
      expect(r).not.toMatch(/isn't switched on/);
      expect(r).not.toMatch(/card|Pay by Bank/i);
      expect(r).toMatch(/It's on for (this|your) club/);
    }
  });

  it("Turkish", () => {
    const r = buildHelpReply("payments", BASE, "tr", { audience: "group" });
    expect(r).toContain("*Aylık ödeme nasıl çalışır*");
    expect(r).toContain("banka havalesi");
    expect(r).not.toMatch(/[—–]/);
  });

  it("the admin group's 'help payments': the PAID lines, then the month's explainer as on", async () => {
    const features = { ...BASE, botEnabled: true, language: "en", benchPickMode: "first-come", squadMode: "monthly" } as unknown as OrgFeatures;
    const reply = await hqHelpTopicReply({
      orgId: "org-vets",
      lang: "en",
      gates: HQ_GATES,
      req: { topic: "payments" },
      features,
      club: { pool: { open: false, platformOpen: false, clubFlag: false }, partners: { active: 0 } },
    });
    expect(reply).toContain("PAID ALL");
    expect(reply).toContain("*Paying for the month: how it works*");
    expect(reply).not.toMatch(/isn't switched on/);
  });
});

describe("unchanged elsewhere", () => {
  it("a weekly club with only payment tracking: still off (the old payment poll is hidden)", () => {
    expect(helpTopicsOff(WEEKLY_TRACKING_ONLY)).toContain("payments");
    expect(buildHelpReply("payments", WEEKLY_TRACKING_ONLY, "en", { audience: "admin" })).toMatch(/isn't switched on/);
  });

  it("a monthly club with no payments at all: off", () => {
    expect(helpTopicsOff(MONTHLY_NOTHING)).toContain("payments");
  });

  it("card collection on: the match-fee explainer as before", () => {
    const r = buildHelpReply("payments", { ...BASE, paymentCollection: true }, "en", { audience: "group" });
    expect(r).toContain("*Match fees: how it works*");
  });
});
