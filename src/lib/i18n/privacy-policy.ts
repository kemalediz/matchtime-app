/**
 * The privacy policy's wording, in every language MatchTime ships.
 *
 * Long-form copy, so it is not in the flat `strings.*.ts` tables: each
 * language is one builder (`privacy-policy.en.ts`, `privacy-policy.tr.ts`)
 * that returns the whole page as data (sections of paragraphs and lists).
 * The page component renders that data and holds no wording of its own.
 *
 * Every company fact (name, number, office, contact email) and the
 * version are passed in from `../privacy-policy.ts`, never typed into a
 * sentence, so the policy and the consent record can never disagree.
 *
 * House rules (unit tested in `src/lib/__tests__/privacy-policy.test.ts`):
 * no em or en dashes, "bench" never "waiting list", and nothing about how
 * MatchTime is built or sends messages (no system, tool or provider
 * product names, matching rules, sending limits or numbers per town).
 */
import { COMPANY_DETAILS, PRIVACY_POLICY_EFFECTIVE_DATE, PRIVACY_POLICY_VERSION, type CompanyDetails } from "../privacy-policy";
import { normaliseLang, type Lang } from "./lang";
import { buildPrivacyPolicyEn } from "./privacy-policy.en";
import { buildPrivacyPolicyTr } from "./privacy-policy.tr";
import type { PolicyFacts, PrivacyPolicyCopy, Rich } from "./privacy-policy-shared";

export {
  POLICY_SECTION_IDS,
  formatPolicyDate,
  type PolicySectionId,
  type RichLink,
  type Rich,
  type PolicyBlock,
  type PolicySection,
  type PrivacyPolicyCopy,
  type PolicyFacts,
} from "./privacy-policy-shared";

const BUILDERS: Record<Lang, (f: PolicyFacts) => PrivacyPolicyCopy> = {
  en: buildPrivacyPolicyEn,
  tr: buildPrivacyPolicyTr,
};

export function privacyPolicy(
  lang: Lang | string | null | undefined,
  company: CompanyDetails = COMPANY_DETAILS,
): PrivacyPolicyCopy {
  const email = company.privacyEmail
    ? { href: `mailto:${company.privacyEmail}`, label: company.privacyEmail }
    : "";
  return BUILDERS[normaliseLang(lang)]({
    company,
    version: PRIVACY_POLICY_VERSION,
    effectiveDate: PRIVACY_POLICY_EFFECTIVE_DATE,
    email,
    ico: { href: "https://ico.org.uk", label: "ico.org.uk" },
  });
}

/** A rich text's words, links as their labels. */
export function richText(r: Rich): string {
  return typeof r === "string" ? r : r.map((x) => (typeof x === "string" ? x : x.label)).join("");
}

/** The whole policy as plain text, one block per line (tests, search). */
export function policyPlainText(copy: PrivacyPolicyCopy): string {
  const lines = [copy.title, copy.lead, copy.versionLine];
  for (const s of copy.sections) {
    lines.push(s.heading);
    for (const b of s.blocks) {
      if (b.kind === "p") lines.push(richText(b.text));
      else lines.push(...b.items.map(richText));
    }
  }
  return lines.filter(Boolean).join("\n");
}
