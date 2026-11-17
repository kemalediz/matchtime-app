/**
 * "@Match Time help availability" and "help teams" in a club with NO SQUAD
 * LIMIT (2026-11-17, open-squad.ts): everyone who says In plays, no bench,
 * no number a side, and MatchTime asks for players only below the minimum.
 * An organiser also hears how to put a limit back by tagging. No database,
 * no model.
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
const OPEN: HelpFeatures = { ...BASE, openSquad: true };
const DASH = /[–—]/;

describe("help availability, no squad limit", () => {
  it("weekly: everyone who says In plays, no bench, and the chase is below the minimum only", () => {
    const text = buildHelpReply("availability", OPEN, "en");
    expect(text).toContain("There's no squad limit and no bench: everyone who says *In* plays.");
    expect(text).toContain("I only ask for more players while there are fewer than the minimum to play.");
    expect(text).not.toContain("extra players go on the *bench*");
    expect(text).not.toMatch(DASH);
  });

  it("monthly (the Vets): the month's regulars, then pay as you go plays by saying In", () => {
    const text = buildHelpReply("availability", { ...OPEN, monthly: true }, "en");
    expect(text).toContain("This group plays as a monthly squad.");
    expect(text).toContain("Pay as you go? Say *In* to play that game");
    expect(text).not.toContain("take an open place");
  });

  it("Turkish", () => {
    const text = buildHelpReply("availability", OPEN, "tr");
    expect(text).toContain("Kadro sınırı ve yedek yok: *varım* yazan herkes oynar.");
    expect(text).not.toMatch(DASH);
  });

  it("an organiser hears how to put a limit back by tagging", () => {
    const text = buildHelpReply("availability", OPEN, "en", { audience: "admin" });
    expect(text).toContain("*@Match Time put the limit and the bench back*");
  });
});

describe("help teams, no squad limit", () => {
  it("the teams are whoever is in, split evenly, in both languages", () => {
    expect(buildHelpReply("teams", OPEN, "en")).toContain("the teams are whoever is in, split into two even sides (15 players is 8 against 7).");
    expect(buildHelpReply("teams", OPEN, "tr")).toContain("takımlar gelenler arasında iki eşit tarafa bölünür (15 oyuncu 8'e 7).");
  });
});

describe("helpFeaturesFrom", () => {
  it("carries the club's open squad; absent is off", () => {
    const f = { ...BASE, listAnnouncer: null, benchPickMode: null, squadMode: "monthly" };
    expect(helpFeaturesFrom({ ...f, openSquad: true }).openSquad).toBe(true);
    expect(helpFeaturesFrom(f).openSquad).toBeUndefined();
  });
});
