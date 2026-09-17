/**
 * The colour swap's deterministic pre-peel, in English and Turkish.
 *
 * A colour swap flips the two labels and keeps the line-ups. If this
 * detector misses one, the message reaches the router and the teams
 * extractor, and the 2026-06-09 incident ("swap the colours and keep the
 * same teams" ran a full regen on a match night) is one misreading away.
 * The Turkish group is told to type "@Match Time renkleri değiştir"
 * (`strings.tr.ts`); a Turkish org's default labels are Kırmızı / Sarı.
 */
import { describe, it, expect } from "vitest";
import { looksLikeColourSwapPhrase, looksLikeLabelSwapPhrase } from "../team-colour-swap";

describe("looksLikeColourSwapPhrase: English (unchanged by the Turkish additions)", () => {
  const YES = [
    "@Match Time swap the colors and keep the same squad",
    "swap the colours",
    "flip colours please",
    "colours swap",
    "@Match Time swap red and yellow",
    "swap reds and yellows",
  ];
  for (const body of YES) it(`reads "${body}"`, () => expect(looksLikeColourSwapPhrase(body)).toBe(true));

  const NO = [
    "swap Elvin with Raihan",
    "generate the teams",
    "nice colours on the new kit",
    "I'm in, red team please",
  ];
  for (const body of NO) it(`declines "${body}"`, () => expect(looksLikeColourSwapPhrase(body)).toBe(false));
});

describe("looksLikeColourSwapPhrase: Turkish", () => {
  const YES = [
    // The chosen form, as the copy prints it.
    "@Match Time renkleri değiştir",
    // Typed from an English keyboard, and in capitals (Turkish İ and I).
    "@Match Time renkleri degistir",
    "@MATCH TIME RENKLERİ DEĞİŞTİR",
    "@Match Time renkleri değiştirir misin",
    "@Match Time renkleri ters çevir",
    // By label: the Turkish defaults are Kırmızı / Sarı.
    "@Match Time kırmızıyla sarıyı değiştir",
    "@Match Time Kırmızı ile Sarı'yı değiştir",
    "@Match Time sarıyla kırmızıyı değiştir",
    "@Match Time kirmiziyla sariyi degistir",
    "@Match Time KIRMIZI ve SARI takımları değiştir",
  ];
  for (const body of YES) it(`reads "${body}"`, () => expect(looksLikeColourSwapPhrase(body)).toBe(true));

  const NO = [
    // Chat about colours with no instruction.
    "renkler çok güzel olmuş",
    // A NEGATED instruction: "do not change the colours".
    "@Match Time renkleri değiştirme",
    // A player swap, which the swap parser owns.
    "@Match Time David ile Ali'yi değiştir",
    // Generating and showing are not colour swaps.
    "@Match Time takımları kur",
    "@Match Time takımları göster",
    // A colour on its own, a card, a verb about something else.
    "kırmızı kart gördü",
    "@Match Time maç saatini değiştir",
    // Colours are named but nothing is asked.
    "kırmızı ve sarı formalar geldi",
  ];
  for (const body of NO) it(`declines "${body}"`, () => expect(looksLikeColourSwapPhrase(body)).toBe(false));
});

describe("looksLikeLabelSwapPhrase: an org's own labels", () => {
  it("reads the English form with custom labels", () => {
    expect(looksLikeLabelSwapPhrase("@Match Time swap Bibs and Skins", ["Bibs", "Skins"])).toBe(true);
  });
  it("reads the Turkish form with custom labels", () => {
    expect(looksLikeLabelSwapPhrase("@Match Time Aslanlar ile Kartallar'ı değiştir", ["Aslanlar", "Kartallar"])).toBe(true);
  });
  it("declines when only one label is named", () => {
    expect(looksLikeLabelSwapPhrase("@Match Time swap Bibs with David", ["Bibs", "Skins"])).toBe(false);
  });
  it("declines a negated Turkish instruction", () => {
    expect(looksLikeLabelSwapPhrase("Aslanlar ile Kartallar'ı değiştirme", ["Aslanlar", "Kartallar"])).toBe(false);
  });
  it("declines when the org has no two custom labels", () => {
    expect(looksLikeLabelSwapPhrase("swap Bibs and Skins", ["Bibs"])).toBe(false);
  });
  it("ignores the English defaults, which the literal detector already owns", () => {
    expect(looksLikeLabelSwapPhrase("swap red and yellow", ["Red", "Yellow"])).toBe(false);
  });
});
