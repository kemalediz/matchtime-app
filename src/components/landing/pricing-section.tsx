/**
 * THE PRICE, ONE SOURCE (Kemal, 2026-10-25): the /pricing page is this
 * section; the home page shows only `PricingHeadline` as a teaser linking
 * here. Both read the words below, so the price can be stated in one
 * place.
 *
 * Lead with the free period, not the price (Kemal: a huge price with the
 * free months as a small badge "looks scary and expensive"): the biggest
 * line is the free period, built from FREE_PERIOD_MONTHS by
 * `firstMonthsFreeBadge` / `firstMonthsFree` (never typed), then, clearly
 * smaller, the price as a maximum for the whole group.
 *
 * Every line is already true: the club fee is up to STANDARD_PRICE_PENCE
 * (club-billing-rules.ts, GBP 4.99 since 2026-10-28) a month per group,
 * charged after each month for the weeks played, no contract. Every amount
 * is read from club-price-words.ts, never typed. Match fees are
 * separate and optional. No em or en dashes; public-copy.test.ts holds the
 * rules.
 */
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { firstMonthsFree, firstMonthsFreeBadge } from "@/lib/i18n/free-period";
import { STANDARD_PRICE_LABEL, standardMonthSharedLabel, standardWeeksPlayedLabel } from "@/lib/club-price-words";
import { PRICING_PATH, type Card } from "./landing-content";
import { DISPLAY_FONT } from "./display-font";
import { FeatureCard } from "./landing-sections";

/** The facts under the price. */
const PRICE_FACTS = [
  "Everything MatchTime does, for your whole WhatsApp group",
  "One price, however big your squad is: not per player",
  "Charged after each month, only for the weeks you play",
  "No contract. Stop any time",
];

/** The two cards beside the price. */
const PRICING_CARDS: Card[] = [
  {
    key: "share",
    color: "teal",
    icon: "users",
    title: "Share it out if you like",
    body: `The organiser can share the month's fee among the players who played. Even a month charged in full at ${STANDARD_PRICE_LABEL}, shared by 20 players, works out at about ${standardMonthSharedLabel(20)} a player.`,
  },
  {
    key: "match-fees",
    color: "amber",
    icon: "card",
    title: "Match fees are separate, and optional",
    body: "Switch on pay links and players pay their match fee by card or bank after the game. They pay the card or bank fee on top, so you receive the full match fee. Collecting cash? Leave it off.",
  },
];

/** The free period, big; then the price, clearly smaller. */
export function PricingHeadline() {
  return (
    <div>
      <p
        data-testid="price-lead"
        className="text-4xl sm:text-6xl font-extrabold tracking-tight leading-[1.05] text-white"
        style={DISPLAY_FONT}
      >
        {firstMonthsFreeBadge()}
      </p>
      <p data-testid="price-amount" className="mt-3 text-lg sm:text-xl text-slate-200">
        then up to <span className="font-bold text-white">{STANDARD_PRICE_LABEL}{" "}a month</span> for the whole group
      </p>
    </div>
  );
}

/**
 * The whole pricing section. `as`: the heading level (the /pricing page's
 * own h1, or h2 inside another page).
 */
export function PricingSection({ as: Heading = "h1" }: { as?: "h1" | "h2" }) {
  return (
    <section id="pricing" aria-labelledby="pricing-heading" className="relative py-16 sm:py-24 px-5 sm:px-8 bg-white text-slate-800">
      <div className="max-w-6xl mx-auto">
        <div className="max-w-2xl mx-auto text-center">
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">Pricing</span>
          <Heading
            id="pricing-heading"
            className="mt-3 text-3xl sm:text-5xl font-extrabold tracking-tight text-slate-900"
            style={DISPLAY_FONT}
          >
            Try it with your group first.
          </Heading>
          <p className="mt-5 text-lg text-slate-600">
            {firstMonthsFree("en")}, so you can see how it runs your week before you pay. After that it&apos;s up
            to {STANDARD_PRICE_LABEL}{" "}a month per WhatsApp group, not per player, and you only pay for the weeks you play.
          </p>
          <p className="mt-3 text-base text-slate-500">
            Play 3 weeks out of 4 and it&apos;s {standardWeeksPlayedLabel(3, 4)}. Take a month off and it&apos;s nothing.
          </p>
        </div>

        <div className="mt-12 sm:mt-16 grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-6">
          <div className="p-7 sm:p-10 rounded-2xl bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 border border-white/10 relative overflow-hidden">
            <div
              aria-hidden="true"
              className="absolute inset-0 opacity-30"
              style={{ backgroundImage: "radial-gradient(400px circle at 80% 20%, rgba(20,184,166,0.3), transparent 50%)" }}
            />
            <div className="relative">
              <PricingHeadline />
              <ul className="mt-7 space-y-3">
                {PRICE_FACTS.map((b) => (
                  <li key={b} className="flex items-start gap-3 text-slate-200">
                    <Check className="w-5 h-5 text-emerald-400 mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className="mt-9 inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white text-slate-900 font-semibold shadow-xl transition-all hover:-translate-y-0.5"
              >
                Start your group
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6">
            {PRICING_CARDS.map((c) => (
              <FeatureCard key={c.key} card={c} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** The home page's teaser: the headline, and the way to the full page. */
export function PricingTeaser() {
  return (
    <section id="pricing" aria-labelledby="pricing-teaser-heading" className="relative py-16 sm:py-24 px-5 sm:px-8 bg-white text-slate-800">
      <div className="max-w-3xl mx-auto">
        <h2 id="pricing-teaser-heading" className="text-center text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">
          Pricing
        </h2>
        <div className="mt-6 p-7 sm:p-10 rounded-2xl bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 border border-white/10 text-center">
          <PricingHeadline />
          <Link
            href={PRICING_PATH}
            className="mt-7 inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-white text-slate-900 font-semibold shadow-xl hover:-translate-y-0.5 transition-all"
          >
            See pricing
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
