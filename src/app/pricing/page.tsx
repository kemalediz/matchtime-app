import type { Metadata } from "next";
import { LandingHeader } from "@/components/landing/landing-nav";
import { LandingFooter } from "@/components/landing/landing-sections";
import { PricingSection } from "@/components/landing/pricing-section";

/**
 * /pricing (2026-10-25): the price's own page, linked from the For clubs
 * menu and the home page's teaser. Public (src/lib/public-paths.ts), no
 * session data. Its description carries no price (Kemal, 2026-10-01: no
 * price in search results or link previews).
 */
export const metadata: Metadata = {
  title: "Pricing",
  description: "What MatchTime costs a club: one price for the whole WhatsApp group, only for the weeks you play.",
};

export default function PricingPage() {
  return (
    <div className="bg-slate-950 text-slate-100 overflow-x-hidden font-sans">
      <LandingHeader onHome={false} />
      <div className="pt-20 sm:pt-24 bg-slate-950" />
      <PricingSection as="h1" />
      <LandingFooter />
    </div>
  );
}
