/**
 * The literal-colour half of the colour-swap fast path, as a pure
 * function. It was a private helper in `api/whatsapp/analyze/route.ts`
 * until 2026-09-17, when the Turkish forms went in and it needed a
 * test of its own; `route.ts` now imports it from `lib/colour-swap-
 * phrase.ts` and calls it exactly as before.
 *
 * Two languages, one property: a message that asks for the two SIDES to
 * change colour is recognised, and a message that names players, teams
 * or nothing is not. The English cases are the shipped regexes' own
 * behaviour, pinned here so the Turkish additions cannot move them.
 */
import { describe, it, expect } from "vitest";
import { hasSwapVerb, looksLikeColourSwapPhrase } from "../colour-swap-phrase";

describe("looksLikeColourSwapPhrase: English (unchanged)", () => {
  it.each([
    "@Match Time swap the colors and keep the same squad",
    "swap the colours",
    "flip colours please",
    "can you switch the colours round",
    "colours swap please",
    "swap red and yellow",
    "swap the reds and yellows",
  ])("recognises %s", (body) => {
    expect(looksLikeColourSwapPhrase(body)).toBe(true);
  });

  it.each([
    "swap Elvin with Raihan",
    "swap the teams please",
    "my red Arsenal shirt",
    "generate the teams",
    "what colour are we",
    // The shipped limit, pinned as it is: the verb must be the bare
    // form ("swapped" is not `\bswap\b`). Widening it is a separate
    // change with its own measurement, not a side effect of Turkish.
    "colours swapped please",
  ])("declines %s", (body) => {
    expect(looksLikeColourSwapPhrase(body)).toBe(false);
  });
});

describe("looksLikeColourSwapPhrase: Turkish (2026-09-17)", () => {
  // The chosen typed form is "renkleri değiştir"; the labels a Turkish
  // org is shown are "Kırmızı" / "Sarı" (`team-labels.ts`), so naming
  // them with any suffix is the second form. A dotless ı typed as a
  // plain i from an English keyboard must read the same.
  it.each([
    "@Match Time renkleri değiştir",
    "renkleri değiştir",
    "renkleri değiştirin",
    "renkleri ters çevir",
    "renkler değişsin",
    "takım renklerini değiştir",
    "kırmızıyla sarıyı değiştir",
    "kırmızı ile sarıyı değiştir",
    "Kırmızı ile Sarı'yı değiştir",
    "sarıyla kırmızıyı değiştir",
    "kirmiziyla sariyi degistir",
    "renkleri DEĞİŞTİR",
  ])("recognises %s", (body) => {
    expect(looksLikeColourSwapPhrase(body)).toBe(true);
  });

  it.each([
    // Two players, not two colours: the player-swap parser's job.
    "Ali ile Can'ı değiştir",
    // The teams, not the colours.
    "takımları değiştir",
    "takımları kur",
    // A colour mentioned with no swap verb.
    "kırmızı forma getirin",
    "sarı takım kazandı",
    "renkler güzel olmuş",
  ])("declines %s", (body) => {
    expect(looksLikeColourSwapPhrase(body)).toBe(false);
  });
});

describe("hasSwapVerb", () => {
  it.each(["swap them", "flip it", "değiştir", "değiştirin", "yer değiştirsin", "ters çevir", "takas"])(
    "sees a swap verb in %s",
    (body) => expect(hasSwapVerb(body)).toBe(true),
  );
  it.each(["generate the teams", "takımları kur", "kim var"])("sees none in %s", (body) =>
    expect(hasSwapVerb(body)).toBe(false),
  );
});
