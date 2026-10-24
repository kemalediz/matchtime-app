/**
 * Referral badges' words (slice G4), English and Turkish: the house rules.
 */
import { describe, expect, it } from "vitest";
import { REFERRAL_BADGES } from "@/lib/badge-rules";
import { poolReferralCopy, type PoolReferralCopy } from "@/lib/i18n/pool-referral";

function lines(c: PoolReferralCopy): string[] {
  const out = [c.statsTitle, c.statsCount(3), c.statsHowItCounts, c.statsPrivate, c.badgeHint(1), c.badgeHint(10), c.broughtBy("Ali K.")];
  for (const b of REFERRAL_BADGES) {
    for (const names of [["Ali"], ["Ali", "Bea"]]) out.push(c.postLine({ key: b.key, emoji: b.emoji, label: b.label, names, friends: b.minFriends }));
  }
  return out;
}
const EN = lines(poolReferralCopy("en"));
const TR = lines(poolReferralCopy("tr"));

describe("the referral copy", () => {
  it("no em or en dash, no slash between words", () => {
    for (const l of [...EN, ...TR]) {
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

  it("the badge's name stays English in Turkish", () => {
    for (const b of REFERRAL_BADGES) {
      expect(poolReferralCopy("tr").postLine({ key: b.key, emoji: b.emoji, label: b.label, names: ["Ali"], friends: b.minFriends })).toContain(`*${b.label}*`);
    }
  });

  it("an unknown language falls back to English", () => {
    expect(poolReferralCopy("de")).toBe(poolReferralCopy("en"));
  });
});
