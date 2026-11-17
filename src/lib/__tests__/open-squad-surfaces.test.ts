/**
 * NO FORMAT AND NO "FULL" ON THE OTHER SURFACES OF AN OPEN SQUAD (review
 * of #623, item 10): the DM Q&A context, the pool offer and the /play
 * game line. Each says the count alone and the game with no size.
 */
import { describe, expect, it } from "vitest";
import { formatScopedContext } from "../dm-qa";
import { gameOf } from "../pool/offer-copy";
import { campaignGameForClub } from "../pool/campaign-game-line";

describe("the DM Q&A context", () => {
  const match = { activityName: "Football", date: new Date("2026-11-23T20:15:00Z"), venue: "Goals", maxPlayers: 14, confirmed: ["A", "B"], bench: [], myStatus: null };
  it("open squad: \"N in, no squad limit\", never N/M", () => {
    const text = formatScopedContext({ orgName: "Vets", match: { ...match, openSquad: true }, stats: null, history: null } as Parameters<typeof formatScopedContext>[0]);
    expect(text).toContain("- Squad: 2 in (no squad limit, no bench)");
    expect(text).not.toContain("2/14");
  });
  it("off: as before", () => {
    const text = formatScopedContext({ orgName: "Vets", match, stats: null, history: null } as Parameters<typeof formatScopedContext>[0]);
    expect(text).toContain("- Squad: 2/14 confirmed, 0 on the bench");
  });
});

describe("the pool offer's game", () => {
  it("open squad: the sport alone; off: with its size", () => {
    expect(gameOf("en", { sport: "football", format: 7, noFormat: true })).not.toMatch(/7/);
    expect(gameOf("en", { sport: "football", format: 7 })).toMatch(/7/);
  });
});

describe("the /play game line", () => {
  const club = { orgId: "vets", area: "Sutton", firstGameFree: false };
  const now = new Date("2026-11-20T12:00:00Z");
  const m = { date: new Date("2026-11-23T20:15:00Z"), maxPlayers: 14, venue: "Goals", placesOpen: 2 };
  it("open squad: no number a side, EN and TR", () => {
    expect(campaignGameForClub({ club, match: { ...m, openSquad: true }, now, lang: "en" })!.line).not.toMatch(/a-side|7/);
    expect(campaignGameForClub({ club, match: { ...m, openSquad: true }, now, lang: "tr" })!.line).not.toMatch(/7'ye 7/);
  });
  it("off: with the size", () => {
    expect(campaignGameForClub({ club, match: m, now, lang: "en" })!.line).toMatch(/7/);
  });
});
