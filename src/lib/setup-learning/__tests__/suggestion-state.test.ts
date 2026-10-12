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
};

/** CLUB after the organiser put `key` to the value the chat showed. */
const TO_DETECTED: Record<SuggestionKey, ClubNow> = {
  weeklyGameDay: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, dayOfWeek: 4 } },
  weeklyGameTime: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, time: "20:30" } },
  venue: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, venue: "Powerleague Croydon" } },
  format: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, playersPerSide: 5 } },
  language: { ...CLUB, language: "tr" },
  organiserPicks: { ...CLUB, benchPickMode: "organiser" },
};

/** CLUB after the organiser put `key` to something that is neither value. */
const TO_THIRD: Record<SuggestionKey, { club: ClubNow; now: string }> = {
  weeklyGameDay: { club: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, dayOfWeek: 3 } }, now: "3" },
  weeklyGameTime: { club: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, time: "19:00" } }, now: "19:00" },
  venue: { club: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, venue: "Trinity School" } }, now: "Trinity School" },
  format: { club: { ...CLUB, weeklyGame: { ...CLUB.weeklyGame!, playersPerSide: 6 } }, now: "6" },
  language: { club: { ...CLUB, language: "de" }, now: "de" },
  organiserPicks: { club: { ...CLUB, benchPickMode: "lottery" }, now: "lottery" },
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
    expect(weeklyGameOf([first, second])).toEqual({ dayOfWeek: 2, time: "20:00", venue: "Goals Sutton", playersPerSide: 7 });
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
    });
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
  });

  it("Turkish, each key at the value the club has now", () => {
    expect(line("tr", "weeklyGameTime", TO_DETECTED.weeklyGameTime)).toBe("Maç saati artık 20:30.");
    expect(line("tr", "weeklyGameDay", TO_DETECTED.weeklyGameDay)).toBe("Maç günü artık Perşembe.");
    expect(line("tr", "venue", TO_DETECTED.venue)).toBe("Saha artık Powerleague Croydon.");
    expect(line("tr", "format", TO_DETECTED.format)).toBe("Haftalık maçınız artık takım başına 5 kişi.");
    expect(line("tr", "language", TO_DETECTED.language)).toBe("MatchTime bu grupta artık Türkçe konuşuyor.");
    expect(line("tr", "organiserPicks", TO_DETECTED.organiserPicks)).toBe('"Organizatörler seçer" ayarı açık.');
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
