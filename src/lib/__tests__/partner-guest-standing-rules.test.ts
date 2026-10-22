/**
 * A partner guest's standing at HIS OWN club (Kemal, 2026-10-22, option C):
 * the band the asking club's organisers see, and the words for it.
 */
import { describe, expect, it } from "vitest";
import { STANDING_MIN_POOL, standingBand, standingPhrase } from "../partner-guest-standing-rules";
import { t } from "../i18n/t";

const pool = (...r: number[]) => r;

describe("standingBand: thirds of his own club's rated players", () => {
  it("no rating at his club: unrated, whatever the pool", () => {
    expect(standingBand(null, pool(5, 6, 7, 8, 9))).toBe("unrated");
    expect(standingBand(null, [])).toBe("unrated");
  });

  it("too few rated players to rank (fewer than the minimum, him included)", () => {
    expect(STANDING_MIN_POOL).toBe(5);
    // Only him rated: never "top third" of a club of one.
    expect(standingBand(7.4, [])).toBe("too-few");
    expect(standingBand(7.4, pool(5, 6, 8))).toBe("too-few");
    // Five with him: banded.
    expect(standingBand(7.4, pool(5, 6, 8, 9))).not.toBe("too-few");
  });

  it("the best, the middle and the worst of six", () => {
    const others = [5, 6, 7, 8, 9];
    expect(standingBand(9.5, others)).toBe("top");
    expect(standingBand(8.5, others)).toBe("top"); // one above him: 1 of 6
    expect(standingBand(7.5, others)).toBe("middle"); // two above: 2 of 6
    expect(standingBand(6.5, others)).toBe("middle"); // three above: 3 of 6
    expect(standingBand(5.5, others)).toBe("bottom"); // four above: 4 of 6
    expect(standingBand(4, others)).toBe("bottom");
  });

  it("a tie counts in his favour: only players strictly above him rank higher", () => {
    // Everyone equal: nobody is above him.
    expect(standingBand(7, pool(7, 7, 7, 7, 7))).toBe("top");
    // Tied with the top two of six: still top.
    expect(standingBand(9, pool(9, 9, 5, 5, 5))).toBe("top");
  });

  it("rank, not distance: one star far above him still leaves him top third of six", () => {
    // The pool is numbers only (never names); only how many are above counts.
    expect(standingBand(6, pool(1, 2, 3, 4, 10))).toBe("top");
    expect(standingBand(2.5, pool(1, 2, 3, 4, 10))).toBe("middle");
  });
});

describe("standingPhrase: the words, in the asking club's language", () => {
  it("English, each band, with and without the shared rating", () => {
    const en = (band: Parameters<typeof standingPhrase>[1]["band"], rating: number | null = null) => standingPhrase("en", { club: "Friday MT Community", band, rating });
    expect(en("top")).toBe("Friday MT Community, top third there");
    expect(en("middle")).toBe("Friday MT Community, middle third there");
    expect(en("bottom")).toBe("Friday MT Community, bottom third there");
    expect(en("unrated")).toBe("Friday MT Community, not rated yet there");
    expect(en("too-few")).toBe("Friday MT Community, too few rated players there to rank");
    expect(en("top", 7.4)).toBe("Friday MT Community, top third there, rated 7.4");
    expect(en("too-few", 6.95)).toBe("Friday MT Community, too few rated players there to rank, rated 7.0");
  });

  it("Turkish, each band, with and without the shared rating", () => {
    const tr = (band: Parameters<typeof standingPhrase>[1]["band"], rating: number | null = null) => standingPhrase("tr", { club: "Cuma MT", band, rating });
    expect(tr("top")).toBe("Cuma MT, orada üst üçte birde");
    expect(tr("middle")).toBe("Cuma MT, orada orta üçte birde");
    expect(tr("bottom")).toBe("Cuma MT, orada alt üçte birde");
    expect(tr("unrated")).toBe("Cuma MT, orada henüz puanı yok");
    expect(tr("too-few")).toBe("Cuma MT, orada sıralamak için yeterli puanlı oyuncu yok");
    expect(tr("middle", 6.2)).toBe("Cuma MT, orada orta üçte birde, puanı 6.2");
  });

  it("an unrated guest never shows a number, even with sharing on", () => {
    expect(standingPhrase("en", { club: "X", band: "unrated", rating: 7 })).toBe("X, not rated yet there");
  });

  it("the full notice to the asking club, EN and TR", () => {
    const from = standingPhrase("en", { club: "Friday MT Community", band: "top", rating: null });
    expect(t("en").xask_vol_notice_asker({ name: "C1", from, day: "Wed 28 Oct, 20:30", bench: false })).toBe(
      "🤝 C1 (Friday MT Community, top third there) answered your ask for Wed 28 Oct, 20:30: in the squad.",
    );
    const fromShared = standingPhrase("en", { club: "Friday MT Community", band: "top", rating: 7.4 });
    expect(t("en").xask_vol_notice_asker({ name: "C1", from: fromShared, day: "Wed 28 Oct, 20:30", bench: true })).toBe(
      "🤝 C1 (Friday MT Community, top third there, rated 7.4) answered your ask for Wed 28 Oct, 20:30: on your bench for you to pick.",
    );
    const trFrom = standingPhrase("tr", { club: "Friday MT Community", band: "bottom", rating: null });
    expect(t("tr").xask_vol_notice_asker({ name: "C1", from: trFrom, day: "28 Eki Çar, 20:30", bench: false })).toBe(
      "🤝 C1 (Friday MT Community, orada alt üçte birde) 28 Eki Çar, 20:30 isteğinize yanıt verdi: kadroda.",
    );
  });
});
