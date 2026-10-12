/**
 * The "things to check" block of the learned-setup panel on
 * /admin/settings (2026-10-12): its count heading, and the action each
 * suggestion kind carries. Every kind has one, and it goes where the
 * organiser's DM sends them for that kind (dm.ts, run.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SUGGESTION_KEYS } from "../rules";
import {
  LANGUAGE_ANCHOR,
  ORGANISER_PICKS_ANCHOR,
  SCHEDULE_PATH,
  checkHeading,
  suggestionActionHref,
  suggestionActionLabel,
} from "../suggestion-action";

describe("the count heading", () => {
  it("is singular for one and plural for more, in English", () => {
    expect(checkHeading("en", 1)).toBe("1 thing to check");
    expect(checkHeading("en", 2)).toBe("2 things to check");
    expect(checkHeading("en", 6)).toBe("6 things to check");
  });
  it("reads correctly in Turkish, which takes no plural after a number", () => {
    expect(checkHeading("tr", 1)).toBe("Kontrol edilecek 1 şey");
    expect(checkHeading("tr", 2)).toBe("Kontrol edilecek 2 şey");
  });
  it("falls back to English for a missing language", () => {
    expect(checkHeading(null, 2)).toBe("2 things to check");
  });
});

describe("where each suggestion's button goes", () => {
  it("every suggestion kind has a target", () => {
    for (const key of SUGGESTION_KEYS) expect(suggestionActionHref(key), key).toMatch(/^(\/admin\/|#)\S+/);
  });
  it("the weekly game kinds go to the weekly game page, like the DM's 'Change it here' link", () => {
    for (const key of ["weeklyGameDay", "weeklyGameTime", "venue", "format"] as const) {
      expect(suggestionActionHref(key), key).toBe("/admin/activities");
    }
    // The DM's link for these kinds is minted from the same path.
    const run = readFileSync(path.join(__dirname, "..", "run.ts"), "utf8");
    expect(run).toContain(`scheduleUrl: await link("${SCHEDULE_PATH}")`);
  });
  it("the match fee goes to the weekly game page with its fee field open, like the DM's 'Set it here' link", () => {
    expect(suggestionActionHref("matchFee")).toBe("/admin/activities?edit=fee");
    const run = readFileSync(path.join(__dirname, "..", "run.ts"), "utf8");
    expect(run).toContain(`await link(FEE_PATH)`);
    // The page reads that query and has the field.
    const page = readFileSync(path.join(__dirname, "..", "..", "..", "app/admin/activities/page.tsx"), "utf8");
    expect(page).toContain("FEE_EDIT_PARAM");
    expect(page).toContain(`id="activity-fee"`);
  });
  it("organisers pick goes to that setting on the page, and language to the language setting", () => {
    expect(suggestionActionHref("organiserPicks")).toBe(`#${ORGANISER_PICKS_ANCHOR}`);
    expect(ORGANISER_PICKS_ANCHOR).toBe("wr-pick");
    expect(suggestionActionHref("language")).toBe(`#${LANGUAGE_ANCHOR}`);
  });
  it("the anchors exist on the settings page", () => {
    const root = path.join(__dirname, "..", "..", "..");
    expect(readFileSync(path.join(root, "components/settings/pick-mode-rows.tsx"), "utf8")).toContain(
      `id="${ORGANISER_PICKS_ANCHOR}"`,
    );
    expect(readFileSync(path.join(root, "app/admin/settings/page.tsx"), "utf8")).toContain(`id="${LANGUAGE_ANCHOR}"`);
  });
});

describe("what each suggestion's button says", () => {
  const EN: Record<(typeof SUGGESTION_KEYS)[number], string> = {
    weeklyGameDay: "Change game day",
    weeklyGameTime: "Change kickoff time",
    venue: "Change the pitch",
    format: "Change players a side",
    language: "Change the language",
    matchFee: "Set the match fee",
    organiserPicks: 'Switch on "The organisers pick"',
  };
  const TR: typeof EN = {
    weeklyGameDay: "Maç gününü değiştir",
    weeklyGameTime: "Maç saatini değiştir",
    venue: "Sahayı değiştir",
    format: "Takım başına kişi sayısını değiştir",
    language: "Dili değiştir",
    matchFee: "Maç ücretini gir",
    organiserPicks: '"Organizatörler seçer" ayarını aç',
  };
  it("a descriptive label per kind, in English and Turkish", () => {
    for (const key of SUGGESTION_KEYS) {
      expect(suggestionActionLabel("en", key), key).toBe(EN[key]);
      expect(suggestionActionLabel("tr", key), key).toBe(TR[key]);
    }
  });
  it("no two kinds share a label, and none is the old generic one", () => {
    for (const lang of ["en", "tr"]) {
      const labels = SUGGESTION_KEYS.map((k) => suggestionActionLabel(lang, k));
      expect(new Set(labels).size).toBe(labels.length);
      for (const l of labels) expect(l).not.toMatch(/^(Go to the setting|Ayara git)$/);
    }
  });
  it("the organisers pick label names the option as the settings page does", async () => {
    const { en } = await import("@/lib/i18n/strings.en");
    const { tr } = await import("@/lib/i18n/strings.tr");
    expect(suggestionActionLabel("en", "organiserPicks")).toContain(en.wr_pick_organiser);
    expect(suggestionActionLabel("tr", "organiserPicks")).toContain(tr.wr_pick_organiser);
  });
  it("the sub line keeps the 'nothing changed' meaning, with no dashes", async () => {
    const { en } = await import("@/lib/i18n/strings.en");
    const { tr } = await import("@/lib/i18n/strings.tr");
    expect(en.settings_learned_check_sub).toMatch(/changed nothing/i);
    expect(tr.settings_learned_check_sub).toMatch(/hiçbir şeyi değiştirmedi/i);
    for (const x of [en.settings_learned_check_sub, tr.settings_learned_check_sub]) expect(x).not.toMatch(/[–—]/);
  });
});
