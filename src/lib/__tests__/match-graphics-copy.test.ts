/**
 * The words on the two graphics and around them, both languages
 * (2026-10-14). No em or en dashes anywhere.
 */
import { describe, expect, it } from "vitest";
import { graphicCaption, graphicsCopy } from "../match-graphics-copy";

// Fri 16 Oct 2026, 21:00 London (BST).
const FRI = new Date("2026-10-16T20:00:00Z");

describe("graphicCaption", () => {
  it("English: 'Ready to post: FNF list for Fri 16 Oct'", () => {
    expect(graphicCaption("list", "en", "FNF", FRI)).toBe("Ready to post: FNF list for Fri 16 Oct");
    expect(graphicCaption("teams", "en", "FNF", FRI)).toBe("Ready to post: FNF teams for Fri 16 Oct");
  });
  it("Turkish", () => {
    expect(graphicCaption("list", "tr", "FNF", FRI)).toBe("Paylaşıma hazır: FNF listesi, 16 Ekim Cuma");
    expect(graphicCaption("teams", "tr", "FNF", FRI)).toBe("Paylaşıma hazır: FNF takımları, 16 Ekim Cuma");
  });
  it("an unknown language reads English", () => {
    expect(graphicCaption("list", "xx", "FNF", FRI)).toBe("Ready to post: FNF list for Fri 16 Oct");
  });
});

describe("the tables", () => {
  it("English and Turkish words", () => {
    const en = graphicsCopy("en");
    const tr = graphicsCopy("tr");
    expect([en.listTitle, en.teamsTitle, en.reserves, en.venue, en.date, en.kickoff]).toEqual(["SQUAD", "TEAMS", "RESERVES", "VENUE", "DATE", "KICKOFF"]);
    expect([tr.listTitle, tr.teamsTitle, tr.reserves, tr.venue, tr.date, tr.kickoff]).toEqual(["KADRO", "TAKIMLAR", "YEDEKLER", "SAHA", "TARİH", "SAAT"]);
    expect(en.players(18)).toBe("18 PLAYERS");
    expect(en.players(1)).toBe("1 PLAYER");
    expect(tr.players(18)).toBe("18 OYUNCU");
    expect(en.noTeams).toBe("No teams yet.");
    expect(tr.noTeams).toBe("Henüz takım yok.");
  });
  it("no em or en dash in any string, either language", () => {
    for (const lang of ["en", "tr"]) {
      const s = graphicsCopy(lang);
      const all = Object.values(s)
        .map((v) => (typeof v === "function" ? (v as (...a: unknown[]) => string)("FNF", "https://x") : v))
        .join("\n");
      expect(all).not.toMatch(/[–—]/);
    }
  });
});
