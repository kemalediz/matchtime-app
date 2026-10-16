/**
 * PAYMENT TRACKING IS HIDDEN FOR NOW (Kemal, 2026-10-16).
 *
 * The old WhatsApp payment poll ("💳 Payments for X: tick when you've
 * paid") and the group unpaid summary confused clubs. Players get pay-link
 * DMs from "Collect match fees", and the money collector has the payments
 * page. So nothing on the site or in MatchTime's copy offers or explains
 * payment tracking any more, and nothing switches it on:
 *
 *   - the settings page has no row for it and no ⓘ entry;
 *   - "help payments" is about collecting match fees, worded for that;
 *   - the in-group setup menu does not list it, and no setup flow turns it
 *     on (the menu, the bundles and the learned setup);
 *   - `setOrgFeature` refuses to turn it on (its own test, in actions).
 *
 * The column and the scheduler code are untouched, so it can come back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FEATURE_META, HIDDEN_FEATURE_KEYS, OFFERED_FEATURE_META, isFeatureOffered } from "../org-features-meta";
import { SETTING_INFO_KEYS, SETTINGS_INFO } from "../settings-info";
import { buildHelpReply, buildLegacyFeatureMenu, type HelpFeatures } from "../onboarding-conversation";
import { regexExtract } from "../onboarding-parse";
import { hideUnofferedSettings, type SetupPlan } from "../setup-learning/rules";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const OFF: HelpFeatures = {
  attendance: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  statsQa: true,
  reminders: true,
  bench: true,
  paymentTracking: false,
  paymentCollection: false,
};
const LANGS = ["en", "tr"] as const;
/** Any wording that names the hidden setting, in either language. */
const NAMES_IT = /payment tracking|ödeme takib/i;

describe("the setting is hidden", () => {
  it("only payment tracking is hidden, and the offered list keeps every other switch in order", () => {
    expect([...HIDDEN_FEATURE_KEYS]).toEqual(["paymentTracking"]);
    expect(isFeatureOffered("paymentTracking")).toBe(false);
    expect(isFeatureOffered("paymentCollection")).toBe(true);
    expect(OFFERED_FEATURE_META.map((m) => m.key)).toEqual(FEATURE_META.map((m) => m.key).filter((k) => k !== "paymentTracking"));
  });

  it("the settings page lists the offered switches only", () => {
    const page = read("src/app/admin/settings/page.tsx");
    expect(page).toMatch(/OFFERED_FEATURE_META\.map\(/);
    expect(page).not.toMatch(/\bFEATURE_META\.map\(/);
    expect(page).not.toMatch(/paymentTracking/);
  });

  it("there is no ⓘ explanation for it, and the fee collection one does not mention it", () => {
    expect(SETTING_INFO_KEYS as readonly string[]).not.toContain("paymentTracking");
    expect(Object.keys(SETTINGS_INFO)).not.toContain("paymentTracking");
    for (const lang of LANGS) expect(JSON.stringify(SETTINGS_INFO.paymentCollection[lang]), lang).not.toMatch(NAMES_IT);
  });
});

describe("help payments is about collecting match fees", () => {
  for (const lang of LANGS) {
    for (const audience of ["group", "admin", "player"] as const) {
      it(`${lang} ${audience}: payments off never names payment tracking`, () => {
        const r = buildHelpReply("payments", OFF, lang, { audience, links: { settings: "https://mt/s" } });
        expect(r).not.toMatch(NAMES_IT);
        expect(r).not.toMatch(/Payment tracking/);
      });
      it(`${lang} ${audience}: payments on (fees collected) never names payment tracking`, () => {
        const r = buildHelpReply("payments", { ...OFF, paymentCollection: true }, lang, { audience, links: { settings: "https://mt/s" } });
        expect(r).not.toMatch(NAMES_IT);
        expect(r).not.toMatch(/tick/i);
      });
    }
    it(`${lang}: bare help with fees collected lists payments as match fees`, () => {
      const r = buildHelpReply(null, { ...OFF, paymentCollection: true }, lang, { audience: "group" });
      expect(r).not.toMatch(NAMES_IT);
    });
  }

  it("the admin is told to switch on Collect match fees only", () => {
    const en = buildHelpReply("payments", OFF, "en", { audience: "admin", links: { settings: "https://mt/s" } });
    expect(en).toContain("turn on *Collect match fees* under Bot features");
    const tr = buildHelpReply("payments", OFF, "tr", { audience: "admin", links: { settings: "https://mt/s" } });
    expect(tr).toContain("*Bot features* altında *Collect match fees* ayarını aç");
  });

  it("a club with only the old tracking flag on is shown how fee collection works and how to switch it on", () => {
    const r = buildHelpReply("payments", { ...OFF, paymentTracking: true }, "en", { audience: "group", links: { settings: "https://mt/s" } });
    expect(r).toContain("isn't switched on for this group yet");
    expect(r).toContain("*Collect match fees*");
  });
});

describe("no setup flow switches it on", () => {
  it("the in-group setup menu does not list it (EN and TR)", () => {
    for (const lang of LANGS) {
      const menu = buildLegacyFeatureMenu("Pick", lang);
      expect(menu, lang).not.toMatch(NAMES_IT);
    }
  });

  it("a numbered pick reads the menu as shown: 8 is not payment tracking", () => {
    const sel = regexExtract([{ body: "1, 2 and 8" }]).featureSelection ?? [];
    expect(sel).not.toContain("paymentTracking");
  });

  it("onboarding only keeps offered features (the completion source)", () => {
    const src = read("src/lib/onboarding-conversation.ts");
    expect(src).not.toMatch(/new Set<ToggleableKey>\(FEATURE_META\.map/);
    expect(src).toMatch(/paymentTrackingEnabled: chosenSet\.has\("paymentTracking"\) && isFeatureOffered\("paymentTracking"\)/);
  });

  it("the learned setup never switches it on, and never says it held it off", () => {
    const plan: SetupPlan = {
      applied: [
        { key: "rollingSquad", from: false, to: true, evidence: ["a", "b"] },
        { key: "paymentTracking", from: false, to: true, evidence: ["sent £6", "paid"] },
      ],
      suggestions: [],
      noted: [
        {
          key: "monthlyList",
          prepayForMonth: true,
          payAsYouGoFillIns: false,
          creditForMissedGames: false,
          confidence: "high",
          evidence: ["x"],
          heldPaymentTracking: true,
        },
      ],
      kept: [
        { key: "paymentTracking", reason: "monthly-list" },
        { key: "listPublish", reason: "thin-evidence" },
      ],
      data: { rollingSquadEnabled: true, paymentTrackingEnabled: true },
    };
    const out = hideUnofferedSettings(plan);
    expect(out.applied.map((a) => a.key)).toEqual(["rollingSquad"]);
    expect(out.data).toEqual({ rollingSquadEnabled: true });
    expect(out.kept).toEqual([{ key: "listPublish", reason: "thin-evidence" }]);
    expect(out.noted[0].heldPaymentTracking).toBe(false);
  });

  it("the learned setup run filters every plan it writes", () => {
    const src = read("src/lib/setup-learning/run.ts");
    expect(src).not.toMatch(/= planSetup\(/);
    expect(src.match(/hideUnofferedSettings\(planSetup\(/g)?.length).toBe(2);
  });
});
