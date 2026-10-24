/**
 * The pool's no-show, block and report copy (slice L7) keeps the house
 * rules: complete in both languages, Turkish never the English text, no em
 * or en dash, "bench" never "waiting list", no time-of-day greeting, every
 * argument used. And the neutral rule: nothing tells one side who blocked
 * or reported, or why a club let him go.
 */
import { describe, expect, it } from "vitest";
import { poolSafetyEn } from "../pool-safety.en";
import { POOL_SAFETY_TABLES, poolSafetyCopy } from "../pool-safety";

type Entry = string | ((p: Record<string, unknown>) => string);

const SAMPLE: Record<string, unknown> = { n: 2, games: 5, days: 30, link: "https://matchtime.ai/x", club: "FNF", day: "Tue 3 Nov, 20:00", until: "Wed 4 Nov, 20:00", played: 4, from: "3 December" };
const render = (e: Entry): string => (typeof e === "function" ? e(SAMPLE) : e);
const KEYS = Object.keys(poolSafetyEn);

describe("pool safety copy: complete and translated", () => {
  it("every key exists in every table", () => {
    for (const table of Object.values(POOL_SAFETY_TABLES)) expect(Object.keys(table).sort()).toEqual([...KEYS].sort());
  });
  it("no Turkish entry renders to the English text", () => {
    const same = KEYS.filter((k) => render((POOL_SAFETY_TABLES.tr as unknown as Record<string, Entry>)[k]) === render((poolSafetyEn as unknown as Record<string, Entry>)[k]));
    expect(same).toEqual([]);
  });
  it("anything unknown is English", () => {
    expect(poolSafetyCopy("de")).toBe(poolSafetyEn);
    expect(poolSafetyCopy("TR")).toBe(POOL_SAFETY_TABLES.tr);
  });
});

describe("pool safety copy: hygiene", () => {
  for (const [lang, table] of Object.entries(POOL_SAFETY_TABLES)) {
    const texts = KEYS.map((k) => [k, render((table as unknown as Record<string, Entry>)[k])] as const);
    it(`${lang}: no em or en dash, nothing empty, no waiting list, no greeting`, () => {
      expect(texts.filter(([, s]) => /[\u2013\u2014]/.test(s)).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => !s.trim()).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => /waiting list|bekleme listesi/i.test(s)).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => /^(good (morning|afternoon|evening)|günaydın|iyi akşamlar)/i.test(s)).map(([k]) => k)).toEqual([]);
    });
  }

  it("the removal DM is neutral: it never says he was removed, blocked or reported", () => {
    for (const table of Object.values(POOL_SAFETY_TABLES)) {
      expect(render(table.dm_removed as Entry)).not.toMatch(/remov|block|report|kaldır|engel|şikayet/i);
    }
  });

  it("every parameterised entry uses every argument it names (EN source)", () => {
    const unused = Object.entries(poolSafetyEn)
      .filter(([, v]) => typeof v === "function")
      .flatMap(([k, v]) => {
        const code = String(v);
        const m = /\(p:\s*\{([^}]*)\}/.exec(code);
        if (!m) return [];
        return m[1]
          .split(";")
          .map((x) => x.split(":")[0].trim())
          .filter(Boolean)
          .filter((n) => !new RegExp(`p\\.${n}\\b`).test(code))
          .map((n) => `${k}.${n}`);
      });
    expect(unused).toEqual([]);
  });
});
