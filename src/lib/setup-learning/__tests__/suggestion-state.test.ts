/**
 * F3, learned setup: is a suggestion still open? (2026-10-12)
 *
 * The owner changed his kickoff from 20:00 to 20:30 on the weekly game
 * page, came back to /admin/settings, and the card still told him his
 * game was set for 20:00. The suggestions are stored once, when the chat
 * is read; the page must hold them against what the club has NOW. Pure:
 * no database, no model.
 */
import { describe, expect, it } from "vitest";
import { SUGGESTION_KEYS, type Suggestion, type SuggestionKey } from "../rules";
import {
  currentSuggestionValue,
  resolveSuggestion,
  resolveSuggestions,
  resolvedLine,
  weeklyGameOf,
  type ClubNow,
} from "../suggestion-state";

const CLUB: ClubNow = {
  weeklyGame: { dayOfWeek: 2, time: "20:00", venue: "Goals Sutton", playersPerSide: 7 },
  language: "en",
  benchPickMode: "first-come",
};

/** One stored suggestion per key, each as the reading would have written it for CLUB. */
const STORED: Record<SuggestionKey, Suggestion> = {
  weeklyGameDay: { key: "weeklyGameDay", current: "2", detected: "4", evidence: ["see you Thursday"] },
  weeklyGameTime: { key: "weeklyGameTime", current: "20:00", detected: "20:30", evidence: ["8.30 kick off as usual"] },
  venue: { key: "venue", current: "Goals Sutton", detected: "Powerleague Croydon", evidence: ["Powerleague again"] },
  format: { key: "format", current: "7", detected: "5", evidence: ["5 a side"] },
  language: { key: "language", current: "en", detected: "tr", evidence: [] },
  organiserPicks: { key: "organiserPicks", current: "first-come", detected: "organiser", evidence: ["I'll pick"] },
  // CLUB's weekly game has no fee: "" (never null, which would mean "nothing to compare").
  matchFee: { key: "matchFee", current: "", detected: "6", evidence: ["£6 a player"], fromDescription: ["£6 a player"] },
};

/** CLUB after the organiser put `key` to the value the chat showed. */
const TO_DETECTED: Record<SuggestionKey, ClubNow> = {
  weeklyGameDay: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, dayOfWeek: 4 } },
  weeklyGameTime: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, time: "20:30" } },
  venue: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, venue: "Powerleague Croydon" } },
  format: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, playersPerSide: 5 } },
  language: { ...CLUB, language: "tr" },
  organiserPicks: { ...CLUB, benchPickMode: "organiser" },
  matchFee: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, feePerPlayer: 6 } },
};

/** CLUB after the organiser put `key` to something that is neither value. */
const TO_THIRD: Record<SuggestionKey, { club: ClubNow; now: string }> = {
  weeklyGameDay: { club: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, dayOfWeek: 3 } }, now: "3" },
  weeklyGameTime: { club: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, time: "19:00" } }, now: "19:00" },
  venue: { club: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, venue: "Trinity School" } }, now: "Trinity School" },
  format: { club: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, playersPerSide: 6 } }, now: "6" },
  language: { club: { ...CLUB, language: "de" }, now: "de" },
  organiserPicks: { club: { ...CLUB, benchPickMode: "lottery" }, now: "lottery" },
  matchFee: { club: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, feePerPlayer: 5.5 } }, now: "5.50" },
};

describe("every suggestion key is covered", () => {
  it("the fixtures name every key the reading can write", () => {
    expect(Object.keys(STORED).sort()).toEqual([...SUGGESTION_KEYS].sort());
  });
});

describe.each(SUGGESTION_KEYS)("%s", (key) => {
  it("unchanged: open, with the value the club has", () => {
    const r = resolveSuggestion(STORED[key], CLUB);
    expect(r.state).toBe("open");
    expect(r.now).toBe(STORED[key].current);
    expect(r.current).toBe(STORED[key].current);
    expect(r.detected).toBe(STORED[key].detected);
    expect(r.evidence).toEqual(STORED[key].evidence);
  });

  it("changed to what the chat showed: resolved", () => {
    const r = resolveSuggestion(STORED[key], TO_DETECTED[key]);
    expect(r.state).toBe("resolved");
    expect(r.now).toBe(STORED[key].detected);
  });

  it("changed to a third value: resolved (the organiser looked and decided)", () => {
    const r = resolveSuggestion(STORED[key], TO_THIRD[key].club);
    expect(r.state).toBe("resolved");
    expect(r.now).toBe(TO_THIRD[key].now);
  });
});

