/**
 * The venue an organiser types, stored and shown as a NAME (2026-09-30).
 *
 * Kemal's second in-group setup on "MT Test" answered "Friday 8pm on
 * Sutton Goals" and the group read "📅 First match: Friday 20:00 at on
 * Sutton Goals". A leading "at", "on", "in" or "the" is the sentence
 * around the name, not the name.
 */
import { describe, it, expect } from "vitest";
import { cleanVenue, extractVenueFreeText } from "@/lib/onboarding-parse";
import { buildGroupAddCompletionPost, buildLegacyCompletionPost } from "@/lib/onboarding-conversation";

describe("extractVenueFreeText: real phrasings", () => {
  it.each([
    ["Fridays 8pm on Sutton Goals", "Sutton Goals"],
    ["Friday 20:00 at Goals North Cheam", "Goals North Cheam"],
    ["cuma 21:00 Goals'ta", "Goals"],
    ["Tuesdays 9pm at the Powerleague Shoreditch, 7-a-side", "Powerleague Shoreditch"],
    ["Thursdays 9pm in Sim Arena", "Sim Arena"],
  ])("%j → %j", (raw, venue) => {
    expect(extractVenueFreeText(raw)).toBe(venue);
  });
});

describe("cleanVenue", () => {
  it.each([
    ["on Sutton Goals", "Sutton Goals"],
    ["at at Goals", "Goals"],
    ["At the Den", "Den"],
    ["  in   Sim Arena ", "Sim Arena"],
    ["@ Goals Wembley", "Goals Wembley"],
    ["Goals Wembley", "Goals Wembley"],
    ["Onslow Park", "Onslow Park"],
    ["Athletic Ground", "Athletic Ground"],
    ["", null],
    ["at", null],
  ])("%j → %j", (raw, out) => {
    expect(cleanVenue(raw)).toBe(out);
  });
});

describe("the completion posts never say 'at at' or 'at on'", () => {
  const base = { groupName: "MT Test", chosen: ["attendance" as const], dayOfWeek: 5, kickoffTime: "20:00", weekly: true };
  it.each(["on Sutton Goals", "at Goals", "the Den"])("venue %j", (venue) => {
    const a = buildGroupAddCompletionPost({ ...base, venue, rosterCount: 3, adminsAdded: 0, adminDmQueued: true, adminName: "Kemal" }, "en");
    const b = buildLegacyCompletionPost({ ...base, venue }, "en");
    for (const post of [a, b]) {
      expect(post).not.toMatch(/\bat \*?(?:at|on|in|the)\b/i);
    }
    expect(a).toMatch(/at \*(Sutton Goals|Goals|Den)\*/);
  });
});
