/**
 * Who operates MatchTime, as the website states it (2026-11-11). Meta
 * reviews the WhatsApp display name "MatchTime" and checks that the site
 * ties the brand to the legal business, so the footer, the /contact page,
 * the privacy policy, the JSON-LD and the root metadata all read their
 * operator from here and say the same thing.
 *
 * CLIENT-SAFE: plain constants, no imports.
 *
 * Source: Companies House, checked 2026-11-11: CRESSOFT CONSULTANCY
 * LIMITED, company number 07628636, active, registered office 5th Floor,
 * 167-169 Great Portland Street, London W1W 5PF. `privacy-policy.ts`
 * builds its COMPANY_DETAILS from these, so the policy and the site can
 * never disagree.
 *
 * Where each fact shows: the footer gives the operated-by line (name and
 * number); /contact and the privacy policy also give the registered office.
 */

export const OPERATOR_LEGAL_NAME = "Cressoft Consultancy Limited";
export const OPERATOR_COMPANY_NUMBER = "07628636";
export const OPERATOR_REGISTERED_OFFICE = "5th Floor, 167-169 Great Portland Street, London W1W 5PF";
export const OPERATOR_URL = "https://cressoft.io";

/** The sentence every page uses. Pages that link the name split it at the name. */
export const OPERATED_BY_LINE = `MatchTime is operated by ${OPERATOR_LEGAL_NAME}, a company registered in England and Wales (company number ${OPERATOR_COMPANY_NUMBER}).`;

/** On /contact (the privacy policy words its own, from the same fact). */
export const REGISTERED_OFFICE_LINE = `Registered office: ${OPERATOR_REGISTERED_OFFICE}.`;

/** The public contact address (the only email the public pages show). */
export const CONTACT_EMAIL = "hello@matchtime.ai";

export const CONTACT_PATH = "/contact";

/** The operator as a schema.org Organization, for JSON-LD. */
export const OPERATOR_ORGANIZATION_LD = {
  "@type": "Organization",
  name: OPERATOR_LEGAL_NAME,
  legalName: OPERATOR_LEGAL_NAME,
  url: OPERATOR_URL,
  identifier: { "@type": "PropertyValue", propertyID: "Companies House company number", value: OPERATOR_COMPANY_NUMBER },
  address: {
    "@type": "PostalAddress",
    streetAddress: "5th Floor, 167-169 Great Portland Street",
    addressLocality: "London",
    postalCode: "W1W 5PF",
    addressCountry: "GB",
  },
  brand: { "@type": "Brand", name: "MatchTime" },
} as const;