describe("the owner's case", () => {
  it("kickoff moved from 20:00 to 20:30: that one is resolved, organisers pick is still open", () => {
    const out = resolveSuggestions([STORED.weeklyGameTime, STORED.organiserPicks], TO_DETECTED.weeklyGameTime);
    expect(out.map((s) => [s.key, s.state])).toEqual([
      ["weeklyGameTime", "resolved"],
      ["organiserPicks", "open"],
    ]);
  });

  it("the stored suggestion is not touched", () => {
    const before = JSON.stringify(STORED.weeklyGameTime);
    resolveSuggestion(STORED.weeklyGameTime, TO_DETECTED.weeklyGameTime);
    expect(JSON.stringify(STORED.weeklyGameTime)).toBe(before);
  });
});

describe("the venue is compared the way the reading compared it", () => {
  const sg = STORED.venue;
  const at = (venue: string | null): ClubNow => ({ ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, venue } });

  it("a venue that contains the chat's name is the chat's venue: resolved", () => {
    expect(resolveSuggestion(sg, at("Powerleague Croydon, pitch 3")).state).toBe("resolved");
    expect(resolveSuggestion(sg, at("POWERLEAGUE  CROYDON")).state).toBe("resolved");
  });

  it("the same venue written out longer is still the old one: open, shown as the club has it now", () => {
    const r = resolveSuggestion(sg, at("Goals Sutton (pitch 2)"));
    expect(r.state).toBe("open");
    expect(r.current).toBe("Goals Sutton (pitch 2)");
  });

  it("no venue any more: resolved", () => {
    const r = resolveSuggestion(sg, at(null));
    expect(r).toMatchObject({ state: "resolved", now: null });
  });
});

describe("a club with no weekly game", () => {
  const none: ClubNow = { ...CLUB, weeklyGame: null };

  it.each(["weeklyGameDay", "weeklyGameTime", "venue", "format"] as const)("%s: resolved, with no value to show", (key) => {
    expect(resolveSuggestion(STORED[key], none)).toMatchObject({ state: "resolved", now: null });
  });

  it("the match fee is the weekly game's: resolved, with no value to show", () => {
    expect(resolveSuggestion(STORED.matchFee, none)).toMatchObject({ state: "resolved", now: null });
  });

  it("the language and organisers pick do not depend on the weekly game", () => {
    expect(resolveSuggestion(STORED.language, none).state).toBe("open");
    expect(resolveSuggestion(STORED.organiserPicks, none).state).toBe("open");
  });

  it("the game's sport has no players a side: the format is resolved, not guessed", () => {
    const club: ClubNow = { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, playersPerSide: null } };
    expect(resolveSuggestion(STORED.format, club)).toMatchObject({ state: "resolved", now: null });
  });
});

describe("several activities: the weekly game is the one the reading used", () => {
  const first = { dayOfWeek: 2, time: "20:00", venue: "Goals Sutton", sport: { playersPerTeam: 7 } };
  const second = { dayOfWeek: 4, time: "20:30", venue: "Powerleague Croydon", sport: { playersPerTeam: 5 } };

  it("the first of the list (active, oldest first), never a later one", () => {
    expect(weeklyGameOf([first, second])).toEqual({
      dayOfWeek: 2,
      time: "20:00",
      venue: "Goals Sutton",
      playersPerSide: 7,
      feePerPlayer: null,
      feeSplitTotal: false,
    });
  });

  it("a second game that matches the chat does not resolve anything", () => {
    const club: ClubNow = { ...CLUB, weeklyGame: weeklyGameOf([first, second]) };
    for (const key of ["weeklyGameDay", "weeklyGameTime", "venue", "format"] as const) {
      expect(resolveSuggestion(STORED[key], club).state).toBe("open");
    }
  });

  it("no activity: no weekly game; a missing venue or sport is null", () => {
    expect(weeklyGameOf([])).toBeNull();
    expect(weeklyGameOf([{ dayOfWeek: 1, time: "19:00", venue: null, sport: null }])).toEqual({
      dayOfWeek: 1,
      time: "19:00",
      venue: null,
      playersPerSide: null,
      feePerPlayer: null,
      feeSplitTotal: false,
    });
  });

  it("carries the game's fee and whether the pitch cost is split (slice D3), from the first game only", () => {
    expect(weeklyGameOf([{ ...first, feePerPlayer: 6.5, feeSplitTotal: true }, { ...second, feePerPlayer: 9 }])).toMatchObject({
      feePerPlayer: 6.5,
      feeSplitTotal: true,
    });
  });
});

