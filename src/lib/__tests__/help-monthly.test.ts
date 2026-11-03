/**
 * "help availability" in a club on "monthly" (Vets sandbox, 2026-11-03,
 * scenario D). The 4th live run answered "@Match Time what happens if 14
 * don't confirm?" with the weekly explainer: "Just say *In* or *Out* ... for
 * the next game ... I keep a live, numbered squad list". In a monthly club
 * the regulars on the month's list are in every game without a word, and
 * only a pay as you go player says IN, for an open place. No database, no
 * model.
 */
import { describe, expect, it } from "vitest";
import { buildHelpReply, helpFeaturesFrom, type HelpFeatures } from "@/lib/onboarding-conversation";

const BASE: HelpFeatures = {
  attendance: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  statsQa: true,
  reminders: true,
  bench: true,
  paymentTracking: false,
  paymentCollection: false,
};
const MONTHLY: HelpFeatures = { ...BASE, monthly: true };
const DASH = /[–—]/;

describe("help availability for a monthly club", () => {
  it("says the month's regulars are in every game and pay as you go players say IN for an open place", () => {
    const text = buildHelpReply("availability", MONTHLY, "en");
    expect(text).toContain("⚽ *Squad & availability: how it works*");
    expect(text).toContain("This group plays as a monthly squad.");
    expect(text).toContain("Paid for the month? You're on the month's list and in every game, no need to say anything.");
    expect(text).toContain("Pay as you go? Say *In* to take an open place, and you pay for that game only.");
    expect(text).not.toContain("Just say *In* or *Out* in the group to mark yourself for the next game");
    expect(text).not.toContain("live, numbered squad list");
    // The friend line and the status still follow, as for every club.
    expect(text).toContain("Bringing a friend?");
    expect(text).toContain("✅ It's on for this club.");
    expect(text).not.toMatch(DASH);
  });

  it("in Turkish", () => {
    const text = buildHelpReply("availability", MONTHLY, "tr");
    expect(text).toContain("Bu grup aylık kadroyla oynuyor.");
    expect(text).toContain("*varım*");
    expect(text).not.toContain("Bir sonraki maç için grupta *varım* veya *yokum* yazmanız yeter");
    expect(text).not.toMatch(DASH);
  });

  it("an organiser hears the same, with his own add and the settings link", () => {
    const text = buildHelpReply("availability", MONTHLY, "en", { audience: "admin", links: { topic: "https://x/t" } });
    expect(text).toContain("This group plays as a monthly squad.");
    expect(text).toContain("When an organiser adds someone, they go straight on the list.");
  });

  it("an organiser is told how to add a regular in the middle of the month, in English and Turkish (2026-11-03)", () => {
    const en = buildHelpReply("availability", MONTHLY, "en", { audience: "admin", links: { topic: "https://x/t" } });
    expect(en).toContain("*Adding a regular mid-month:*");
    expect(en).toContain("@Match Time add Tom to the November list, he's paid");
    const tr = buildHelpReply("availability", MONTHLY, "tr", { audience: "admin", links: { topic: "https://x/t" } });
    expect(tr).toContain("*Ay ortasında düzenli oyuncu eklemek:*");
    expect(tr).toContain("Tom'u Kasım listesine ekle, ödedi");
    expect(`${en}${tr}`).not.toMatch(DASH);
    // A player is not told how to do it.
    expect(buildHelpReply("availability", MONTHLY, "en")).not.toContain("Adding a regular mid-month");
  });

  it("REGRESSION GUARD: a weekly club keeps the weekly explainer", () => {
    expect(buildHelpReply("availability", BASE, "en")).toContain("Just say *In* or *Out* in the group to mark yourself for the next game");
  });

  it("helpFeaturesFrom reads the club's squad mode", () => {
    const f = { attendance: true, teamBalancing: true, momVoting: true, playerRating: true, statsQa: true, reminders: true, bench: true, paymentTracking: false, paymentCollection: false };
    expect(helpFeaturesFrom({ ...f, squadMode: "monthly" }).monthly).toBe(true);
    expect(helpFeaturesFrom({ ...f, squadMode: "weekly" }).monthly).toBe(false);
    expect(helpFeaturesFrom(f).monthly).toBe(false);
  });
});
