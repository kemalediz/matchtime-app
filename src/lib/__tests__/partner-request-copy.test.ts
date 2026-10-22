/**
 * Partner requests (P3): the copy that still said only the MatchTime team
 * pairs clubs now says how requests work, in English and Turkish; and the
 * request notice keeps the "reply 1 or 2" ending word for word.
 */
import { describe, expect, it } from "vitest";
import { t } from "../i18n/t";
import { settingInfo } from "../settings-info";

const all = (lang: "en" | "tr") => {
  const s = t(lang);
  const info = settingInfo(lang, "partnerClubs");
  return [s.pc_section_lead, s.pc_remove_confirm({ other: "Sutton FC" }), ...info.what, info.newClubs, ...(info.together ?? [])].join("\n");
};

describe("no copy says only the MatchTime team pairs clubs", () => {
  it("English", () => {
    expect(all("en")).not.toMatch(/MatchTime team/);
    expect(t("en").pc_section_lead).toContain("send them a request");
    expect(all("en")).toContain("30 days");
  });
  it("Turkish", () => {
    expect(all("tr")).not.toMatch(/MatchTime ekibi/);
    expect(t("tr").pc_section_lead).toContain("istek gönderin");
    expect(all("tr")).toContain("30 gün");
  });
});

describe("the request notice", () => {
  const args = { asker: "Friday MT Community", club: "Sutton FC", card: "2.1 miles away, Tuesdays 20:00, 7-a-side, 24 members", link: "https://x/L" };
  it("ends with the old notice's words, word for word, in a DM and in the admin group", () => {
    expect(t("en").pr_request_notice(args).endsWith("Reply *1* to accept or *2* to decline, or open https://x/L")).toBe(true);
    const group = t("en").pr_request_notice({ ...args, inGroup: true });
    expect(group).toContain("Answer by replying to this message.");
    expect(group.endsWith("Reply *1* to accept or *2* to decline, or open https://x/L")).toBe(true);
    // Turkish keeps the Turkish notice's ending.
    expect(t("tr").pr_request_notice(args).endsWith("Kabul etmek için *1*, reddetmek için *2* yazın ya da şunu açın: https://x/L")).toBe(true);
  });
  it("is worded as a request, with the card (plan 3.1)", () => {
    expect(t("en").pr_request_notice(args)).toBe(
      "🤝 *Friday MT Community* (2.1 miles away, Tuesdays 20:00, 7-a-side, 24 members) would like to ask *Sutton FC* for players when they are short. If you accept, their asks go straight into your players' group; you can change that, pause or end it at any time. Reply *1* to accept or *2* to decline, or open https://x/L",
    );
  });
});