// Go-live slice D3 (2026-10-12): the match fee suggestion. "No fee" is ""
// in the stored row and here, never null: null means there is nothing to
// compare, which resolves the card, and would hide it on first load.
describe("the match fee", () => {
  const fee = (feePerPlayer: number | null, feeSplitTotal = false): ClubNow => ({
    ...CLUB,
    weeklyGame: { ...CLUB.weeklyGame!, feePerPlayer, feeSplitTotal },
  });
  const sg = STORED.matchFee;
  const had5: Suggestion = { ...sg, current: "5" };

  it("no fee when read, none now: OPEN on first load, whether the fee is null, 0 or not loaded at all", () => {
    for (const club of [fee(null), fee(0), CLUB]) {
      expect(resolveSuggestion(sg, club)).toMatchObject({ state: "open", now: "", current: "" });
    }
    expect(currentSuggestionValue("matchFee", fee(null))).toBe("");
  });
  it("the fee the chat showed is entered: resolved, compared as amounts and not as text", () => {
    expect(resolveSuggestion(sg, fee(6))).toMatchObject({ state: "resolved", now: "6" });
    expect(resolveSuggestion({ ...sg, detected: "6.50" }, fee(6.5))).toMatchObject({ state: "resolved", now: "6.50" });
    expect(resolveSuggestion({ ...sg, detected: "6.5" }, fee(6.5)).state).toBe("resolved");
    expect(resolveSuggestion({ ...sg, detected: "6.00" }, fee(6)).state).toBe("resolved");
  });
  it("any other fee than the one it had: resolved (the organiser looked and decided)", () => {
    expect(resolveSuggestion(sg, fee(8))).toMatchObject({ state: "resolved", now: "8" });
    expect(resolveSuggestion(had5, fee(5.5))).toMatchObject({ state: "resolved", now: "5.50" });
    // It had £5 and now has none: that is another value too.
    expect(resolveSuggestion(had5, fee(null))).toMatchObject({ state: "resolved", now: "" });
  });
  it("still the fee it had: open, worded with it", () => {
    expect(resolveSuggestion(had5, fee(5))).toMatchObject({ state: "open", now: "5", current: "5" });
    expect(resolveSuggestion({ ...sg, current: "5.50" }, fee(5.5))).toMatchObject({ state: "open", current: "5.50" });
  });
  it("the club switched to splitting the pitch: resolved, there is no fee per player to set", () => {
    expect(resolveSuggestion(sg, fee(null, true))).toMatchObject({ state: "resolved", now: null });
    expect(resolveSuggestion(had5, fee(5, true))).toMatchObject({ state: "resolved", now: null });
  });
  it("the quiet line, in English and Turkish", () => {
    const line = (lang: string, s: Suggestion, club: ClubNow) => resolvedLine(lang, resolveSuggestion(s, club));
    expect(line("en", sg, fee(6))).toBe("The match fee is now £6 a player.");
    expect(line("tr", sg, fee(6))).toBe("Maç ücreti artık kişi başı £6.");
    expect(line("en", had5, fee(5.5))).toBe("The match fee is now £5.50 a player.");
    expect(line("tr", had5, fee(5.5))).toBe("Maç ücreti artık kişi başı £5.50.");
    expect(line("en", had5, fee(null))).toBe("Your weekly game has no fee set now.");
    expect(line("tr", had5, fee(null))).toBe("Haftalık maçınızda artık ücret girilmemiş.");
    expect(line("en", sg, fee(null, true))).toBe("This has changed since the chat was read.");
    expect(line("tr", sg, fee(null, true))).toBe("Bu, sohbet okunduktan sonra değişti.");
  });
});

