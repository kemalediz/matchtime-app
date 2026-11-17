/**
 * THE SQUAD POST AND THE ANNOUNCEMENT FOR AN OPEN SQUAD (2026-11-17).
 * "N in", never "N/M" or "full squad"; a 🥁 only for a player still needed
 * to reach the game's minimum; no bench. EN and TR, no dashes.
 */
import { describe, expect, it } from "vitest";
import { composeSquadStatusPost } from "../group-copy";
import { buildAnnounceMatchPost } from "../scheduler-copy";

const names = (n: number) => Array.from({ length: n }, (_, i) => `P${i + 1}`);
const DASH = /[–—]/;

describe("composeSquadStatusPost, open squad", () => {
  it("at or above the minimum: \"15 in\", every name, no drum, no \"full\", no \"of\"", () => {
    const text = composeSquadStatusPost({ confirmed: names(15), bench: [], maxPlayers: 15, openSquad: true, matchLabel: "Mon 23 Nov, 20:15", lang: "en" });
    expect(text.split("\n")[0]).toBe("📋 Here's the squad for *Mon 23 Nov, 20:15*: *15 in* ✅ Anyone else, say *IN*.");
    expect(text).toContain("15. P15");
    expect(text).not.toMatch(/🥁|full|\/|Bench/);
  });

  it("below the minimum (10 of 12): how many more to play, a drum for each", () => {
    const text = composeSquadStatusPost({ confirmed: names(10), bench: [], maxPlayers: 12, openSquad: true, lang: "en" });
    expect(text).toContain("*10 in*, need *2 more* to play 🙏");
    expect(text.match(/🥁/g)).toHaveLength(2);
  });

  it("Turkish", () => {
    const text = composeSquadStatusPost({ confirmed: names(13), bench: [], maxPlayers: 12, openSquad: true, matchLabel: "23 Kas Pzt, 20:15", lang: "tr" });
    expect(text.split("\n")[0]).toBe("📋 *23 Kas Pzt, 20:15* maçının kadrosu: *13 kişi* ✅ İsteyen *VARIM* yazsın.");
    expect(text).not.toMatch(DASH);
  });

  it("off: today's words", () => {
    const text = composeSquadStatusPost({ confirmed: names(14), bench: [], maxPlayers: 14, lang: "en" });
    expect(text).toContain("*14/14* ✅ full squad.");
  });
});

describe("the match announcement, open squad", () => {
  it("everyone who says IN plays, never \"first N\"", () => {
    const base = { activityName: "Football", dateLabel: "Monday 23 November at 20:15", venue: "Powerleague", maxPlayers: 12 };
    expect(buildAnnounceMatchPost({ ...base, openSquad: true, lang: "en" })).toBe(
      "📅 *Football*: *Monday 23 November at 20:15* at Powerleague.\n\nSay *IN* to join. Everyone who says IN plays.",
    );
    expect(buildAnnounceMatchPost({ ...base, openSquad: true, lang: "tr" })).toContain("*VARIM* yazan herkes oynar.");
    expect(buildAnnounceMatchPost({ ...base, lang: "en" })).toContain("First 12 confirmed play.");
  });
});
