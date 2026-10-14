import { describe, expect, it } from "vitest";
import { captionLooksAboutGame, PICTURE_CAPTION_WORDS } from "../picture-words";

describe("captionLooksAboutGame: the caption half of the picture filter", () => {
  it.each([
    "Friday list",
    "Squad for Thursday",
    "Teams for tonight",
    "Team sheet",
    "Line-up",
    "lineup v Harris",
    "Final score",
    "Result from last night",
    "Fixtures",
    "This week's players",
    "Kick off 8:30",
  ])("English game caption %j qualifies", (caption) => {
    expect(captionLooksAboutGame(caption)).toBe(true);
  });

  it.each([
    "Cuma listesi",
    "KADRO",
    "Takımlar belli oldu",
    "Takimlar",
    "Maç sonucu",
    "Skor 5-3",
    "Bu haftanın oyuncuları",
    "Halı saha 20:30",
    "İlk 11",
  ])("Turkish game caption %j qualifies", (caption) => {
    expect(captionLooksAboutGame(caption)).toBe(true);
  });

  it.each([
    "",
    "   ",
    null,
    undefined,
    "lol",
    "😂😂😂",
    "Happy birthday mate",
    "look at this dog",
    "playlist for the car", // "list" inside a word is not a list
    "teammate of the year", // "team" inside a word
    "steam deck",
    "doğum günün kutlu olsun",
  ])("non-game caption %j does not qualify", (caption) => {
    expect(captionLooksAboutGame(caption as string | null | undefined)).toBe(false);
  });

  it("keeps the word list in this one module, English and Turkish", () => {
    expect(PICTURE_CAPTION_WORDS.en.length).toBeGreaterThan(5);
    expect(PICTURE_CAPTION_WORDS.tr.length).toBeGreaterThan(5);
  });

  it("does not read a caption longer than it needs to (a pasted essay is still checked, not thrown on)", () => {
    expect(captionLooksAboutGame("x ".repeat(10_000) + "squad")).toBe(false);
    expect(captionLooksAboutGame("squad " + "x ".repeat(10_000))).toBe(true);
  });
});
