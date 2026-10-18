/**
 * THE SQUAD COUNT LINE, WITH THE BENCH (FNF HQ, 2026-10-18).
 *
 * An organiser wrote "Akram out" in HQ and MatchTime answered "Done: Akram
 * out. 17 of 18." with Uncle Najib on the bench: it read as if nobody was
 * waiting. Every count line now says the bench when anyone is on it, and
 * in an organiser-pick club says how to bring someone in.
 */
import { describe, expect, it } from "vitest";
import { benchClause, buildBenchPickHint, buildSquadCountLine, BENCH_NAMES_SHOWN } from "../squad-count-line";

const FIVE = ["Uncle Najib", "Ben Bench", "Cem Can", "Dan Day", "Eli Eck"];

describe("benchClause", () => {
  it("says nothing with nobody on the bench", () => {
    expect(benchClause("en", [])).toBe("");
    expect(benchClause("tr", [])).toBe("");
  });
  it("names up to three", () => {
    expect(BENCH_NAMES_SHOWN).toBe(3);
    expect(benchClause("en", FIVE.slice(0, 1))).toBe(", 1 on the bench (Uncle Najib)");
    expect(benchClause("en", FIVE.slice(0, 3))).toBe(", 3 on the bench (Uncle Najib, Ben Bench and Cem Can)");
    expect(benchClause("tr", FIVE.slice(0, 1))).toBe(", yedekte 1 kişi (Uncle Najib)");
    expect(benchClause("tr", FIVE.slice(0, 3))).toBe(", yedekte 3 kişi (Uncle Najib, Ben Bench ve Cem Can)");
  });
  it("only the count past three", () => {
    expect(benchClause("en", FIVE)).toBe(", 5 on the bench");
    expect(benchClause("tr", FIVE)).toBe(", yedekte 5 kişi");
  });
  it("only the count when names are not to be shown", () => {
    expect(benchClause("en", FIVE.slice(0, 1), { names: false })).toBe(", 1 on the bench");
  });
});

describe("buildSquadCountLine", () => {
  it("0 on the bench: as before", () => {
    expect(buildSquadCountLine({ lang: "en", confirmed: 17, maxPlayers: 18, bench: [] })).toBe("17 of 18.");
    expect(buildSquadCountLine({ lang: "tr", confirmed: 17, maxPlayers: 18, bench: [] })).toBe("17/18.");
  });
  it("1 on the bench: the incident", () => {
    expect(buildSquadCountLine({ lang: "en", confirmed: 17, maxPlayers: 18, bench: ["Uncle Najib"] })).toBe(
      "17 of 18, 1 on the bench (Uncle Najib).",
    );
    expect(buildSquadCountLine({ lang: "tr", confirmed: 17, maxPlayers: 18, bench: ["Uncle Najib"] })).toBe(
      "17/18, yedekte 1 kişi (Uncle Najib).",
    );
  });
  it("3 and 5 on the bench", () => {
    expect(buildSquadCountLine({ lang: "en", confirmed: 18, maxPlayers: 18, bench: FIVE.slice(0, 3) })).toBe(
      "18 of 18, 3 on the bench (Uncle Najib, Ben Bench and Cem Can).",
    );
    expect(buildSquadCountLine({ lang: "en", confirmed: 18, maxPlayers: 18, bench: FIVE })).toBe("18 of 18, 5 on the bench.");
    expect(buildSquadCountLine({ lang: "tr", confirmed: 18, maxPlayers: 18, bench: FIVE })).toBe("18/18, yedekte 5 kişi.");
  });
});

describe("buildBenchPickHint", () => {
  const base = { confirmed: 17, maxPlayers: 18, bench: ["Uncle Najib"] };
  it("organiser pick, a place free, someone on the bench: how to bring them in", () => {
    expect(buildBenchPickHint({ ...base, lang: "en", benchPickMode: "organiser" })).toBe(
      'A place is free. To bring someone in from the bench, write "put Uncle Najib in".',
    );
    expect(buildBenchPickHint({ ...base, lang: "tr", benchPickMode: "organiser" })).toBe(
      'Bir yer boş. Yedekten birini almak için "Uncle Najib var" yazın.',
    );
  });
  it("two places free, five on the bench: the first one named as the example", () => {
    expect(buildBenchPickHint({ lang: "en", confirmed: 16, maxPlayers: 18, bench: FIVE, benchPickMode: "organiser" })).toBe(
      '2 places are free. To bring someone in from the bench, write "put Uncle Najib in".',
    );
    expect(buildBenchPickHint({ lang: "tr", confirmed: 16, maxPlayers: 18, bench: FIVE, benchPickMode: "organiser" })).toBe(
      '2 yer boş. Yedekten birini almak için "Uncle Najib var" yazın.',
    );
  });
  it("automatic bench (first come): nothing, the bench offer does it", () => {
    expect(buildBenchPickHint({ ...base, lang: "en", benchPickMode: "first-come" })).toBeNull();
    expect(buildBenchPickHint({ ...base, lang: "en", benchPickMode: null })).toBeNull();
  });
  it("no place free, or nobody on the bench: nothing", () => {
    expect(buildBenchPickHint({ ...base, lang: "en", confirmed: 18, benchPickMode: "organiser" })).toBeNull();
    expect(buildBenchPickHint({ ...base, lang: "en", bench: [], benchPickMode: "organiser" })).toBeNull();
  });
});
