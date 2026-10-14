/**
 * The layout decisions behind the list poster and the team sheet
 * (2026-10-14): how many columns, how big the names are, where a long name
 * is cut, which first names need an initial, which colour a team gets.
 * Pure: no database, no renderer.
 */
import { describe, expect, it } from "vitest";
import {
  GRAPHIC_HEIGHT,
  GRAPHIC_WIDTH,
  MAX_RESERVES_SHOWN,
  clubNameFontSize,
  displayNames,
  fitName,
  listPosterLayout,
  shoutCase,
  teamColour,
  teamSheetLayout,
} from "../match-graphics-layout";

describe("the canvas", () => {
  it("is a 4:5 portrait, 1080 wide: the tallest shape WhatsApp shows uncropped in a chat", () => {
    expect(GRAPHIC_WIDTH).toBe(1080);
    expect(GRAPHIC_HEIGHT).toBe(1350);
  });
});

describe("listPosterLayout: columns", () => {
  it("one column up to 9 names", () => {
    expect(listPosterLayout({ count: 9, reserves: 0 }).columns).toBe(1);
  });
  it("two columns from 10 names, as FNF's own 18-name poster does", () => {
    expect(listPosterLayout({ count: 10, reserves: 0 }).columns).toBe(2);
    expect(listPosterLayout({ count: 18, reserves: 0 }).columns).toBe(2);
    expect(listPosterLayout({ count: 24, reserves: 0 }).columns).toBe(2);
  });
  it("splits names down the first column, then the second (1 to 9 left, 10 to 18 right)", () => {
    const l = listPosterLayout({ count: 18, reserves: 0 });
    expect(l.rows).toBe(9);
    const l2 = listPosterLayout({ count: 19, reserves: 0 });
    expect(l2.rows).toBe(10);
  });
});

describe("listPosterLayout: font size by count", () => {
  it("shrinks as the list grows, never below the floor, never above the cap", () => {
    const sizes = [10, 14, 18, 22, 24].map((n) => listPosterLayout({ count: n, reserves: 0 }).fontSize);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
    for (const s of sizes) {
      expect(s).toBeGreaterThanOrEqual(24);
      expect(s).toBeLessThanOrEqual(56);
    }
    expect(listPosterLayout({ count: 3, reserves: 0 }).fontSize).toBe(56);
  });
  it("a reserves block takes room from the names", () => {
    expect(listPosterLayout({ count: 18, reserves: 4 }).fontSize).toBeLessThan(listPosterLayout({ count: 18, reserves: 0 }).fontSize);
  });
  it("every row fits the names area, at every count from 1 to 30, with or without reserves", () => {
    for (let n = 1; n <= 30; n++) {
      for (const r of [0, 6]) {
        const l = listPosterLayout({ count: n, reserves: r });
        expect(l.rows * l.rowHeight).toBeLessThanOrEqual(l.namesAreaHeight);
      }
    }
  });
  it("shows at most a handful of reserves and counts the rest", () => {
    const l = listPosterLayout({ count: 18, reserves: MAX_RESERVES_SHOWN + 3 });
    expect(l.reservesShown).toBe(MAX_RESERVES_SHOWN);
    expect(l.reservesHidden).toBe(3);
    expect(listPosterLayout({ count: 18, reserves: 2 })).toMatchObject({ reservesShown: 2, reservesHidden: 0 });
  });
  it("a wider column allows a longer name", () => {
    expect(listPosterLayout({ count: 6, reserves: 0 }).maxChars).toBeGreaterThan(listPosterLayout({ count: 18, reserves: 0 }).maxChars);
  });
  it("an empty list still lays out (zero rows is never a divide by zero)", () => {
    const l = listPosterLayout({ count: 0, reserves: 0 });
    expect(l.columns).toBe(1);
    expect(Number.isFinite(l.fontSize)).toBe(true);
  });
});

describe("teamSheetLayout", () => {
  it("two columns always; sized by the bigger team", () => {
    const nine = teamSheetLayout({ maxPerTeam: 9 });
    const twelve = teamSheetLayout({ maxPerTeam: 12 });
    expect(twelve.fontSize).toBeLessThan(nine.fontSize);
    for (let n = 1; n <= 15; n++) {
      const l = teamSheetLayout({ maxPerTeam: n });
      expect(l.maxPerTeam * l.rowHeight).toBeLessThanOrEqual(l.namesAreaHeight);
      expect(l.fontSize).toBeGreaterThanOrEqual(24);
      expect(l.fontSize).toBeLessThanOrEqual(56);
    }
  });
});

