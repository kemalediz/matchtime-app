/**
 * The partner pool invite's copy (2026-11-02) keeps the house rules:
 * complete in both languages, Turkish never the English text, no em or en
 * dash, no slash as a separator, no greeting, never a number, "bench" never
 * "waiting list", every argument used. The DM names the club that was
 * played for, carries the link, and never makes joining sound required.
 */
import { describe, expect, it } from "vitest";
import { poolPartnerInviteEn } from "../pool-partner-invite.en";
import { POOL_PARTNER_INVITE_TABLES, partnerInviteCopy } from "../pool-partner-invite";

type Entry = string | ((p: Record<string, unknown>) => string);
const SAMPLE: Record<string, unknown> = { club: "Sutton Football Club", link: "https://matchtime.ai/play/j/abc", name: "Sam K", tail: "1234" };
const render = (e: Entry): string => (typeof e === "function" ? e(SAMPLE) : e);
const KEYS = Object.keys(poolPartnerInviteEn);

describe("partner pool invite copy: complete and translated", () => {
  it("every key exists in every table", () => {
    for (const table of Object.values(POOL_PARTNER_INVITE_TABLES)) expect(Object.keys(table).sort()).toEqual([...KEYS].sort());
  });
  it("no Turkish entry renders to the English text", () => {
    const same = KEYS.filter((k) => render((POOL_PARTNER_INVITE_TABLES.tr as unknown as Record<string, Entry>)[k]) === render((poolPartnerInviteEn as unknown as Record<string, Entry>)[k]));
    expect(same).toEqual([]);
  });
  it("anything unknown is English", () => {
    expect(partnerInviteCopy("de")).toBe(poolPartnerInviteEn);
    expect(partnerInviteCopy("TR")).toBe(POOL_PARTNER_INVITE_TABLES.tr);
  });
});

describe("partner pool invite copy: hygiene", () => {
  for (const [lang, table] of Object.entries(POOL_PARTNER_INVITE_TABLES)) {
    const texts = KEYS.map((k) => [k, render((table as unknown as Record<string, Entry>)[k])] as const);
    it(`${lang}: no em or en dash, no separator slash, nothing empty, no greeting, no number, no waiting list`, () => {
      expect(texts.filter(([, s]) => /[\u2013\u2014]/.test(s)).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => /\s\/\s|\w\/\w/.test(s.replace(/https?:\/\/\S+/g, ""))).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => !s.trim()).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => /^(hi|hello|good (morning|afternoon|evening)|merhaba|günaydın|iyi akşamlar)/i.test(s)).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => /\+?44\s?7\d{3}|07\d{3}/.test(s)).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => /waiting list|bekleme listesi/i.test(s)).map(([k]) => k)).toEqual([]);
    });
    it(`${lang}: the DM thanks him for the club he played for and carries his link, as the last thing`, () => {
      const dm = table.dm({ club: "Sutton Football Club", link: "https://matchtime.ai/play/j/abc" });
      expect(dm).toContain("*Sutton Football Club*");
      expect(dm.endsWith("https://matchtime.ai/play/j/abc")).toBe(true);
      expect(dm).not.toMatch(/must|have to|required|zorunlu|gerek/i);
    });
  }

  it("every parameterised entry uses every argument it names (EN source)", () => {
    const unused = Object.entries(poolPartnerInviteEn)
      .filter(([, v]) => typeof v === "function")
      .flatMap(([k, v]) => {
        const code = String(v);
        const m = /\(p:\s*\{([^}]*)\}/.exec(code);
        if (!m) return [];
        return m[1].split(";").map((x) => x.split(":")[0].trim()).filter(Boolean).filter((n) => !new RegExp(`p\\.${n}\\b`).test(code)).map((n) => `${k}.${n}`);
      });
    expect(unused).toEqual([]);
  });
});
