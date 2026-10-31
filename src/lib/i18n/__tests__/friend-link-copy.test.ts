/**
 * The friend link's copy keeps the house rules: complete in both languages,
 * Turkish never the English text, no em or en dash, no slash separators,
 * "bench" or "yedek" never "waiting list", no time-of-day greeting.
 */
import { describe, expect, it } from "vitest";
import { friendLinkEn } from "../friend-link.en";
import { FRIEND_LINK_TABLES, friendLinkCopy } from "../friend-link";

type Entry = string | ((p: Record<string, unknown>) => string);
const SAMPLE: Record<string, unknown> = { friend: "Ali", club: "Sutton FC", day: "Mon 2 Nov, 20:00", venue: "Goals Sutton", member: "Shane", n: 1, link: "https://matchtime.ai/play/f/x.y", amount: "£6", name: "Ali Y." };
const render = (e: Entry): string => (typeof e === "function" ? e(SAMPLE) : e);
const KEYS = Object.keys(friendLinkEn);

describe("friend link copy", () => {
  it("every key in every table", () => {
    for (const table of Object.values(FRIEND_LINK_TABLES)) expect(Object.keys(table).sort()).toEqual([...KEYS].sort());
  });
  it("Turkish is never the English text", () => {
    const tr = FRIEND_LINK_TABLES.tr as unknown as Record<string, Entry>;
    const en = friendLinkEn as unknown as Record<string, Entry>;
    // A numbered link line with a name in it reads the same in both.
    const neutral = ["member_link_line"];
    expect(KEYS.filter((k) => !neutral.includes(k) && render(tr[k]) === render(en[k]))).toEqual([]);
    expect((tr.member_link_line as (p: Record<string, unknown>) => string)({ n: 1, friend: null, link: "x" })).toBe("1. Arkadaş: x");
  });
  it("anything unknown is English", () => {
    expect(friendLinkCopy("de")).toBe(friendLinkEn);
    expect(friendLinkCopy("TR")).toBe(FRIEND_LINK_TABLES.tr);
  });
  for (const [lang, table] of Object.entries(FRIEND_LINK_TABLES)) {
    it(`${lang}: hygiene`, () => {
      const texts = KEYS.map((k) => [k, render((table as unknown as Record<string, Entry>)[k])] as const);
      expect(texts.filter(([, s]) => /[–—]/.test(s)).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => / \/ /.test(s)).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => !s.trim()).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => /waiting list|bekleme listesi/i.test(s)).map(([k]) => k)).toEqual([]);
      expect(texts.filter(([, s]) => /good (morning|afternoon|evening)|günaydın|iyi akşamlar/i.test(s)).map(([k]) => k)).toEqual([]);
    });
  }
  it("the bench is called the bench, and yedek", () => {
    expect(render(friendLinkEn.group_bench as Entry)).toMatch(/bench/);
    expect(render(FRIEND_LINK_TABLES.tr.group_bench as Entry)).toMatch(/yedek/);
  });
});
