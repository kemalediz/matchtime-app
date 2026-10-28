/**
 * The /admin/settings layout's words (2026-10-28), in English and Turkish:
 * the house rules every page keeps.
 */
import { describe, expect, it } from "vitest";
import { settingsNavCopy, type SettingsNavCopy } from "../settings-nav";

/** Every line, functions called with sample values, in a stable order. */
function lines(c: SettingsNavCopy): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (typeof v === "function") {
      for (const n of [0, 1, 3]) out.push(String((v as (...a: unknown[]) => unknown)(n, "Red")));
    } else if (v && typeof v === "object") for (const k of Object.keys(v).sort()) walk((v as Record<string, unknown>)[k]);
  };
  walk(c);
  return out;
}

const EN = lines(settingsNavCopy("en"));
const TR = lines(settingsNavCopy("tr"));

describe("the settings layout copy", () => {
  it("both languages have the same shape", () => {
    expect(TR.length).toBe(EN.length);
  });

  it("no em or en dash, no slash between words, never 'free', never a waiting list", () => {
    for (const l of [...EN, ...TR]) {
      expect(l).not.toMatch(/[—–]/);
      expect(l).not.toMatch(/\w\/\w/);
      expect(l).not.toMatch(/\bfree\b/i);
      expect(l).not.toMatch(/waiting list|bekleme listesi/i);
    }
  });

  it("every Turkish line differs from the English, but for the numbers and names in both", () => {
    EN.forEach((en, i) => {
      if (/^[\d\s:,.]*$/.test(en)) return;
      expect(TR[i], en).not.toBe(en);
    });
  });

  it("the box is 'Find a setting' and 'Ayar bul'; the bench is the bench", () => {
    expect(settingsNavCopy("en").find.label).toBe("Find a setting");
    expect(settingsNavCopy("tr").find.label).toBe("Ayar bul");
    expect(settingsNavCopy("en").titles.bench).toBe("Bench");
    expect(settingsNavCopy("tr").titles.bench).toBe("Yedekler");
  });

  it("an unknown language falls back to English", () => {
    expect(settingsNavCopy("de")).toBe(settingsNavCopy("en"));
  });
});
