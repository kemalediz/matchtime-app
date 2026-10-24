/**
 * The sharing card's words (slice G1), in English and Turkish: the house
 * rules every pool page keeps.
 */
import { describe, expect, it } from "vitest";
import { poolShareCopy, type PoolShareCopy } from "@/lib/i18n/pool-share";

const URL = "https://matchtime.test/play?ref=K7QP2M";
const lines = (c: PoolShareCopy): string[] =>
  Object.values(c).map((v) => (typeof v === "function" ? (v as (s: string) => string)(v === c.message ? URL : "Ali K.") : v));
const EN = lines(poolShareCopy("en"));
const TR = lines(poolShareCopy("tr"));

describe("the sharing copy", () => {
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
    expect(poolShareCopy("de")).toBe(poolShareCopy("en"));
  });
});