describe("fitName: long names", () => {
  it("leaves a name that fits alone", () => {
    expect(fitName("Shehryar", 12)).toBe("Shehryar");
  });
  it("cuts a long one with an ellipsis, inside the limit", () => {
    const out = fitName("Bartholomew-Alexander", 12);
    expect(out).toBe("Bartholomew…");
    expect([...out].length).toBe(12);
  });
  it("never splits an emoji or an accented letter in half", () => {
    expect(fitName("Mo 👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦", 4)).toBe("Mo…");
    expect(fitName("Mo👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦", 4)).toBe("Mo👨‍👩‍👧‍👦…");
    expect(fitName("Çağatay Şükrü", 5)).toBe("Çağa…");
  });
  it("trims, and squeezes inner whitespace", () => {
    expect(fitName("  Ali   Veli  ", 20)).toBe("Ali Veli");
  });
});

describe("displayNames: first names only, as the club knows them", () => {
  it("the first word of the name", () => {
    expect(displayNames([{ id: "a", name: "Shehryar Khan" }], "en")).toEqual(new Map([["a", "Shehryar"]]));
  });
  it("two people with the same first name get their last initial", () => {
    const m = displayNames(
      [
        { id: "a", name: "Ali Kaya" },
        { id: "b", name: "Ali Yılmaz" },
        { id: "c", name: "Mehmet Öz" },
      ],
      "tr",
    );
    expect(m.get("a")).toBe("Ali K.");
    expect(m.get("b")).toBe("Ali Y.");
    expect(m.get("c")).toBe("Mehmet");
  });
  it("same first name and same initial: the whole name, which is what the club calls them apart", () => {
    const m = displayNames(
      [
        { id: "a", name: "Omar Khan" },
        { id: "b", name: "Omar Kazi" },
      ],
      "en",
    );
    expect(m.get("a")).toBe("Omar Khan");
    expect(m.get("b")).toBe("Omar Kazi");
  });
  it("same first name, one without a surname: the surname-less one stays bare", () => {
    const m = displayNames(
      [
        { id: "a", name: "Omar" },
        { id: "b", name: "Omar Kazi" },
      ],
      "en",
    );
    expect(m.get("a")).toBe("Omar");
    expect(m.get("b")).toBe("Omar K.");
  });
  it("never prints a phone number: a missing or number-like name is 'Player' / 'Oyuncu'", () => {
    const en = displayNames(
      [
        { id: "a", name: null },
        { id: "b", name: "+44 7700 900123" },
        { id: "c", name: "   " },
      ],
      "en",
    );
    expect([...en.values()]).toEqual(["Player", "Player", "Player"]);
    expect(displayNames([{ id: "a", name: "905321234567" }], "tr").get("a")).toBe("Oyuncu");
  });
  it("keeps emoji and Turkish letters as typed", () => {
    expect(displayNames([{ id: "a", name: "İsmail ⚽" }], "tr").get("a")).toBe("İsmail");
    expect(displayNames([{ id: "a", name: "⚽Bilal" }], "en").get("a")).toBe("⚽Bilal");
  });
});

describe("shoutCase", () => {
  it("upper-cases in the club's language: Turkish i and ı", () => {
    expect(shoutCase("Sarı", "tr")).toBe("SARI");
    expect(shoutCase("istanbul", "tr")).toBe("İSTANBUL");
    expect(shoutCase("istanbul", "en")).toBe("ISTANBUL");
  });
});

describe("teamColour", () => {
  it("a label that names a colour gets it, in English or Turkish", () => {
    expect(teamColour("Blue", 0).bg).toBe(teamColour("Mavi", 1).bg);
    expect(teamColour("Kırmızı", 1).bg).toBe(teamColour("Red", 0).bg);
    expect(teamColour("Bibs Yellow", 0).bg).toBe(teamColour("Sarı", 1).bg);
  });
  it("anything else falls back by slot: red first, yellow second", () => {
    expect(teamColour("Lions", 0).bg).toBe(teamColour("Red", 0).bg);
    expect(teamColour("Tigers", 1).bg).toBe(teamColour("Yellow", 1).bg);
  });
  it("text on a light shirt colour is dark", () => {
    expect(teamColour("Yellow", 1).fg).toBe("#0f172a");
    expect(teamColour("White", 0).fg).toBe("#0f172a");
    expect(teamColour("Red", 0).fg).toBe("#ffffff");
  });
});

describe("clubNameFontSize", () => {
  it("big for a short name, smaller for a long one", () => {
    expect(clubNameFontSize("FNF")).toBeGreaterThan(clubNameFontSize("Friday Night Football Wandsworth"));
    expect(clubNameFontSize("Friday Night Football Wandsworth Common Sunday League")).toBeGreaterThanOrEqual(44);
  });
});
