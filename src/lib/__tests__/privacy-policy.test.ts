/**
 * The privacy policy (slice L0 of the local player pool).
 *
 * The policy text lives in `src/lib/i18n/privacy-policy.{en,tr}.ts`, the
 * company details and the version in `src/lib/privacy-policy.ts`. These
 * tests pin what the approved spec says the policy must cover, the house
 * rules (no long dashes, "bench" never "waiting list"), and what it must
 * keep out (no system, tool or provider product names, no matching rules
 * or sending limits).
 */
import { describe, it, expect } from "vitest";
import {
  COMPANY_DETAILS,
  PRIVACY_PATH,
  PRIVACY_POLICY_EFFECTIVE_DATE,
  PRIVACY_POLICY_VERSION,
  missingCompanyDetails,
} from "../privacy-policy";
import {
  POLICY_SECTION_IDS,
  privacyPolicy,
  policyPlainText,
  type PrivacyPolicyCopy,
} from "../i18n/privacy-policy";
import { LANGS } from "../i18n/lang";
import { t } from "../i18n/t";

const COPIES = LANGS.map((lang) => [lang, privacyPolicy(lang)] as const);

describe("privacy policy version (stored with every consent record)", () => {
  it("is a positive whole number, so a consent row can hold it in an Int column", () => {
    expect(Number.isInteger(PRIVACY_POLICY_VERSION)).toBe(true);
    expect(PRIVACY_POLICY_VERSION).toBeGreaterThan(0);
  });

  it("has an effective date as a real ISO calendar date", () => {
    expect(PRIVACY_POLICY_EFFECTIVE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${PRIVACY_POLICY_EFFECTIVE_DATE}T00:00:00Z`).toISOString().slice(0, 10)).toBe(
      PRIVACY_POLICY_EFFECTIVE_DATE,
    );
  });

  it.each(COPIES)("the %s page states the same version and date the consent record stores", (_lang, copy) => {
    const line = copy.versionLine;
    expect(line).toContain(String(PRIVACY_POLICY_VERSION));
    expect(line).toMatch(/2026/);
  });

  it("is served at /privacy", () => {
    expect(PRIVACY_PATH).toBe("/privacy");
  });
});

describe("company details (one config object)", () => {
  // Kemal, 24 Oct 2026: the entity is "Cressoft Consultancy Limited", the
  // privacy contact is admin@cressoft.io for now (privacy@matchtime.ai
  // later, so it is one value), and there is no ICO registration to show.
  it("names the real legal entity, its number, registered office and privacy contact", () => {
    expect(COMPANY_DETAILS.legalName).toBe("Cressoft Consultancy Limited");
    expect(COMPANY_DETAILS.companyNumber).toBe("07628636");
    expect(COMPANY_DETAILS.registeredOffice).toMatch(/W1W 5PF/);
    expect(COMPANY_DETAILS.privacyEmail).toBe("admin@cressoft.io");
  });

  // Never invented: a field nobody has confirmed stays empty, and this
  // list says which (MDs/local-player-pool-decisions-log.md).
  it("has no detail missing", () => {
    expect(missingCompanyDetails()).toEqual([]);
  });

  it("reports every empty field as missing", () => {
    expect(
      missingCompanyDetails({
        legalName: "X",
        companyNumber: null,
        registeredOffice: "",
        privacyEmail: "a@b.c",
      }),
    ).toEqual(["companyNumber", "registeredOffice"]);
  });

  it("the page reads the contact email from the config, so changing it there changes every mention", () => {
    const moved = { ...COMPANY_DETAILS, privacyEmail: "privacy@example.test" };
    for (const lang of LANGS) {
      const text = policyPlainText(privacyPolicy(lang, moved));
      expect(text).toContain("privacy@example.test");
      expect(text).not.toContain("admin@cressoft.io");
    }
  });

  it("shows no ICO registration number and no placeholder", () => {
    for (const lang of LANGS) {
      const text = policyPlainText(privacyPolicy(lang));
      expect(text).not.toMatch(/registration number|kayıt numarası|TODO|TBC|XXXX|placeholder/i);
    }
  });
});

describe("the policy in English and Turkish", () => {
  it.each(COPIES)("%s has every section, in the same order", (_lang, copy) => {
    expect(copy.sections.map((s) => s.id)).toEqual([...POLICY_SECTION_IDS]);
  });

  it.each(COPIES)("%s has a title, a lead and no empty text anywhere", (_lang, copy) => {
    for (const text of allStrings(copy)) expect(text.trim()).not.toBe("");
  });

  it("the Turkish is translated, not English copied across", () => {
    const en = privacyPolicy("en");
    const tr = privacyPolicy("tr");
    expect(tr.title).not.toBe(en.title);
    en.sections.forEach((s, i) => {
      expect(tr.sections[i].heading).not.toBe(s.heading);
    });
  });

  it.each(COPIES)("%s has no em dash or en dash", (_lang, copy) => {
    expect(policyPlainText(copy)).not.toMatch(/[–—]/);
  });

  it.each(COPIES)("%s never says waiting list", (_lang, copy) => {
    expect(policyPlainText(copy)).not.toMatch(/waiting list|bekleme listesi/i);
  });

  it.each(COPIES)("%s names the company, its number, office and contact email", (_lang, copy) => {
    const text = policyPlainText(copy);
    expect(text).toContain("Cressoft Consultancy Limited");
    expect(text).toContain("07628636");
    expect(text).toContain("W1W 5PF");
    expect(text).toContain(COMPANY_DETAILS.privacyEmail);
  });

  it.each(COPIES)("%s uses the configured privacy email as its only email address", (_lang, copy) => {
    const emails = (policyPlainText(copy).match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []).map((e) => e.replace(/\.$/, ""));
    expect(new Set(emails)).toEqual(new Set([COMPANY_DETAILS.privacyEmail]));
  });

  it.each(COPIES)("%s states the minimum age of 18", (_lang, copy) => {
    expect(sectionText(copy, "age")).toMatch(/18/);
  });

  it.each(COPIES)("%s gives the 12-month inactivity rule and the 30 days to answer", (_lang, copy) => {
    const text = sectionText(copy, "how-long");
    expect(text).toMatch(/12/);
    expect(text).toMatch(/30/);
    expect(text).toMatch(/24/);
  });

  it.each(COPIES)("%s says a reply comes within one month and names the ICO", (_lang, copy) => {
    const text = sectionText(copy, "your-rights");
    expect(text).toMatch(/ICO/);
    expect(text).toContain("ico.org.uk");
  });

  it("English lists every right the spec requires", () => {
    const text = sectionText(privacyPolicy("en"), "your-rights").toLowerCase();
    for (const right of ["see", "correct", "delete", "restrict", "object", "copy", "withdraw", "complain", "one month"]) {
      expect(text).toContain(right);
    }
  });

  it("English covers the pool's data, purposes and who sees it", () => {
    const en = privacyPolicy("en");
    const held = sectionText(en, "what-we-hold").toLowerCase();
    for (const item of [
      "postcode district",
      "travel distance",
      "sports",
      "level",
      "turn-up record",
      "no-shows",
      "blocks and reports",
      "referral",
      "invitation",
      "early sign-up",
      "messages",
      "consent",
    ]) {
      expect(held).toContain(item);
    }
    expect(held).toMatch(/never.*full postcode/);
    const why = sectionText(en, "why").toLowerCase();
    expect(why).toContain("consent");
    expect(why).toContain("legitimate interest");
    const sees = sectionText(en, "who-sees-it").toLowerCase();
    expect(sees).toContain("first name and last initial");
    expect(sees).toContain("brought by");
    expect(sees).toMatch(/never.*phone number/);
    const auto = sectionText(en, "automatic-choices").toLowerCase();
    expect(auto).toContain("automatically");
    expect(auto).toContain("a person");
    const providers = sectionText(en, "service-providers").toLowerCase();
    for (const kind of ["messaging", "hosting", "ai", "uk"]) expect(providers).toContain(kind);
    expect(sectionText(en, "cookies").toLowerCase()).toContain("cookie");
    expect(sectionText(en, "changes").toLowerCase()).toContain("big change");
  });

  // Kept out (approved spec): how MatchTime is built or sends messages.
  it.each(COPIES)("%s names no system, tool or provider product", (_lang, copy) => {
    const text = policyPlainText(copy);
    expect(text).not.toMatch(
      /Anthropic|Claude|Haiku|Sonnet|Opus|OpenAI|GPT|Gemini|Vercel|Supabase|Postgres|Prisma|Stripe|Resend|Baileys|Raspberry|\bPi\b|Next\.js|Google|Mapbox|n8n|Firestore|AWS|Amazon/,
    );
  });

  it.each(COPIES)("%s gives no matching rule, sending limit or number per town", (_lang, copy) => {
    const text = policyPlainText(copy).toLowerCase();
    expect(text).not.toMatch(/a week and|offers a (week|day)|haftada|günde|per town|kasaba başına|şehir başına|a minute|dakikada|21:30|08:30|up to 8|en fazla 8|group admin|grup yöneticisi ayar/);
  });
});

describe("the footer link label", () => {
  it.each(LANGS)("exists in %s", (lang) => {
    expect(t(lang).privacy_link.trim()).not.toBe("");
  });

  it("is translated", () => {
    expect(t("tr").privacy_link).not.toBe(t("en").privacy_link);
  });
});

function sectionText(copy: PrivacyPolicyCopy, id: (typeof POLICY_SECTION_IDS)[number]): string {
  const section = copy.sections.find((s) => s.id === id);
  if (!section) throw new Error(`no section ${id}`);
  return policyPlainText({ ...copy, title: "", lead: "", versionLine: "", sections: [section] }).trim();
}

function allStrings(copy: PrivacyPolicyCopy): string[] {
  const out = [copy.title, copy.lead, copy.versionLine, copy.contentsLabel, copy.languageLabel, copy.backHome];
  for (const s of copy.sections) {
    out.push(s.heading);
    for (const b of s.blocks) {
      if (b.kind === "list") out.push(...b.items.map(richToText));
      else out.push(richToText(b.text));
    }
  }
  return out;
}

function richToText(r: import("../i18n/privacy-policy").Rich): string {
  return typeof r === "string" ? r : r.map((x) => (typeof x === "string" ? x : x.label)).join("");
}
