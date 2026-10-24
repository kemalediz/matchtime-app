import Link from "next/link";
import { MessageCircle, Shield, ArrowRight, Check, Sparkles, ShieldCheck } from "lucide-react";
import { StatsShowcase, WrappedCard } from "./stats-showcase";
import { firstMonthsFree, firstMonthsFreeBadge } from "@/lib/i18n/free-period";
import { t } from "@/lib/i18n/t";
import { PRIVACY_PATH } from "@/lib/privacy-policy";
import { CONNECT_HOW_LONG, holdHowItWorksSentence } from "@/lib/setup-hold-public-copy";
import {
  ASK_CHAT,
  FEATURES,
  LANDING_NAV,
  LANDING_SPOTLIGHTS,
  PERSONAS,
  PLAYER_STAT_CARDS,
  SPORTS,
  type Card,
  type Step,
} from "./landing-content";
import {
  CardGrid,
  ChatMock,
  DISPLAY_FONT,
  FeatureCard,
  PersonaCard,
  SectionIntro,
  SpotlightSection,
  StepList,
} from "./landing-sections";

/**
 * Public marketing landing page served at `/` for signed-out visitors.
 * Signed-in visitors see the player dashboard instead (the branching
 * happens in app/page.tsx). Everything here is presentational: no auth
 * state, no data fetching.
 *
 * The feature lists and the spotlight sections (partner clubs, the admin
 * group, the settings) are data in `landing-content.ts`, laid out by the
 * shared components in `landing-sections.tsx`. A new spotlight section is
 * one entry in `LANDING_SPOTLIGHTS`. The hero, the steps, the pricing and
 * the closing call stay here because they are built from the free period
 * and setup-hold helpers.
 *
 * Typography: body uses Inter (loaded in app/layout.tsx as
 * --font-geist-sans for back-compat); display copy uses Plus Jakarta
 * Sans via `DISPLAY_FONT`. Every heading on a dark section is explicitly
 * `text-white` so colour never inherits dark-on-dark from the body
 * defaults.
 */

/**
 * `holdOn`: SETUP_HOLD_ENABLED as the page that renders this read it
 * (`setupHoldEnabledForRequest`). On, step 2 gains the one sentence about
 * waiting for GO; off, the page reads as it always did.
 */
