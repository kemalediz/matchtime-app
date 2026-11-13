/**
 * The privacy policy's facts: who MatchTime is, its version and its
 * effective date. CLIENT-SAFE (no Prisma, no server imports): the policy
 * page is a client component and the consent record (pool slice L2)
 * stores PRIVACY_POLICY_VERSION with every yes.
 *
 * The wording lives in `src/lib/i18n/privacy-policy.{en,tr}.ts` and reads
 * every company fact from COMPANY_DETAILS, so a change here is a change on
 * every line that mentions it, in every language.
 *
 * WHEN THE POLICY'S MEANING CHANGES: bump PRIVACY_POLICY_VERSION and the
 * effective date together. A consent given under an older version then
 * shows as such, and a big change is announced before it applies (the
 * policy's own "changes" section says so).
 *
 * Sources (24 Oct 2026): the legal name, privacy email and "no ICO
 * registration to show yet" are Kemal's. The legal name, company number
 * and registered office were checked on Companies House on 11 Nov 2026
 * and live in `site-operator.ts`, which the website's footer, /contact
 * page and JSON-LD read too. Never invent a field: leave it null and
 * `missingCompanyDetails()` (and its unit test) will say so.
 */

import { OPERATOR_COMPANY_NUMBER, OPERATOR_LEGAL_NAME, OPERATOR_REGISTERED_OFFICE } from "./site-operator";

export const PRIVACY_PATH = "/privacy";

/** Stored with every consent record. A whole number so an Int column holds it. */
export const PRIVACY_POLICY_VERSION = 3;

/** ISO date the version above took effect. Version 3 (2026-11-13): the
 *  /play visit record, kept 90 days (`src/lib/pool/visit-log-rules.ts`). */
export const PRIVACY_POLICY_EFFECTIVE_DATE = "2026-11-13";

export interface CompanyDetails {
  legalName: string | null;
  companyNumber: string | null;
  registeredOffice: string | null;
  /** One value on purpose: it moves to a MatchTime address later. */
  privacyEmail: string | null;
}

export const COMPANY_DETAILS: CompanyDetails = {
  legalName: OPERATOR_LEGAL_NAME,
  companyNumber: OPERATOR_COMPANY_NUMBER,
  registeredOffice: OPERATOR_REGISTERED_OFFICE,
  privacyEmail: "admin@cressoft.io",
};

/** The fields still empty, in declaration order. */
export function missingCompanyDetails(details: CompanyDetails = COMPANY_DETAILS): Array<keyof CompanyDetails> {
  return (Object.keys(details) as Array<keyof CompanyDetails>).filter((k) => !details[k]?.trim());
}
