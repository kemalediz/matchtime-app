/**
 * Who runs MatchTime (2026-11-11). Meta reviews the WhatsApp display name
 * "MatchTime" and checks that the website ties the brand to the legal
 * business. Every place the site names its operator says the same thing:
 * "MatchTime is operated by Cressoft Consultancy Limited, a company
 * registered in England and Wales (company number 07628636).", the name
 * linking to cressoft.io. The /contact page and the privacy policy also
 * give the registered office; the footer gives the number only.
 * (Companies House, checked 2026-11-11: active, number 07628636.)
 *
 * Rendered to HTML (no browser), so the strings a visitor reads are what
 * is pinned. No model calls: $0.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The root layout loads Google fonts and the app shell; neither matters to
// the exported metadata (same stubs as meta-domain-verification.test.ts).
vi.mock("next/font/google", () => {
  const font = () => ({ variable: "", className: "" });
  return { Inter: font, Plus_Jakarta_Sans: font, Geist_Mono: font };
});
vi.mock("../globals.css", () => ({}));
vi.mock("@/components/providers", () => ({ Providers: () => null }));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/components/web-analytics", () => ({ WebAnalytics: () => null }));

import { metadata } from "../layout";
import ContactPage, { metadata as contactMetadata } from "../contact/page";
import sitemap from "../sitemap";
import { PrivacyPolicyView } from "../privacy/privacy-policy-view";
import { LandingFooter } from "@/components/landing/landing-sections";
import { LandingPage } from "@/components/landing/landing-page";
import { COMPANY_DETAILS } from "@/lib/privacy-policy";
import { privacyPolicy, policyPlainText } from "@/lib/i18n/privacy-policy";
import { isPublicPath } from "@/lib/public-paths";
import {
  CONTACT_EMAIL,
  CONTACT_PATH,
  OPERATED_BY_LINE,
  OPERATOR_COMPANY_NUMBER,
  OPERATOR_LEGAL_NAME,
  OPERATOR_REGISTERED_OFFICE,
  OPERATOR_URL,
  REGISTERED_OFFICE_LINE,
} from "@/lib/site-operator";

const LINE =
  "MatchTime is operated by Cressoft Consultancy Limited, a company registered in England and Wales (company number 07628636).";
const OFFICE_LINE = "Registered office: 5th Floor, 167-169 Great Portland Street, London W1W 5PF.";

/** The markup's visible words, tags removed and entities decoded. */
function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("the operator facts (one place)", () => {
  it("names the legal entity, its number and office, the same facts the privacy policy uses", () => {
    expect(OPERATOR_LEGAL_NAME).toBe("Cressoft Consultancy Limited");
    expect(OPERATOR_COMPANY_NUMBER).toBe("07628636");
    expect(OPERATOR_REGISTERED_OFFICE).toBe("5th Floor, 167-169 Great Portland Street, London W1W 5PF");
    expect(COMPANY_DETAILS.legalName).toBe(OPERATOR_LEGAL_NAME);
    expect(COMPANY_DETAILS.companyNumber).toBe(OPERATOR_COMPANY_NUMBER);
    expect(COMPANY_DETAILS.registeredOffice).toBe(OPERATOR_REGISTERED_OFFICE);
    expect(OPERATOR_URL).toBe("https://cressoft.io");
  });

  it("states the operated-by and registered office lines word for word", () => {
    expect(OPERATED_BY_LINE).toBe(LINE);
    expect(REGISTERED_OFFICE_LINE).toBe(OFFICE_LINE);
  });

  it("uses the public contact address and the /contact page", () => {
    expect(CONTACT_EMAIL).toBe("hello@matchtime.ai");
    expect(CONTACT_PATH).toBe("/contact");
  });
});

describe("the website footer (home, /players, /pricing, /contact)", () => {
  const html = renderToStaticMarkup(createElement(LandingFooter));
  const text = textOf(html);

  it("keeps the MatchTime name and says who operates it, with the company number", () => {
    expect(text).toContain("MatchTime");
    expect(text).toContain(LINE);
  });

  it("gives the number only, not the registered address", () => {
    expect(text).not.toMatch(/Registered office|Great Portland|W1W 5PF/);
  });

  it("links the legal name to cressoft.io", () => {
    expect(html).toMatch(/<a[^>]*href="https:\/\/cressoft\.io"[^>]*>Cressoft Consultancy Limited<\/a>/);
  });

  it("keeps the copyright with MatchTime and claims no trading name", () => {
    expect(text).toContain(`© ${new Date().getFullYear()} MatchTime. All rights reserved.`);
    expect(text).not.toMatch(/trading name/i);
  });

  it("links to the contact page and no longer says the short 'By Cressoft'", () => {
    expect(html).toMatch(/<a[^>]*href="\/contact"[^>]*>Contact<\/a>/);
    expect(text).not.toContain("By Cressoft");
  });

  it("has no em or en dash", () => {
    expect(text).not.toMatch(/[–—]/);
  });
});