export function LandingPage({ holdOn = false }: { holdOn?: boolean } = {}) {
  const holdSentence = holdHowItWorksSentence(holdOn);
  const steps: Step[] = [
    {
      key: "sign-up",
      title: "Sign up and create your club",
      body: "Sign up and set your weekly match: sport and format, day, kickoff time, venue and squad size.",
    },
    {
      key: "connect",
      title: "We'll help you add MatchTime to your WhatsApp group",
      body: `Sign up and we'll get your group connected, ${CONNECT_HOW_LONG}.${holdSentence ? ` ${holdSentence}` : ""}`,
    },
    {
      key: "play",
      title: "Play and rate",
      body: "Players just say In or Out as normal, with nothing to install. Ask for teams when you want them, post the score after the game, and everyone gets a rating link. Man of the Match is announced, and it all starts again next week.",
    },
  ];

  return (
    <div className="bg-slate-950 text-slate-100 overflow-x-hidden font-sans">
      {/* ── Top nav ───────────────────────────────────────────────────── */}
      <header className="absolute top-0 inset-x-0 z-20">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-5 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2.5 group shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/matchtime-icon.svg"
              alt="MatchTime"
              className="w-9 h-9 rounded-xl shadow-lg shadow-blue-500/30 transition-transform group-hover:scale-105"
            />
            <span className="font-bold tracking-tight text-lg text-white" style={DISPLAY_FONT}>
              Match<span className="text-blue-400">Time</span>
            </span>
          </Link>
          <nav aria-label="Main" className="hidden lg:flex items-center gap-6 text-sm text-slate-300">
            {LANDING_NAV.map((n) =>
              n.href.startsWith("#") ? (
                <a key={n.href} href={n.href} className="hover:text-white transition-colors">
                  {n.label}
                </a>
              ) : (
                <Link key={n.href} href={n.href} className="hover:text-white transition-colors">
                  {n.label}
                </Link>
              ),
            )}
          </nav>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white text-slate-900 font-semibold text-sm hover:bg-slate-100 transition-colors shadow-sm"
            >
              Sign in
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <section className="relative pt-36 pb-24 sm:pt-44 sm:pb-32 px-5 sm:px-8">
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950 via-blue-950 to-slate-950" />
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "radial-gradient(600px circle at 20% 20%, rgba(59,130,246,0.25), transparent 40%), radial-gradient(800px circle at 80% 60%, rgba(20,184,166,0.18), transparent 50%)",
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",
            backgroundSize: "64px 64px",
            maskImage: "radial-gradient(ellipse 80% 50% at 50% 40%, black 40%, transparent 80%)",
          }}
        />

        <div className="relative max-w-6xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 border border-white/15 text-xs font-medium text-blue-100 backdrop-blur mb-6">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Lives in your WhatsApp group · No app for players
          </div>
          <h1
            className="text-4xl sm:text-6xl lg:text-7xl font-extrabold tracking-tight leading-[1.05] text-white"
            style={DISPLAY_FONT}
          >
            Run your weekly match
            <br />
            <span className="bg-gradient-to-r from-blue-400 via-teal-300 to-emerald-400 bg-clip-text text-transparent">
              on autopilot.
            </span>
          </h1>
          <p className="mt-7 text-base sm:text-lg lg:text-xl text-slate-200 max-w-2xl mx-auto leading-relaxed">
            MatchTime sits in your WhatsApp group and does the organiser&apos;s
            job: it tracks who&apos;s in, runs the bench, chases when you&apos;re
            short, asks partner clubs nearby when you&apos;re still a player
            down, picks balanced teams and collects ratings after the game.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row gap-3 items-center justify-center">
            <Link
              href="/signup"
              className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-gradient-to-br from-blue-500 to-teal-500 hover:from-blue-400 hover:to-teal-400 text-white font-semibold text-base shadow-xl shadow-blue-500/30 transition-all hover:-translate-y-0.5"
            >
              Start your group
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="#how-it-works"
              className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white/10 hover:bg-white/15 text-white font-medium text-base border border-white/15 backdrop-blur transition-colors"
            >
              See how it works
            </Link>
          </div>

          {/* The player pool's invitation (G0 part 2): players with no
              group find the pool section, whose button pulses. */}
          <p className="mt-6 text-sm text-slate-200">
            Looking for a game, not a group?{" "}
            <Link href="#player-pool" className="font-semibold text-emerald-300 underline underline-offset-4 hover:text-emerald-200">
              Join the MatchTime player pool
            </Link>
          </p>

          <div className="mt-14 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-xs sm:text-sm text-slate-300">
            <span className="inline-flex items-center gap-1.5">
              <Check className="w-4 h-4 text-emerald-400" />
              Players just chat as normal
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Check className="w-4 h-4 text-emerald-400" />
              Card or bank payments, if you want them
            </span>
          </div>
        </div>
      </section>

      {/* ── Features grid ─────────────────────────────────────────────── */}
      <section
        id="features"
        aria-labelledby="features-heading"
        className="relative py-24 sm:py-32 px-5 sm:px-8 bg-slate-50 text-slate-800"
      >
        <div className="max-w-6xl mx-auto">
          <SectionIntro
            id="features-heading"
            eyebrow="Why MatchTime"
            title="The boring admin, done for you."
            lead="Every weekly-match organiser knows the drill: counting names, chasing late replies, sorting the bench, picking fair teams and collecting the money. MatchTime handles that whole cycle in the group you already use, and stays out of the way the rest of the time."
          />
          <div className="mt-16">
            <CardGrid cards={FEATURES} />
          </div>
        </div>
      </section>

      {/* ── Spotlights: the player pool, partner clubs, the admin group, the settings ── */}
      {LANDING_SPOTLIGHTS.map((s) => (
        <SpotlightSection key={s.id} s={s} />
      ))}

      {/* ── Player stats & rewards ────────────────────────────────────── */}
      <section
        id="player-stats"
        aria-labelledby="player-stats-heading"
        className="relative py-24 sm:py-32 px-5 sm:px-8 bg-slate-950 text-slate-100 overflow-hidden"
      >
        <div
          className="absolute inset-0 opacity-50"
          style={{
            backgroundImage:
              "radial-gradient(700px circle at 75% 25%, rgba(59,130,246,0.22), transparent 45%), radial-gradient(700px circle at 15% 80%, rgba(16,185,129,0.16), transparent 50%)",
          }}
        />
        <div className="relative max-w-6xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-12 lg:gap-16 items-center">
            <SectionIntro
              id="player-stats-heading"
              tone="dark"
              eyebrow={
                <>
                  <Sparkles className="w-3.5 h-3.5" /> Player stats
                </>
              }
              title={
                <>
                  Stats that make players
                  <br />
                  <span className="bg-gradient-to-r from-blue-400 via-teal-300 to-emerald-400 bg-clip-text text-transparent">
                    actually show up.
                  </span>
                </>
              }
              lead="Every rating and result builds into a stats page each player owns. They tap a link (no app, no password) and see how they're really doing, week by week. Bragging rights drive turnout."
            >
              <ul className="mt-7 space-y-3">
                {[
                  "Their rating over time, plotted against the squad average",
                  "Man of the Match awards, appearances, wins and form",
                  "Who they play best with, plus a live squad leaderboard",
                ].map((b) => (
                  <li key={b} className="flex items-start gap-3 text-slate-200">
                    <Check className="w-5 h-5 text-emerald-400 mt-0.5 shrink-0" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </SectionIntro>

            {/* Wrapped share card: a faithful recreation, fictional data */}
            <WrappedCard />
          </div>

          {/* Phone mockups: the real screens, recreated sharp (fictional data) */}
          <div className="mt-16">
            <StatsShowcase />
          </div>

          <div className="mt-20">
            <CardGrid cards={PLAYER_STAT_CARDS} tone="dark" columns={4} />
          </div>
        </div>
      </section>

      {/* ── Ask MatchTime anything ─────────────────────────────────────── */}
      <section
        id="ask"
        aria-labelledby="ask-heading"
        className="relative py-24 sm:py-32 px-5 sm:px-8 bg-slate-50 text-slate-800"
      >
        <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[0.95fr_1.05fr] gap-12 lg:gap-16 items-center">
          <SectionIntro
            id="ask-heading"
            eyebrow="Conversational"
            title="Your group's match-day brain, on call."
            lead={
              <>
                Players tag <strong>@Match Time</strong> in the group and ask about the next match, who&apos;s
                playing, the leaderboard or anyone&apos;s record this season. Tagged questions are answered
                straight away.
              </>
            }
          >
            <ul className="mt-7 space-y-3">
              <li className="flex items-start gap-3 text-slate-700">
                <MessageCircle className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
                <span>Answered in the group, so everyone sees the same numbers.</span>
              </li>
              <li className="flex items-start gap-3 text-slate-700">
                <ShieldCheck className="w-5 h-5 text-emerald-500 mt-0.5 shrink-0" />
                <span>Ask &ldquo;@Match Time my stats&rdquo; and your own stats page link arrives by DM.</span>
              </li>
            </ul>
          </SectionIntro>

          <ChatMock caption={ASK_CHAT.caption} lines={ASK_CHAT.lines} />
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────────────────── */}
      <section
        id="how-it-works"
        aria-labelledby="how-it-works-heading"
        className="relative py-24 sm:py-32 px-5 sm:px-8 bg-white text-slate-800"
      >
        <div className="max-w-6xl mx-auto">
          <SectionIntro
            id="how-it-works-heading"
            center
            eyebrow="How it works"
            title="Three steps to autopilot."
            lead={
              <>
                Set it up once, play every week. MatchTime takes care of the rest.
                {firstMonthsFree("en")}, and you can remove it from your group any time.
              </>
            }
          />

          <div className="mt-16">
            <StepList steps={steps} />
          </div>

          <div className="mt-16 p-6 sm:p-10 rounded-2xl bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 border border-white/10 relative overflow-hidden">
            <div
              className="absolute inset-0 opacity-30"
              style={{
                backgroundImage: "radial-gradient(400px circle at 20% 50%, rgba(20,184,166,0.3), transparent 50%)",
              }}
            />
            <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-6 items-center">
              <div>
                <h3 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white" style={DISPLAY_FONT}>
                  Built for the organiser, invisible to the player.
                </h3>
                <p className="mt-3 text-slate-200 max-w-xl leading-relaxed">
                  Players never have to download anything. Organisers get a
                  dashboard to fix attendance, edit teams, set starting ratings,
                  book a season and see who still has to rate. MatchTime does
                  the tedious bit in between.
                </p>
              </div>
              <Link
                href="/signup"
                className="inline-flex shrink-0 items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white text-slate-900 font-semibold shadow-xl transition-all hover:-translate-y-0.5"
              >
                Get started
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Who it's for ──────────────────────────────────────────────── */}
      <section
        id="for-whom"
        aria-labelledby="for-whom-heading"
        className="relative py-24 sm:py-32 px-5 sm:px-8 bg-slate-50 text-slate-800"
      >
        <div className="max-w-6xl mx-auto">
          <SectionIntro id="for-whom-heading" eyebrow="Who it's for" title="If you play every week, this is for you." />

          <div className="mt-16 grid grid-cols-1 md:grid-cols-2 gap-6">
            {PERSONAS.map((p) => (
              <PersonaCard key={p.role} role={p.role} bullets={p.bullets} />
            ))}
          </div>

          <ul aria-label="Sports" className="mt-14 flex flex-wrap items-center justify-center gap-3 text-sm text-slate-500">
            {SPORTS.map((s) => (
              <li
                key={s}
                className="inline-flex items-center px-3.5 py-1.5 rounded-full bg-white border border-slate-200 text-slate-700 text-xs font-medium shadow-sm"
              >
                {s}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── Pricing ───────────────────────────────────────────────────── */}
      <section
        id="pricing"
        aria-labelledby="pricing-heading"
        className="relative py-24 sm:py-32 px-5 sm:px-8 bg-white text-slate-800"
      >
        <div className="max-w-6xl mx-auto">
          <div className="max-w-2xl mx-auto text-center">
            <span className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">
              Pricing
            </span>
            <h2
              id="pricing-heading"
              className="mt-3 text-3xl sm:text-5xl font-extrabold tracking-tight text-slate-900"
              style={DISPLAY_FONT}
            >
              One price for the whole group.
            </h2>
            <p className="mt-5 text-lg text-slate-600">
              Up to £9.99 a month per WhatsApp group, not per player, and you
              only pay for the weeks you play. {firstMonthsFree("en")}, so you
              can see how it runs your week before you pay.
            </p>
            <p className="mt-3 text-base text-slate-500">
              Play 3 weeks out of 4 and it&apos;s £7.49. Take a month off and
              it&apos;s nothing.
            </p>
          </div>

          <div className="mt-16 grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-6">
            <div className="p-7 sm:p-10 rounded-2xl bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 border border-white/10 relative overflow-hidden">
              <div
                className="absolute inset-0 opacity-30"
                style={{
                  backgroundImage:
                    "radial-gradient(400px circle at 80% 20%, rgba(20,184,166,0.3), transparent 50%)",
                }}
              />
              <div className="relative">
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-400/15 text-emerald-300 text-xs font-semibold">
                  <Sparkles className="w-3 h-3" />
                  {firstMonthsFreeBadge()}
                </div>
                <div className="mt-5 flex flex-wrap items-baseline gap-2">
                  <span className="text-lg text-slate-300">Up to</span>
                  <span
                    className="text-6xl sm:text-7xl font-extrabold tracking-tight text-white"
                    style={DISPLAY_FONT}
                  >
                    £9.99
                  </span>
                  <span className="text-lg text-slate-300">a month per group</span>
                </div>
                <ul className="mt-7 space-y-3">
                  {[
                    "Everything on this page, for your whole WhatsApp group",
                    "One price, however big your squad is",
                    "Charged after each month, only for the weeks you play",
                    "No contract. Stop any time",
                  ].map((b) => (
                    <li key={b} className="flex items-start gap-3 text-slate-200">
                      <Check className="w-5 h-5 text-emerald-400 mt-0.5 shrink-0" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/signup"
                  className="mt-9 inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white text-slate-900 font-semibold shadow-xl transition-all hover:-translate-y-0.5"
                >
                  Start your group
                  <ArrowRight className="w-4 h-4" />
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

      {/* ── Final CTA ─────────────────────────────────────────────────── */}
      <section className="relative py-24 sm:py-32 px-5 sm:px-8 bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 overflow-hidden">
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage: "radial-gradient(600px circle at 50% 50%, rgba(59,130,246,0.3), transparent 60%)",
          }}
        />
        <div className="relative max-w-3xl mx-auto text-center">
          <Shield className="w-10 h-10 mx-auto text-blue-400 mb-5" />
          <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-white" style={DISPLAY_FONT}>
            Ready for a quieter
            <br /> match-day morning?
          </h2>
          <p className="mt-5 text-lg text-slate-200 leading-relaxed">
            {firstMonthsFree("en")}, then it&apos;s up to £9.99 a month for
            the whole group, and you only pay for the weeks you play. Add it,
            and if you don&apos;t like it, remove it. Card and bank payments
            are there if you want them.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row gap-3 items-center justify-center">
            <Link
              href="/signup"
              className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white text-slate-900 font-semibold text-base shadow-xl transition-all hover:-translate-y-0.5"
            >
              Create your group
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/help/player"
              className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white/10 hover:bg-white/15 text-white font-medium text-base border border-white/15 backdrop-blur transition-colors"
            >
              Read the player guide
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <footer className="bg-slate-950 text-slate-400 py-10 px-5 sm:px-8 border-t border-white/5">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/matchtime-icon.svg" alt="" className="w-7 h-7 rounded-lg" />
            <span className="font-bold text-white" style={DISPLAY_FONT}>
              Match<span className="text-blue-400">Time</span>
            </span>
          </div>
          <div className="flex flex-wrap gap-6 text-sm">
            <Link href="/login" className="hover:text-white transition-colors">
              Sign in
            </Link>
            <Link href="/signup" className="hover:text-white transition-colors">
              Sign up
            </Link>
            <Link href="/help/player" className="hover:text-white transition-colors">
              Player guide
            </Link>
            <Link href="/help/admin" className="hover:text-white transition-colors">
              Organiser guide
            </Link>
            <Link href={PRIVACY_PATH} className="hover:text-white transition-colors">
              {t("en").privacy_link}
            </Link>
            <a href="mailto:hello@matchtime.ai" className="hover:text-white transition-colors">
              Contact
            </a>
            <a href="https://cressoft.io" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">
              By Cressoft
            </a>
          </div>
          <p className="text-xs text-slate-500">© {new Date().getFullYear()} MatchTime. All rights reserved.</p>
        </div>
      </footer>

      {/* JSON-LD for rich results */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "MatchTime",
            applicationCategory: "SportsApplication",
            operatingSystem: "Web, WhatsApp",
            description:
              "MatchTime lives in your WhatsApp group and runs your weekly game: attendance, the bench, chasing, partner clubs nearby to fill a missing place, an admin group for organisers, balanced teams, ratings, Man of the Match and optional card or bank payments.",
            url: "https://matchtime.ai",
            publisher: {
              "@type": "Organization",
              name: "Cressoft",
              url: "https://cressoft.io",
            },
          }),
        }}
      />
    </div>
  );
}

/** The two cards beside the price. Below the page, so the source before
 *  `id="pricing"` carries no price (public-copy.test.ts). */
const PRICING_CARDS: Card[] = [
  {
    key: "share",
    color: "teal",
    icon: "users",
    title: "Share it out if you like",
    body: "The organiser can share the month's fee among the players who played. Even a month charged in full at £9.99, shared by 20 players, works out at about 50p a player.",
  },
  {
    key: "match-fees",
    color: "amber",
    icon: "card",
    title: "Match fees are separate, and optional",
    body: "Switch on pay links and players pay their match fee by card or bank after the game. They pay the card or bank fee on top, so you receive the full match fee. Collecting cash? Leave it off.",
  },
];