describe("a key this build does not know (written by a newer one)", () => {
  it("stays open and unchanged rather than vanishing", () => {
    const sg = { key: "somethingNew", current: "a", detected: "b", evidence: [] } as unknown as Suggestion;
    expect(resolveSuggestion(sg, CLUB)).toEqual({ ...sg, state: "open", now: "a" });
    expect(currentSuggestionValue("somethingNew" as SuggestionKey, CLUB)).toBeUndefined();
  });
});

describe("the quiet line for a resolved item", () => {
  const line = (lang: string, key: SuggestionKey, club: ClubNow) => resolvedLine(lang, resolveSuggestion(STORED[key], club));

  it("English, each key at the value the club has now", () => {
    expect(line("en", "weeklyGameTime", TO_DETECTED.weeklyGameTime)).toBe("Kickoff time is now 20:30.");
    expect(line("en", "weeklyGameDay", TO_DETECTED.weeklyGameDay)).toBe("Game day is now Thursday.");
    expect(line("en", "venue", TO_DETECTED.venue)).toBe("The pitch is now Powerleague Croydon.");
    expect(line("en", "format", TO_DETECTED.format)).toBe("Your weekly game is now 5 a side.");
    expect(line("en", "language", TO_DETECTED.language)).toBe("MatchTime now speaks Turkish in this group.");
    expect(line("en", "organiserPicks", TO_DETECTED.organiserPicks)).toBe('"The organisers pick" is on.');
    expect(line("en", "matchFee", TO_DETECTED.matchFee)).toBe("The match fee is now £6 a player.");
  });

  it("Turkish, each key at the value the club has now", () => {
    expect(line("tr", "weeklyGameTime", TO_DETECTED.weeklyGameTime)).toBe("Maç saati artık 20:30.");
    expect(line("tr", "weeklyGameDay", TO_DETECTED.weeklyGameDay)).toBe("Maç günü artık Perşembe.");
    expect(line("tr", "venue", TO_DETECTED.venue)).toBe("Saha artık Powerleague Croydon.");
    expect(line("tr", "format", TO_DETECTED.format)).toBe("Haftalık maçınız artık takım başına 5 kişi.");
    expect(line("tr", "language", TO_DETECTED.language)).toBe("MatchTime bu grupta artık Türkçe konuşuyor.");
    expect(line("tr", "organiserPicks", TO_DETECTED.organiserPicks)).toBe('"Organizatörler seçer" ayarı açık.');
    expect(line("tr", "matchFee", TO_DETECTED.matchFee)).toBe("Maç ücreti artık kişi başı £6.");
  });

  it("a third value is shown as it is", () => {
    expect(line("en", "weeklyGameTime", TO_THIRD.weeklyGameTime.club)).toBe("Kickoff time is now 19:00.");
  });

  it("nothing to show (no weekly game, or a pick mode that is not the organisers'): it says it changed", () => {
    expect(line("en", "weeklyGameTime", { ...CLUB, weeklyGame: null })).toBe("This has changed since the chat was read.");
    expect(line("tr", "weeklyGameTime", { ...CLUB, weeklyGame: null })).toBe("Bu, sohbet okunduktan sonra değişti.");
    expect(line("en", "organiserPicks", TO_THIRD.organiserPicks.club)).toBe("This has changed since the chat was read.");
  });

  it("no em or en dashes in either language", () => {
    for (const lang of ["en", "tr"]) {
      for (const key of SUGGESTION_KEYS) {
        for (const club of [TO_DETECTED[key], { ...CLUB, weeklyGame: null, benchPickMode: "lottery", language: "tr" }]) {
          expect(line(lang, key, club)).not.toMatch(/[—–]/);
        }
      }
    }
  });
});
