/**
 * The words ON /admin/settings that were wrong or English-only (2026-10-15),
 * pinned against the code that decides them:
 *   - the Man of the Match row no longer says it posts a vote (no vote is
 *     posted in the group; players vote on their rating link);
 *   - the Pay by Bank and Card rows quote what `totalForMethod` charges on a
 *     £10 fee, rendered from it, in English and Turkish;
 *   - the poster upload text says square pictures are fine and gives the
 *     540 by 675 minimum the upload enforces;
 *   - the language row no longer says Turkish is "being added in stages",
 *     and the page's own headings come from the string tables;
 *   - each Bot features popup is titled with the label beside it, in both
 *     languages.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURE_META, OFFERED_FEATURE_META } from "../org-features-meta";
import { totalForMethod } from "../payments";
import { BACKGROUND_MIN_HEIGHT, BACKGROUND_MIN_WIDTH, portraitProblem } from "../graphics-background";
import { t } from "../i18n/t";
import { LANGS } from "../i18n/lang";
import { settingInfo } from "../settings-info";

const PAGE = readFileSync(join(__dirname, "..", "..", "app", "admin", "settings", "page.tsx"), "utf8");
const blurb = (key: string) => FEATURE_META.find((m) => m.key === key)!;
const pounds = (method: "pay_by_bank" | "card") => `£${totalForMethod(10, method, 1).toFixed(2)}`;

describe("settings page copy", () => {
  it("Man of the Match: announces the winner, the vote is on the rating link", () => {
    for (const lang of LANGS) {
      const text = t(lang).onb_legacy_feature_blurb({ key: "momVoting", englishBlurb: blurb("momVoting").blurb });
      expect(text, lang).not.toMatch(/posts the MoM vote|oylamasını açar/i);
    }
    expect(blurb("momVoting").blurb).toBe("Announces the winner in the group. Players vote on their rating link.");
  });

  it("Pay by Bank and Card quote the price the code charges on £10, in both languages", () => {
    expect(pounds("pay_by_bank")).toBe("£10.36");
    expect(pounds("card")).toBe("£10.46");
    for (const lang of LANGS) {
      const s = t(lang);
      expect(s.onb_legacy_feature_blurb({ key: "payByBank", englishBlurb: blurb("payByBank").blurb }), lang).toContain(pounds("pay_by_bank"));
      expect(s.onb_legacy_feature_blurb({ key: "payCard", englishBlurb: blurb("payCard").blurb }), lang).toContain(pounds("card"));
    }
    for (const m of FEATURE_META) expect(m.label, m.key).not.toMatch(/\p{L}\s*\/\s*\p{L}/u);
    expect(JSON.stringify(FEATURE_META)).not.toMatch(/~10p|~35p/);
  });

  it("the poster upload text matches what the upload accepts", () => {
    expect(portraitProblem(800, 800)).toBeNull();
    expect(portraitProblem(801, 800)).toBe("not-portrait");
    expect(t("en").gp_upload_blurb).toContain(`at least ${BACKGROUND_MIN_WIDTH} by ${BACKGROUND_MIN_HEIGHT} pixels`);
    expect(t("en").gp_upload_blurb).toMatch(/portrait or square/);
    expect(t("tr").gp_upload_blurb).toContain(`${BACKGROUND_MIN_WIDTH} x ${BACKGROUND_MIN_HEIGHT}`);
    expect(t("tr").gp_upload_blurb).toMatch(/kare/);
  });

  it("no 'being added in stages', and the headings come from the string tables", () => {
    expect(PAGE).not.toMatch(/added in stages/);
    for (const heading of ["General", "Team names", "Bot language", "Invite link", "Bot features", "WhatsApp bot"]) {
      expect(PAGE, heading).not.toContain(`>${heading}</h2>`);
    }
    for (const lang of LANGS) {
      const s = t(lang);
      for (const v of [s.st_general_title, s.st_team_names_title, s.st_language_title, s.st_invite_title, s.st_features_title, s.st_bank_title, s.st_wa_title]) {
        expect(v.trim()).not.toBe("");
      }
    }
    expect(t("tr").st_general_title).toBe("Genel");
    expect(t("en").st_language_lead).not.toMatch(/English/);
  });

  it("each Bot features popup is titled with the row's label, in both languages", () => {
    for (const m of OFFERED_FEATURE_META) {
      expect(m.label.replace(/^\s*↳\s*/, "").replace(/ \(Stripe\)$/, ""), m.key).toBe(settingInfo("en", m.key).title);
      expect(t("tr").onbFeatureLabel({ key: m.key, englishLabel: m.label }), m.key).toBe(settingInfo("tr", m.key).title);
    }
  });
});
