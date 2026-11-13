/**
 * The /play game line for a Facebook link (2026-11-11): fb, fb1 and fb2
 * sell Sutton FC's Tuesday game, so /play names that game at the top, but
 * only while it is real: the club's next upcoming match, within 8 days,
 * with a place free. Nextdoor (nd) sells the same game (2026-11-13), and
 * Sutton FC's "First game free for new players" offer shows under the line,
 * only with it, and only for a club whose entry carries the offer.
 * Pure; no clock, no database, no model: $0.
 */
import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_GAME_WINDOW_DAYS,
  campaignGame,
  campaignGameClub,
  campaignGameForClub,
  campaignGameLine,
  type CampaignGameMatch,
} from "../campaign-game-line";

const SUTTON_FC = "cmnnwhdx30000zfr85q18lyy9";
const DAY = 24 * 3600_000;

/** Tue 17 Nov 2026, 21:30 London (GMT, so 21:30Z). */
const TUE_17_NOV = new Date("2026-11-17T21:30:00Z");
const NOW = new Date("2026-11-11T10:00:00Z");

function match(over: Partial<CampaignGameMatch> = {}): CampaignGameMatch {
  return { date: TUE_17_NOV, maxPlayers: 14, venue: "Goals North Cheam", placesOpen: 3, ...over };
}

describe("which codes sell a game", () => {
  it("fb, fb1, fb2 and nd are Sutton FC's, in Sutton, with the first game free", () => {
    for (const code of ["fb", "fb1", "fb2", "nd"]) expect(campaignGameClub(code)).toEqual({ orgId: SUTTON_FC, area: "Sutton", firstGameFree: true });
  });
  it("every other code, and no code, sells none", () => {
    for (const code of ["fb3", "fb4", "os", "lf", "ND", "club-sutton-fc", "site-hero", "FB1", "", null]) expect(campaignGameClub(code)).toBeNull();
  });
});

describe("the line", () => {
  it("English: the approved words for the real next game", () => {
    expect(campaignGameLine({ code: "fb1", match: match(), now: NOW, lang: "en" })).toBe(
      "Tuesday 7-a-side in Sutton: Tue 17 Nov, 9:30pm, Goals North Cheam",
    );
  });
  it("Turkish: the same game in Turkish", () => {
    expect(campaignGameLine({ code: "fb", match: match(), now: NOW, lang: "tr" })).toBe("Sutton, Salı 7'ye 7 maçı: 17 Kasım Salı, 21:30, Goals North Cheam");
  });
  it("the same line for fb, fb1, fb2 and nd", () => {
    const lines = ["fb", "fb1", "fb2", "nd"].map((code) => campaignGameLine({ code, match: match(), now: NOW, lang: "en" }));
    expect(new Set(lines).size).toBe(1);
    expect(lines[0]).not.toBeNull();
  });
  it("nothing for another code, even with a game", () => {
    for (const code of ["fb3", "os", "lf", "site-hero", null]) expect(campaignGameLine({ code, match: match(), now: NOW, lang: "en" })).toBeNull();
  });
  it("the format is the match's own size", () => {
    expect(campaignGameLine({ code: "fb", match: match({ maxPlayers: 10 }), now: NOW, lang: "en" })).toBe(
      "Tuesday 5-a-side in Sutton: Tue 17 Nov, 9:30pm, Goals North Cheam",
    );
  });
  it("a kickoff on the hour reads 9pm", () => {
    expect(campaignGameLine({ code: "fb", match: match({ date: new Date("2026-11-17T21:00:00Z") }), now: NOW, lang: "en" })).toBe(
      "Tuesday 7-a-side in Sutton: Tue 17 Nov, 9pm, Goals North Cheam",
    );
  });
  it("no dashes in either language", () => {
    for (const lang of ["en", "tr"] as const) expect(campaignGameLine({ code: "fb", match: match(), now: NOW, lang })).not.toMatch(/[—–]/);
  });
});

describe("never a place that does not exist", () => {
  it("a full match: nothing", () => {
    expect(campaignGameLine({ code: "fb1", match: match({ placesOpen: 0 }), now: NOW, lang: "en" })).toBeNull();
  });
  it("no upcoming match: nothing", () => {
    expect(campaignGameLine({ code: "fb1", match: null, now: NOW, lang: "en" })).toBeNull();
  });
  it("a match more than 8 days away: nothing; exactly 8 days: shown", () => {
    expect(CAMPAIGN_GAME_WINDOW_DAYS).toBe(8);
    const now = new Date(TUE_17_NOV.getTime() - 8 * DAY - 60_000);
    expect(campaignGameLine({ code: "fb1", match: match(), now, lang: "en" })).toBeNull();
    const edge = new Date(TUE_17_NOV.getTime() - 8 * DAY);
    expect(campaignGameLine({ code: "fb1", match: match(), now: edge, lang: "en" })).not.toBeNull();
  });
  it("a match that has kicked off: nothing", () => {
    expect(campaignGameLine({ code: "fb1", match: match(), now: TUE_17_NOV, lang: "en" })).toBeNull();
  });
  it("a match with no venue: nothing", () => {
    expect(campaignGameLine({ code: "fb1", match: match({ venue: "  " }), now: NOW, lang: "en" })).toBeNull();
  });
});