describe("/contact", () => {
  const html = renderToStaticMarkup(createElement(ContactPage));
  const text = textOf(html);

  it("is headed Contact MatchTime", () => {
    expect(html).toMatch(/<h1[^>]*>Contact MatchTime<\/h1>/);
  });

  it("gives hello@matchtime.ai as a mail link", () => {
    expect(html).toMatch(/<a[^>]*href="mailto:hello@matchtime\.ai"[^>]*>(?:(?!<\/a>)[\s\S])*hello@matchtime\.ai(?:(?!<\/a>)[\s\S])*<\/a>/);
  });

  it("says who operates MatchTime, linked to cressoft.io", () => {
    expect(text).toContain(LINE);
    expect(html).toContain('href="https://cressoft.io"');
  });

  it("uses the site's header and footer", () => {
    expect(html).toContain("<header");
    expect(html).toContain("<footer");
  });

  it("gives the registered office, and has no dashes", () => {
    expect(text).toContain(OFFICE_LINE);
    expect(text).not.toMatch(/[–—]/);
  });

  it("has a title and a description", () => {
    expect(contactMetadata.title).toBe("Contact");
    expect(String(contactMetadata.description)).toContain("Cressoft Consultancy Limited");
  });

  it("is public and in the sitemap", () => {
    expect(isPublicPath("/contact")).toBe(true);
    expect(isPublicPath("/contactx")).toBe(false);
    expect(sitemap().map((e) => new URL(e.url).pathname)).toContain("/contact");
  });
});

describe("the privacy policy names the controller near the top", () => {
  it("the English opens with the operated-by line and gives hello@matchtime.ai", () => {
    const en = privacyPolicy("en");
    const first = en.sections[0];
    expect(first.id).toBe("who-we-are");
    const opening = policyPlainText({ ...en, sections: [first] });
    expect(opening).toContain(LINE);
    expect(opening).toContain(OFFICE_LINE);
    expect(opening).toContain("controller");
    expect(opening).toContain("hello@matchtime.ai");
  });

  it("the Turkish gives the same contact address in the same section", () => {
    const tr = privacyPolicy("tr");
    const opening = policyPlainText({ ...tr, sections: [tr.sections[0]] });
    expect(opening).toContain("Cressoft Consultancy Limited");
    expect(opening).toContain("İngiltere ve Galler");
    expect(opening).toContain("07628636");
    expect(opening).toContain("5th Floor, 167-169 Great Portland Street, London W1W 5PF");
    expect(opening).toContain("hello@matchtime.ai");
  });

  it("the page shows it", () => {
    const html = renderToStaticMarkup(createElement(PrivacyPolicyView));
    const text = textOf(html);
    expect(text).toContain(LINE);
    expect(text).toContain(OFFICE_LINE);
    expect(html).toContain('href="mailto:hello@matchtime.ai"');
  });
});

describe("structured data and page metadata use the legal name", () => {
  it("the home page's JSON-LD publisher is Cressoft Consultancy Limited, brand MatchTime", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const ld = JSON.parse(m![1]);
    expect(ld.name).toBe("MatchTime");
    expect(ld.publisher).toEqual({
      "@type": "Organization",
      name: "Cressoft Consultancy Limited",
      legalName: "Cressoft Consultancy Limited",
      url: "https://cressoft.io",
      identifier: { "@type": "PropertyValue", propertyID: "Companies House company number", value: "07628636" },
      address: {
        "@type": "PostalAddress",
        streetAddress: "5th Floor, 167-169 Great Portland Street",
        addressLocality: "London",
        postalCode: "W1W 5PF",
        addressCountry: "GB",
      },
      brand: { "@type": "Brand", name: "MatchTime" },
    });
  });

  it("the root metadata's author, creator and publisher are Cressoft Consultancy Limited", () => {
    expect(metadata.authors).toEqual([{ name: "Cressoft Consultancy Limited", url: "https://cressoft.io" }]);
    expect(metadata.creator).toBe("Cressoft Consultancy Limited");
    expect(metadata.publisher).toBe("Cressoft Consultancy Limited");
    // Untouched: Meta's domain check.
    expect(metadata.verification?.other?.["facebook-domain-verification"]).toBe("oaxbhekv080zxhiaamw3mqz86tu6mm");
  });
});
