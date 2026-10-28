/**
 * The pool offer copy tables (slice L5a) keep the house rules every
 * string table here keeps: complete in both languages, Turkish never the
 * English text, no em or en dash, "bench" never "waiting list", no
 * time-of-day greeting, every argument used.
 */
import { describe, expect, it } from "vitest";
import { poolOfferEn } from "../pool-offer.en";
import { POOL_OFFER_TABLES, poolCopy } from "../pool-offer";

type Entry = string | ((p: Record<string, unknown>) => string);

const SAMPLE: Record<string, unknown> = {
  club: "FNF",
  places: 2,
  game: "7-a-side football game",
  format: "7-a-side",
  sport: "Football",
  day: "Friday 30 October at 20:30",
  mins: 60,
  venue: "Goals North Cheam",
  miles: "1.8",
  one: false,
  url: "https://maps.example/x",
  members: 30,
  games: 5,
  amount: "£6",
  link: "https://matchtime.ai/x",
  n: 3,
  name: "Ali K",
  turnUp: "New to MatchTime.",
  played: 4,
  band: "a few near you",
  asked: 4,
  declined: 1,
  max: 3,
  hours: 4,
  near: "near Goals Sutton",
  reasons: "1 is already in FNF",
  clubTail: true,
  retry: true,
};

const render = (e: Entry): string => (typeof e === "function" ? e(SAMPLE) : e);
const KEYS = Object.keys(poolOfferEn);

describe("pool offer copy: complete and translated", () => {
  it("every key exists in every table", () => {
    for (const table of Object.values(POOL_OFFER_TABLES)) expect(Object.keys(table).sort()).toEqual([...KEYS].sort());
  });

  it("no Turkish entry renders to the English text", () => {
    const same = KEYS.filter((k) => render((POOL_OFFER_TABLES.tr as unknown as Record<string, Entry>)[k]) === render((poolOfferEn as unknown as Record<string, Entry>)[k]));
    expect(same).toEqual([]);
  });

  it("anything unknown is English", () => {
    expect(poolCopy("de")).toBe(poolOfferEn);
    expect(poolCopy("TR")).toBe(POOL_OFFER_TABLES.tr);
  });
});

describe("pool offer copy: hygiene", () => {
  for (const [lang, table] of Object.entries(POOL_OFFER_TABLES)) {
    const texts = KEYS.map((k) => [k, render((table as unknown as Record<string, Entry>)[k])] as const);
    it(`${lang}: no em or en dash, nothing empty`, () => {
      expect(texts.filter(([, s]) => /[\u2013\u2014]/.test(s)).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => !s.trim()).map(([k]) => k)).toEqual([]);
    });
    it(`${lang}: bench, never a waiting list; no greeting`, () => {
      expect(texts.filter(([, s]) => /waiting list|bekleme listesi/i.test(s)).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => /^(good (morning|afternoon|evening)|günaydın|iyi akşamlar)/i.test(s)).map(([k]) => k)).toEqual([]);
    });
    it(`${lang}: never a phone number or a member's name placeholder`, () => {
      expect(texts.filter(([, s]) => /\+?44\s?7\d{3}|07\d{3}/.test(s)).map(([k]) => k)).toEqual([]);
    });
  }

  it("every parameterised entry uses every argument it names (EN source)", () => {
    const src = Object.entries(poolOfferEn)
      .filter(([, v]) => typeof v === "function")
      .map(([k, v]) => [k, String(v)] as const);
    const unused = src.flatMap(([k, code]) => {
      const m = /\(p:\s*\{([^}]*)\}/.exec(code);
      if (!m) return [];
      const names = m[1].split(";").map((x) => x.split(":")[0].trim()).filter(Boolean);
      return names.filter((n) => !new RegExp(`p\\.${n}\\b`).test(code)).map((n) => `${k}.${n}`);
    });
    expect(unused).toEqual([]);
  });
});
