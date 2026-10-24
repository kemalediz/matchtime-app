/**
 * The joining-a-group copy (pool L8) keeps the house rules: complete in
 * both languages, Turkish never the English text, no em or en dash, no
 * greeting, never a number, every argument used, and the invite link in ONE
 * message only.
 */
import { describe, expect, it } from "vitest";
import { poolInviteEn } from "../pool-invite.en";
import { POOL_INVITE_TABLES, inviteCopy } from "../pool-invite";

type Entry = string | ((p: Record<string, unknown>) => string);
const SAMPLE: Record<string, unknown> = { club: "FNF", day: "Tuesday 27 October", link: "https://matchtime.ai/x", name: "Sam K", n: 2, time: "18:00" };
const render = (e: Entry): string => (typeof e === "function" ? e(SAMPLE) : e);
const KEYS = Object.keys(poolInviteEn);

describe("pool invite copy: complete and translated", () => {
  it("every key exists in every table", () => {
    for (const table of Object.values(POOL_INVITE_TABLES)) expect(Object.keys(table).sort()).toEqual([...KEYS].sort());
  });
  it("no Turkish entry renders to the English text", () => {
    const same = KEYS.filter((k) => render((POOL_INVITE_TABLES.tr as unknown as Record<string, Entry>)[k]) === render((poolInviteEn as unknown as Record<string, Entry>)[k]));
    expect(same).toEqual([]);
  });
  it("anything unknown is English", () => {
    expect(inviteCopy("de")).toBe(poolInviteEn);
    expect(inviteCopy("TR")).toBe(POOL_INVITE_TABLES.tr);
  });
});

describe("pool invite copy: hygiene", () => {
  for (const [lang, table] of Object.entries(POOL_INVITE_TABLES)) {
    const texts = KEYS.map((k) => [k, render((table as unknown as Record<string, Entry>)[k])] as const);
    it(`${lang}: no em or en dash, nothing empty, no greeting, no number`, () => {
      expect(texts.filter(([, s]) => /[\u2013\u2014]/.test(s)).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => !s.trim()).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => /^(good (morning|afternoon|evening)|günaydın|iyi akşamlar)/i.test(s)).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => /\+?44\s?7\d{3}|07\d{3}/.test(s)).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => /waiting list|bekleme listesi/i.test(s)).map(([k]) => k)).toEqual([]);
    });
  }

  it("every parameterised entry uses every argument it names (EN source)", () => {
    const unused = Object.entries(poolInviteEn)
      .filter(([, v]) => typeof v === "function")
      .flatMap(([k, v]) => {
        const code = String(v);
        const m = /\(p:\s*\{([^}]*)\}/.exec(code);
        if (!m) return [];
        return m[1].split(";").map((x) => x.split(":")[0].trim()).filter(Boolean).filter((n) => !new RegExp(`p\\.${n}\\b`).test(code)).map((n) => `${k}.${n}`);
      });
    expect(unused).toEqual([]);
  });

  it("the guest DMs name the club, never a person", () => {
    for (const table of Object.values(POOL_INVITE_TABLES)) {
      for (const k of ["ask_after_game", "ask_organiser", "link_dm", "closed_dm"] as const) {
        const s = render(table[k] as Entry);
        expect(s).toContain("FNF");
        expect(s).not.toContain("Sam K");
      }
    }
  });
});
