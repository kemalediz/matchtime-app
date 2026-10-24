/**
 * A club's share post and its settings card (slice G3), in English and
 * Turkish: the house rules every pool page keeps, and what the post must
 * say (what the pool is, opt in from the profile, share your own link).
 */
import { describe, expect, it } from "vitest";
import { poolClubShareCopy, type PoolClubShareCopy } from "@/lib/i18n/pool-club-share";
import { poolPageCopy } from "@/lib/pool/page-copy";

const URL = "https://matchtime.test/play?src=club-fnf";
const lines = (c: PoolClubShareCopy): string[] =>
  Object.entries(c).map(([k, v]) => (typeof v === "function" ? (v as (s: string) => string)(k === "post" ? URL : "24 Oct 2026") : v));
const EN = lines(poolClubShareCopy("en"));
const TR = lines(poolClubShareCopy("tr"));

describe("the club share copy", () => {
  it("no em or en dash, no slash between words", () => {
    for (const l of [...EN, ...TR].map((s) => s.replace(URL, ""))) {
      expect(l).not.toMatch(/[—–]/);
      expect(l).not.toMatch(/\w\/\w/);
    }
  });

  it("never a waiting list", () => {
    expect([...EN, ...TR].filter((l) => /waiting list|bekleme listesi/i.test(l))).toEqual([]);
  });

  it("every Turkish line differs from the English", () => {
    EN.forEach((en, i) => expect(TR[i]).not.toBe(en));
  });

  it("an unknown language falls back to English", () => {
    expect(poolClubShareCopy("de")).toBe(poolClubShareCopy("en"));
  });

  it("the post names the profile's own heading, word for word, in each language", () => {
    expect(poolClubShareCopy("en").post(URL)).toContain(poolPageCopy("en").member.heading);
    expect(poolClubShareCopy("tr").post(URL)).toContain(poolPageCopy("tr").member.heading);
  });

  it("the post says what the pool is, how to join, and to share a link; it stays short", () => {
    const en = poolClubShareCopy("en").post(URL);
    expect(en).toMatch(/player pool/);
    expect(en).toMatch(/your own link/);
    expect(en.length).toBeLessThan(500);
    const tr = poolClubShareCopy("tr").post(URL);
    expect(tr).toMatch(/oyuncu havuzu/);
    expect(tr).toMatch(/kendi bağlantın/);
    expect(tr.length).toBeLessThan(500);
  });
});
