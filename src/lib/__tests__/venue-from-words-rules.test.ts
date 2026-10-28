/**
 * "@Match Time our pitch is Goals Sutton" (2026-10-28, Kemal): which of
 * Google's suggestions is the pitch, decided by code. One clear match is
 * set; several are listed for the organiser to pick by number; none is said.
 */
import { describe, it, expect } from "vitest";
import { chooseVenue, VENUE_CHOICES_MAX } from "../venue-from-words-rules";
import type { VenueSuggestion } from "../venue-suggest-rules";

const s = (primary: string, secondary = "", placeId = `ChIJ${primary.replace(/\W/g, "")}`): VenueSuggestion => ({ placeId, primary, secondary });

describe("chooseVenue", () => {
  it("nothing found is none", () => {
    expect(chooseVenue("Goals Sutton", [], null)).toEqual({ kind: "none" });
  });

  it("one suggestion is the place", () => {
    const only = s("Goals Sutton", "Oxford Rd, Sutton");
    expect(chooseVenue("Goals Sutton", [only], null)).toEqual({ kind: "one", pick: only });
  });

  it("exactly one suggestion with the very name asked for is the place, whatever the others are", () => {
    const right = s("Goals Sutton", "Oxford Rd, Sutton");
    const r = chooseVenue("goals  sutton!", [s("Goals Sutton United FC"), right, s("Goals South London")], null);
    expect(r).toEqual({ kind: "one", pick: right });
  });

  it("the same name twice, in two places, is several: the organiser picks", () => {
    const a = s("Powerleague", "Shoreditch", "ChIJa");
    const b = s("Powerleague", "Croydon", "ChIJb");
    expect(chooseVenue("Powerleague", [a, b], null)).toEqual({ kind: "several", options: [a, b] });
  });

  it("no exact name among several is several, at most five", () => {
    const list = Array.from({ length: 7 }, (_, i) => s(`Goals ${i}`));
    const r = chooseVenue("Goals", list, null);
    expect(r.kind).toBe("several");
    expect(r.kind === "several" && r.options).toHaveLength(VENUE_CHOICES_MAX);
  });

  it("a number picked from the list is that place, counting from 1", () => {
    const list = [s("Goals Sutton", "A"), s("Goals Sutton", "B", "ChIJx")];
    expect(chooseVenue("Goals Sutton", list, 2)).toEqual({ kind: "one", pick: list[1] });
  });

  it("a number past the end of the list shows the list again", () => {
    const list = [s("Goals Sutton", "A", "ChIJa"), s("Goals Sutton", "B", "ChIJb")];
    expect(chooseVenue("Goals Sutton", list, 3)).toEqual({ kind: "several", options: list });
  });

  it("a number with nothing found is none", () => {
    expect(chooseVenue("Goals Sutton", [], 1)).toEqual({ kind: "none" });
  });
});

describe("the pitch replies are never taken for a squad post", () => {
  it("the squad-composition pass and the organisers-mode net leave every outcome alone", async () => {
    const { skipsSquadComposition } = await import("../group-copy");
    const { passesOrganisersNet } = await import("../organisers-list-copy");
    const { VENUE_WORDS_OUTCOMES } = await import("../venue-from-words-rules");
    for (const o of VENUE_WORDS_OUTCOMES) {
      expect(skipsSquadComposition(o), o).toBe(true);
      expect(passesOrganisersNet(o), o).toBe(true);
    }
  });
});

describe("MatchTime's list of places, and the answer to it", () => {
  const T0 = new Date("2026-10-28T15:40:00Z");
  const at = (min: number) => new Date(T0.getTime() + min * 60_000);
  const list = { waMessageId: "group-q:venue:1", fromMatchTime: true, senderUserId: null, text: "I found more than one place for *Goals Sutton*...", askRef: "", createdAt: T0 };

  it("the ref carries the words looked up, and reads them back", async () => {
    const { venuePickAskRef, parseVenuePickRef } = await import("../venue-from-words-rules");
    expect(parseVenuePickRef(venuePickAskRef("  Goals   Sutton "))).toBe("Goals Sutton");
    expect(parseVenuePickRef("ask-source:pool")).toBeNull();
    expect(parseVenuePickRef(null)).toBeNull();
  });

  it("the next message within 15 minutes, or a reply quoting the list, answers it; anything else does not", async () => {
    const { venuePickAskRef, venueListAnswered } = await import("../venue-from-words-rules");
    const row = { ...list, askRef: venuePickAskRef("Goals Sutton") };
    expect(venueListAnswered({ quoted: null, log: [row], now: at(3) })).toEqual(row);
    expect(venueListAnswered({ quoted: null, log: [row], now: at(16) })).toBeNull();
    // Another organiser spoke since: not the next message.
    const other = { waMessageId: "group:x", fromMatchTime: false, senderUserId: "u-2", text: "hm", askRef: null, createdAt: at(1) };
    expect(venueListAnswered({ quoted: null, log: [row, other], now: at(3) })).toBeNull();
    // A reply quoting the list answers it, whenever.
    expect(venueListAnswered({ quoted: { fromMatchTime: true, text: row.text, messageId: null }, log: [row, other], now: at(60) })).toEqual(row);
    // No list logged: nothing.
    expect(venueListAnswered({ quoted: null, log: [], now: at(1) })).toBeNull();
  });
});
