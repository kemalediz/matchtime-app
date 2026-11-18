/**
 * THE HELP AND THE GUIDE FOR WHAT A MONTHLY REGULAR COVERS (2026-11-16,
 * Kemal: each feature updates the help topics and the web guide). An
 * organiser adding somebody to a month already under way says the whole
 * month or the games left, and can change it later on the months page or
 * by tagging MatchTime ("Dan covers the whole month"). English and
 * Turkish for the WhatsApp help; the web guide is English. No database.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { t } from "@/lib/i18n/t";

const DASH = /[–—]/;

describe("help players in a monthly club's admin group", () => {
  it("English: the add says the whole month or the games left, and the change by tag", () => {
    const text = t("en").hq_help_players_monthly({ attendance: true, pool: false });
    expect(text).toContain(`*"@Match Time add Tom to the November list, he's paid the whole month"*`);
    expect(text).toContain(`*"@Match Time Dan covers the whole month"*`);
    expect(text).toContain("whole month, or just the games left?");
    expect(text).toContain("never below the games he has played since he joined, the weeks called off he was credited for, and the games left");
    expect(text).not.toMatch(DASH);
  });

  it("Turkish", () => {
    const text = t("tr").hq_help_players_monthly({ attendance: true, pool: false });
    expect(text).toContain(`*"@Match Time Tom'u Kasım listesine ekle, ayın tamamını ödedi"*`);
    expect(text).toContain(`*"@Match Time Dan ayın tamamını kapsıyor"*`);
    expect(text).toContain("ayın tamamı mı, yoksa sadece kalan maçlar mı?");
    expect(text).not.toMatch(DASH);
  });
});

describe("round 2, item 7: what a correction does to the money", () => {
  it("English (round 4, item 7): before a price nothing he owes changes; after, raised shows the extra as owed, lowered the difference to give back", () => {
    const text = t("en").hq_help_players_monthly({ attendance: true, pool: false });
    expect(text).toContain("Correcting what a player covers before the month has a price changes nothing he owes.");
    expect(text).toContain("Once it has a price, what he paid, or says he paid, stays as it was: raise him and the months page shows the extra as owed; lower him and it shows the difference as money to give back.");
    expect(text).not.toContain("confirm it again");
    // Round 4, option a: a coverage change is never a payment, and the reply says what it leaves.
    expect(text).toContain("My reply says so too. Changing what he covers never marks him as paid.");
    expect(text).not.toMatch(DASH);
  });

  it("Turkish", () => {
    const text = t("tr").hq_help_players_monthly({ attendance: true, pool: false });
    expect(text).toContain("Ayın fiyatı belirlenmeden önce bir oyuncunun kapsadığını düzeltmek borcunu değiştirmez.");
    expect(text).toContain("ödediği ya da ödediğini söylediği tutar aynı kalır");
    expect(text).toContain("geri verilecek para olarak gösterir");
    expect(text).not.toContain("yeniden onaylayabilir");
    expect(text).toContain("Kapsamı değiştirmek onu ödemiş olarak işaretlemez.");
    expect(text).not.toMatch(DASH);
  });
});

describe("help availability for an organiser of a monthly club", () => {
  it("English and Turkish say the whole month or the games left", () => {
    const en = t("en").onbHelpMonthListOrganiser;
    expect(en).toContain("whole month (if he paid for it) or the games left");
    expect(en).toContain("the months page");
    const tr = t("tr").onbHelpMonthListOrganiser;
    expect(tr).toContain("ayın tamamı (ödediyse) ya da kalan maçlar");
    expect(`${en}${tr}`).not.toMatch(DASH);
  });
});

describe("the organiser guide on the web", () => {
  const ROOT = path.resolve(__dirname, "../../..");
  const src = readFileSync(path.join(ROOT, "src/app/help/admin/page.tsx"), "utf8")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\{" "\}/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ");
  const start = src.indexOf("Monthly squad: adding a regular in the middle of the month");
  const section = src.slice(start, src.indexOf("Once the month is running", start));

  it("says the organiser chooses the whole month or the games left, and how to change it", () => {
    expect(start).toBeGreaterThan(-1);
    expect(section).toContain("the whole month (he paid for it) or the games left");
    expect(section).toContain("@Match Time Dan covers the whole month");
    expect(section).toContain("Whole month, or just the games left?");
    expect(section).toContain("Covers");
    // Review of #611: the bounds, the claim, and the other doors.
    expect(section).toContain("never below the games he has played since he joined, the weeks called off he was credited for, and the games left");
    expect(section).toContain("also marks him as says paid, for the money collector to confirm");
    expect(section).toContain("are added for the games left, and MatchTime tells you so and how to change it");
    // Round 3, item 5: true after a cancellation too.
    expect(section).not.toContain("always covers the whole month");
    expect(section).toContain("covers every game the month had when you started it, and a week called off since is credited back to him");
    // Round 2, item 7.
    expect(section).toContain("Correcting what a player covers before the month has a price changes nothing he owes.");
    expect(section).toContain("what he paid, or says he paid, stays as it was");
    expect(section).toContain("the extra as owed; lower him and it shows the difference as money to give back");
    expect(section).not.toContain("confirm it again");
    expect(section).toContain("covers never marks him as paid");
    expect(section).toContain("the weeks called off he was credited for");
    expect(section).not.toMatch(DASH);
  });
});
