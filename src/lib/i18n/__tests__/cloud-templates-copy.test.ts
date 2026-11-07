/**
 * The Cloud API template copy (plan MDs/whatsapp-cloud-api-plan-2026-11-04.md
 * 3.9 and 5.6) keeps the house rules every string table here keeps, plus
 * Meta's and ours for templates: no em or en dash, never "bot", no slash
 * as a separator, "bench" never "waiting list", no time-of-day greeting,
 * no variable at the very start or end of a body, variables numbered 1..n
 * with none skipped, both languages present and Turkish never the English.
 */
import { describe, expect, it } from "vitest";
import { cloudTemplatesEn } from "../cloud-templates.en";
import { cloudTemplatesTr } from "../cloud-templates.tr";

const TABLES = { en: cloudTemplatesEn, tr: cloudTemplatesTr } as const;
const NAMES = Object.keys(cloudTemplatesEn.bodies) as Array<keyof typeof cloudTemplatesEn.bodies>;
const LABELS = Object.keys(cloudTemplatesEn.buttons) as Array<keyof typeof cloudTemplatesEn.buttons>;

const varsOf = (body: string) => [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));

describe("cloud template copy: complete and translated", () => {
  it("every body and button label exists in both languages", () => {
    expect(Object.keys(cloudTemplatesTr.bodies).sort()).toEqual([...NAMES].sort());
    expect(Object.keys(cloudTemplatesTr.buttons).sort()).toEqual([...LABELS].sort());
  });

  it("no Turkish body or label is the English text", () => {
    expect(NAMES.filter((n) => cloudTemplatesTr.bodies[n] === cloudTemplatesEn.bodies[n])).toEqual([]);
    expect(LABELS.filter((k) => cloudTemplatesTr.buttons[k] === cloudTemplatesEn.buttons[k])).toEqual([]);
  });

  it("each body uses the same variables in both languages", () => {
    const differ = NAMES.filter((n) => [...new Set(varsOf(cloudTemplatesEn.bodies[n]))].sort().join() !== [...new Set(varsOf(cloudTemplatesTr.bodies[n]))].sort().join());
    expect(differ).toEqual([]);
  });

  it("the parts a variable is filled with differ by language", () => {
    expect(cloudTemplatesTr.parts.places(2)).not.toBe(cloudTemplatesEn.parts.places(2));
    expect(cloudTemplatesTr.parts.length(60)).not.toBe(cloudTemplatesEn.parts.length(60));
    expect(cloudTemplatesEn.parts.places(1)).toBe("1 player");
    expect(cloudTemplatesEn.parts.places(2)).toBe("2 players");
  });
});

describe("cloud template copy: house rules", () => {
  for (const [lang, table] of Object.entries(TABLES)) {
    const bodies = NAMES.map((n) => [n, table.bodies[n]] as const);
    const labels = LABELS.map((k) => [k, table.buttons[k]] as const);
    const all = [...bodies, ...labels];

    it(`${lang}: no em or en dash, nothing empty`, () => {
      expect(all.filter(([, s]) => /[\u2013\u2014]/.test(s)).map(([k]) => k)).toEqual([]);
      expect(all.filter(([, s]) => !s.trim()).map(([k]) => k)).toEqual([]);
    });

    it(`${lang}: never "bot", never "bulk"`, () => {
      expect(all.filter(([, s]) => /\bbots?\b|\bbulk\b/i.test(s)).map(([k]) => k)).toEqual([]);
    });

    it(`${lang}: no slash as a separator`, () => {
      expect(all.filter(([, s]) => s.includes("/")).map(([k]) => k)).toEqual([]);
    });

    it(`${lang}: bench, never a waiting list; no greeting`, () => {
      expect(all.filter(([, s]) => /waiting list|bekleme listesi/i.test(s)).map(([k]) => k)).toEqual([]);
      expect(all.filter(([, s]) => /good (morning|afternoon|evening)|günaydın|iyi akşamlar|tünaydın/i.test(s)).map(([k]) => k)).toEqual([]);
    });

    it(`${lang}: no variable at the very start or end of a body (formatting and punctuation aside)`, () => {
      const atStart = bodies.filter(([, s]) => /^[\s*_~]*\{\{\d+\}\}/.test(s)).map(([k]) => k);
      const atEnd = bodies.filter(([, s]) => /\{\{\d+\}\}[\s*_~.!?,:;]*$/.test(s)).map(([k]) => k);
      expect({ atStart, atEnd }).toEqual({ atStart: [], atEnd: [] });
    });

    it(`${lang}: variables are numbered 1..n, none skipped, no two side by side`, () => {
      const bad = bodies.filter(([, s]) => {
        const seen = [...new Set(varsOf(s))].sort((a, b) => a - b);
        return seen.some((v, i) => v !== i + 1) || /\}\}\s*\{\{/.test(s);
      });
      expect(bad.map(([k]) => k)).toEqual([]);
    });

    it(`${lang}: within Meta's limits (body 1024 characters, button 25)`, () => {
      expect(bodies.filter(([, s]) => s.length > 1024).map(([k]) => k)).toEqual([]);
      expect(labels.filter(([, s]) => s.length > 25).map(([k]) => k)).toEqual([]);
    });
  }
});
