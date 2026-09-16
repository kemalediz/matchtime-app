/**
 * The string-table MECHANISM, proven before any string moves into it.
 *
 * Phase 0 of MDs/multi-language-design-2026-09-16.md ships the table
 * with exactly one probe entry. These tests pin the contract the later
 * phases build on, so that when Phase 2 moves a hundred strings in, the
 * rules are already enforced:
 *
 *   1. completeness: every key in `en` exists in every other table and
 *      no table carries a key `en` does not (belt and braces over the
 *      `: Strings` type check; it also catches an `any`);
 *   2. hygiene: no entry returns an empty string, and no Turkish entry
 *      contains an em dash or an en dash (house style). The English
 *      table is NOT held to the dash rule: existing English copy uses
 *      em dashes and must move in byte for byte (the golden snapshot
 *      decides English bytes, not this file);
 *   3. resolution: `t()` maps a code to its table, forgives case, region
 *      suffixes and whitespace, and falls back to English for anything
 *      it does not ship.
 */
import { describe, it, expect } from "vitest";
import { en } from "../strings.en";
import { tr } from "../strings.tr";
import { t } from "../t";
import { LANGS, LANG_LABELS, DEFAULT_LANG, isLang, normaliseLang } from "../lang";

const TABLES = { en, tr } as const;

/** Render an entry with a throwaway argument so it can be inspected. */
function render(entry: unknown): string {
  if (typeof entry === "function") {
    return (entry as (p: Record<string, string>) => string)({ name: "Probe" });
  }
  return String(entry);
}

describe("string tables: completeness", () => {
  it("ships a table for every language in LANGS, and nothing else", () => {
    expect(Object.keys(TABLES).sort()).toEqual([...LANGS].sort());
  });

  it("every key in en exists in every other table, and vice versa", () => {
    const enKeys = Object.keys(en).sort();
    for (const lang of LANGS) {
      const keys = Object.keys(TABLES[lang]).sort();
      expect(keys, `keys of ${lang}`).toEqual(enKeys);
    }
  });

  it("every entry is a function or a string, in every table", () => {
    for (const lang of LANGS) {
      for (const [key, entry] of Object.entries(TABLES[lang])) {
        expect(
          typeof entry === "function" || typeof entry === "string",
          `${lang}.${key} must be a function or a string`,
        ).toBe(true);
      }
    }
  });
});

describe("string tables: hygiene", () => {
  it("no entry renders to an empty string", () => {
    for (const lang of LANGS) {
      for (const [key, entry] of Object.entries(TABLES[lang])) {
        expect(render(entry).trim().length, `${lang}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("no Turkish entry contains an em dash or an en dash", () => {
    for (const [key, entry] of Object.entries(tr)) {
      expect(render(entry), `tr.${key}`).not.toMatch(/[—–]/);
    }
  });

  it("no entry in any table opens with a time-of-day greeting", () => {
    const greeting = /^(?:\W*)(?:good\s+)?(?:morning|afternoon|evening)\b|^(?:\W*)(?:günaydın|iyi akşamlar|iyi günler)\b/iu;
    for (const lang of LANGS) {
      for (const [key, entry] of Object.entries(TABLES[lang])) {
        expect(render(entry), `${lang}.${key}`).not.toMatch(greeting);
      }
    }
  });
});

describe("t(): resolution", () => {
  it("returns the English table for 'en' and the Turkish table for 'tr'", () => {
    expect(t("en")).toBe(en);
    expect(t("tr")).toBe(tr);
  });

  it("the probe entry is wired end to end", () => {
    expect(t("en").probe({ name: "Kemal" })).toBe("Hello Kemal, this is MatchTime.");
  });

  it("Phase 0: the Turkish table returns the English (nothing is translated yet)", () => {
    // Deliberately pinned. When Phase 2 lands the first real Turkish
    // entry this assertion is REPLACED by the Turkish golden snapshot,
    // not loosened.
    expect(t("tr").probe({ name: "Kemal" })).toBe(t("en").probe({ name: "Kemal" }));
  });

  it("falls back to English for anything the product does not ship", () => {
    expect(t("fr")).toBe(en);
    expect(t("")).toBe(en);
    expect(t(null)).toBe(en);
    expect(t(undefined)).toBe(en);
    expect(t("xx-YY")).toBe(en);
  });

  it("forgives case, region suffixes and whitespace", () => {
    expect(t("TR")).toBe(tr);
    expect(t(" tr ")).toBe(tr);
    expect(t("tr-TR")).toBe(tr);
    expect(t("tr_TR")).toBe(tr);
    expect(t("en-GB")).toBe(en);
  });
});

describe("lang helpers", () => {
  it("DEFAULT_LANG is English", () => {
    expect(DEFAULT_LANG).toBe("en");
  });

  it("normaliseLang mirrors t()'s rules and never returns an unknown code", () => {
    expect(normaliseLang("tr")).toBe("tr");
    expect(normaliseLang("TR")).toBe("tr");
    expect(normaliseLang("tr-TR")).toBe("tr");
    expect(normaliseLang("en")).toBe("en");
    expect(normaliseLang("de")).toBe("en");
    expect(normaliseLang(null)).toBe("en");
    expect(normaliseLang(undefined)).toBe("en");
    expect(normaliseLang("")).toBe("en");
    expect(normaliseLang("   ")).toBe("en");
  });

  it("isLang is strict (no normalisation)", () => {
    expect(isLang("tr")).toBe(true);
    expect(isLang("TR")).toBe(false);
    expect(isLang("fr")).toBe(false);
    expect(isLang(null)).toBe(false);
    expect(isLang(3)).toBe(false);
  });

  it("every shipped language has a picker label", () => {
    for (const lang of LANGS) {
      expect(LANG_LABELS[lang].trim().length).toBeGreaterThan(0);
    }
  });
});
