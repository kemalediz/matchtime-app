/**
 * The player pool banner's words, in English and Turkish (2026-10-28): the
 * approved lines word for word, and the house rules every pool page keeps.
 */
import { describe, expect, it } from "vitest";
import { poolBannerCopy, type PoolBannerCopy } from "@/lib/i18n/pool-banner";

const lines = (c: PoolBannerCopy): string[] => [
  c.region,
  c.join.text,
  c.join.button,
  c.join.info.title,
  ...c.join.info.lines,
  c.share.text,
  c.share.button,
  c.share.info.title,
  ...c.share.info.lines,
  c.notInterested,
  c.adminLine,
];
const EN = lines(poolBannerCopy("en"));
const TR = lines(poolBannerCopy("tr"));

describe("the pool banner copy", () => {
  it("the approved lines, word for word", () => {
    const en = poolBannerCopy("en");
    expect(en.join.text).toBe("Want more games? Join the MatchTime player pool.");
    expect(en.join.button).toBe("Join the pool");
    expect(en.share.text).toBe("Know someone who wants a game? Share your link.");
    expect(en.notInterested).toBe("Not interested");
    expect(en.adminLine).toBe("Tell your players about it");
    const tr = poolBannerCopy("tr");
    expect(tr.join.text).toBe("Daha çok maç mı istiyorsun? MatchTime oyuncu havuzuna katıl.");
    expect(tr.join.button).toBe("Havuza katıl");
    expect(tr.share.text).toBe("Maç arayan birini tanıyor musun? Bağlantını paylaş.");
    expect(tr.share.button).toBe("Paylaş");
    expect(tr.notInterested).toBe("İlgilenmiyorum");
    expect(tr.adminLine).toBe("Oyuncularınıza anlatın");
  });

  it("each ⓘ is two or three lines", () => {
    for (const c of [poolBannerCopy("en"), poolBannerCopy("tr")]) {
      for (const info of [c.join.info, c.share.info]) {
        expect(info.lines.length).toBeGreaterThanOrEqual(2);
        expect(info.lines.length).toBeLessThanOrEqual(3);
      }
    }
  });

  it("the join ⓘ says WhatsApp, a team nearby a player short, you decide, stop any time", () => {
    const en = poolBannerCopy("en").join.info.lines.join(" ");
    expect(en).toMatch(/WhatsApp/);
    expect(en).toMatch(/player short/);
    expect(en).toMatch(/You decide/);
    expect(en).toMatch(/stop any time/);
  });

  it("no em or en dash, no slash between words, never free, never a waiting list, no pricing", () => {
    for (const l of [...EN, ...TR]) {
      expect(l).not.toMatch(/[—–]/);
      expect(l).not.toMatch(/\w\/\w/);
      expect(l).not.toMatch(/\bfree\b|ücretsiz|bedava/i);
      expect(l).not.toMatch(/waiting list|bekleme listesi/i);
      expect(l).not.toMatch(/£|\bprice\b|\bfiyat/i);
    }
  });

  it("every Turkish line differs from the English (the brand name aside)", () => {
    EN.forEach((en, i) => {
      if (en !== "MatchTime player pool") expect(TR[i]).not.toBe(en);
    });
  });

  it("an unknown language falls back to English", () => {
    expect(poolBannerCopy("de")).toBe(poolBannerCopy("en"));
  });
});
