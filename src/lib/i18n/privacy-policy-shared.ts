/**
 * The privacy policy's shape and the one formatter its builders share.
 * Split from `privacy-policy.ts` so the language builders can import it
 * without importing the resolver that imports them.
 */
import type { CompanyDetails } from "../privacy-policy";

/** Section anchors, in page order. Every language has all of them. */
export const POLICY_SECTION_IDS = [
  "who-we-are",
  "what-it-covers",
  "what-we-hold",
  "why",
  "who-sees-it",
  "service-providers",
  "automatic-choices",
  "how-long",
  "your-rights",
  "age",
  "cookies",
  "security",
  "changes",
] as const;

export type PolicySectionId = (typeof POLICY_SECTION_IDS)[number];

export interface RichLink {
  href: string;
  label: string;
}

/** Plain text, or text with links in it. */
export type Rich = string | Array<string | RichLink>;

export type PolicyBlock = { kind: "p"; text: Rich } | { kind: "list"; items: Rich[] };

export interface PolicySection {
  id: PolicySectionId;
  heading: string;
  blocks: PolicyBlock[];
}

export interface PrivacyPolicyCopy {
  title: string;
  lead: string;
  /** "Version 1, in effect from 24 October 2026". */
  versionLine: string;
  contentsLabel: string;
  languageLabel: string;
  backHome: string;
  sections: PolicySection[];
}

/** What a builder is given: the facts, already resolved. */
export interface PolicyFacts {
  company: CompanyDetails;
  version: number;
  /** ISO date, formatted by each builder in its own language. */
  effectiveDate: string;
  /** The contact email as a link, or the plain words when none is set. */
  email: RichLink | string;
  ico: RichLink;
}

/** "24 October 2026" / "24 Ekim 2026", read as a calendar date in any zone. */
export function formatPolicyDate(iso: string, locale: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
