/**
 * Reading a bundled TrueType font's widths, so a name on a club's graphics
 * template can be shrunk to fit its row before it is drawn.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readFontMetrics, textWidth } from "../font-metrics";

const FONT = readFileSync(path.join(process.cwd(), "assets", "fonts", "BarlowSemiCondensed-BlackItalic.ttf"));
const m = readFontMetrics(FONT);

describe("readFontMetrics", () => {
  it("reads the units per em, the vertical metrics and the cap height", () => {
    expect(m.unitsPerEm).toBe(1000);
    expect(m.ascender).toBeGreaterThan(800);
    expect(m.descender).toBeLessThan(0);
    expect(m.capHeight).toBeGreaterThan(600);
    expect(m.capHeight).toBeLessThan(m.ascender);
  });

  it("knows the advance of capitals, digits and Turkish letters", () => {
    for (const ch of ["A", "W", "I", "0", "Ş", "İ", "Ğ", "Ü", "Ç", "Ö"]) {
      expect(m.advance(ch.codePointAt(0)!), ch).toBeGreaterThan(0);
    }
    expect(m.advance("W".codePointAt(0)!)!).toBeGreaterThan(m.advance("I".codePointAt(0)!)!);
  });

  it("has no advance for a character the font lacks", () => {
    expect(m.advance(0x0416)).toBeUndefined(); // Cyrillic Zhe
  });

  it("refuses something that is not a TrueType font", () => {
    expect(() => readFontMetrics(Buffer.from("not a font at all, really not"))).toThrow();
  });
});

describe("textWidth", () => {
  it("adds advances and scales by the font size", () => {
    const a = m.advance(65)!;
    expect(textWidth(m, "AA", 100)).toBeCloseTo((2 * a * 100) / 1000, 5);
    expect(textWidth(m, "AA", 50)).toBeCloseTo(textWidth(m, "AA", 100) / 2, 5);
  });

  it("counts a character the font lacks at a generous fallback width", () => {
    expect(textWidth(m, "Ж", 100)).toBeCloseTo(70, 5);
  });

  it("is zero for empty text", () => {
    expect(textWidth(m, "", 40)).toBe(0);
  });
});
