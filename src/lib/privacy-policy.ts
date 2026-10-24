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
 * registration to show yet" are Kemal's; the company number is the one
 * printed on Cressoft's own issued invoices; the registered office is the
 * one on cressoft.io's privacy notice. Never invent a field: leave it
 * null and `missingCompanyDetails()` (and its unit test) will say so.
 */

export const PRIVACY_PATH = "/privacy";

/** Stored with every consent record. A whole number so an Int column holds it. */
export const PRIVACY_POLICY_VERSION = 1;

/** ISO date the version above took effect. */
export const PRIVACY_POLICY_EFFECTIVE_DATE = "2026-10-24";

export interface CompanyDetails {
  legalName: string | null;
  companyNumber: string | null;
  registeredOffice: string | null;
  /** One value on purpose: it moves to a MatchTime address later. */
  privacyEmail: string | null;
}

export const COMPANY_DETAILS: CompanyDetails = {
  legalName: "Cressoft Consultancy Limited",
  companyNumber: "07628636",
  registeredOffice: "167-169 Great Portland Street, London, W1W 5PF, United Kingdom",
  privacyEmail: "admin@cressoft.io",
};

/** The fields still empty, in declaration order. */
export function missingCompanyDetails(details: CompanyDetails = COMPANY_DETAILS): Array<keyof CompanyDetails> {
  return (Object.keys(details) as Array<keyof CompanyDetails>).filter((k) => !details[k]?.trim());
}