describe("London time, across the clock change", () => {
  // The clocks went back on Sun 25 Oct 2026.
  it("in BST: 20:30Z is 9:30pm London", () => {
    const tue20Oct = new Date("2026-10-20T20:30:00Z");
    expect(campaignGameLine({ code: "fb", match: match({ date: tue20Oct }), now: new Date("2026-10-15T09:00:00Z"), lang: "en" })).toBe(
      "Tuesday 7-a-side in Sutton: Tue 20 Oct, 9:30pm, Goals North Cheam",
    );
  });
  it("seen from BST, a game after the change: 21:30Z is 9:30pm London", () => {
    const tue27Oct = new Date("2026-10-27T21:30:00Z");
    expect(campaignGameLine({ code: "fb", match: match({ date: tue27Oct }), now: new Date("2026-10-22T09:00:00Z"), lang: "en" })).toBe(
      "Tuesday 7-a-side in Sutton: Tue 27 Oct, 9:30pm, Goals North Cheam",
    );
  });
  it("the day is London's, not UTC's: 23:15Z on Tue 20 Oct in BST is Wednesday 00:15 London", () => {
    expect(campaignGameLine({ code: "fb", match: match({ date: new Date("2026-10-20T23:15:00Z") }), now: new Date("2026-10-15T09:00:00Z"), lang: "en" })).toBe(
      "Wednesday 7-a-side in Sutton: Wed 21 Oct, 12:15am, Goals North Cheam",
    );
  });
});

describe("Sutton FC's first game free, under the line", () => {
  const OFFER = "First game free for new players";

  it("English: the approved words, with the line, for fb, fb1, fb2 and nd", () => {
    for (const code of ["fb", "fb1", "fb2", "nd"]) {
      expect(campaignGame({ code, match: match(), now: NOW, lang: "en" })).toEqual({
        line: "Tuesday 7-a-side in Sutton: Tue 17 Nov, 9:30pm, Goals North Cheam",
        offer: OFFER,
      });
    }
  });
  it("Turkish: the offer in Turkish", () => {
    expect(campaignGame({ code: "nd", match: match(), now: NOW, lang: "tr" })?.offer).toBe("Yeni oyunculara ilk maç ücretsiz");
  });
  it("campaignGameLine is the game's line", () => {
    expect(campaignGameLine({ code: "nd", match: match(), now: NOW, lang: "en" })).toBe(campaignGame({ code: "nd", match: match(), now: NOW, lang: "en" })?.line);
  });
  it("no line, no offer: full, too far, kicked off, no match, no venue", () => {
    const tooFar = new Date(TUE_17_NOV.getTime() - 8 * DAY - 60_000);
    const cases: Array<{ m: CampaignGameMatch | null; now: Date }> = [
      { m: match({ placesOpen: 0 }), now: NOW },
      { m: match(), now: tooFar },
      { m: match(), now: TUE_17_NOV },
      { m: null, now: NOW },
      { m: match({ venue: "" }), now: NOW },
    ];
    for (const code of ["fb", "nd"]) for (const c of cases) expect(campaignGame({ code, match: c.m, now: c.now, lang: "en" })).toBeNull();
  });
  it("no offer for an unknown code", () => {
    for (const code of ["os", "lf", "fb3", null]) expect(campaignGame({ code, match: match(), now: NOW, lang: "en" })).toBeNull();
  });
  it("a club without the offer: the line, and no offer", () => {
    const club = { orgId: "some-other-club", area: "Cheam", firstGameFree: false };
    expect(campaignGameForClub({ club, match: match(), now: NOW, lang: "en" })).toEqual({
      line: "Tuesday 7-a-side in Cheam: Tue 17 Nov, 9:30pm, Goals North Cheam",
      offer: null,
    });
  });
  it("a club with the offer but a full game: nothing", () => {
    const club = { orgId: SUTTON_FC, area: "Sutton", firstGameFree: true };
    expect(campaignGameForClub({ club, match: match({ placesOpen: 0 }), now: NOW, lang: "en" })).toBeNull();
  });
});
