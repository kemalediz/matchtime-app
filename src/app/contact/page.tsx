import type { Metadata } from "next";
import { Mail } from "lucide-react";
import { LandingHeader } from "@/components/landing/landing-nav";
import { DISPLAY_FONT, LandingFooter, OperatedBy } from "@/components/landing/landing-sections";
import { CONTACT_EMAIL, OPERATED_BY_LINE, REGISTERED_OFFICE_LINE } from "@/lib/site-operator";

/**
 * /contact (2026-11-11): how to reach MatchTime, and who operates it.
 * Meta reviews the WhatsApp display name "MatchTime" against the site, so
 * the page states the operator in the same words as the footer
 * (`src/lib/site-operator.ts`), plus the registered office. Public
 * (src/lib/public-paths.ts), no session data.
 */
export const metadata: Metadata = {
  title: "Contact",
  description: `How to contact MatchTime. ${OPERATED_BY_LINE}`,
};

export default function ContactPage() {
  return (
    <div className="bg-slate-950 text-slate-100 overflow-x-hidden font-sans">
      <LandingHeader onHome={false} />
      <div className="pt-20 sm:pt-24 bg-slate-950" />
      <section aria-labelledby="contact-heading" className="py-16 sm:py-24 px-5 sm:px-8 bg-white text-slate-800">
        <div className="max-w-2xl mx-auto text-center">
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">Contact</span>
          <h1
            id="contact-heading"
            className="mt-3 text-3xl sm:text-5xl font-extrabold tracking-tight text-slate-900"
            style={DISPLAY_FONT}
          >
            Contact MatchTime
          </h1>
          <p className="mt-5 text-lg text-slate-600">For anything about MatchTime, your club or your details, email us.</p>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="mt-8 inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-base transition-colors"
          >
            <Mail className="w-5 h-5" aria-hidden="true" />
            <span>{CONTACT_EMAIL}</span>
          </a>
          <p className="mt-10 text-base text-slate-600">
            <OperatedBy linkClassName="text-blue-700 underline underline-offset-2 hover:text-blue-800" />
          </p>
          <p className="mt-2 text-base text-slate-600">{REGISTERED_OFFICE_LINE}</p>
        </div>
      </section>
      <LandingFooter />
    </div>
  );
}
