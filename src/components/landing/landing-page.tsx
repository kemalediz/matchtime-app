import Link from "next/link";
import { MessageCircle, Shield, ArrowRight, Check, Sparkles, ShieldCheck, Users } from "lucide-react";
import { StatsShowcase, WrappedCard } from "./stats-showcase";
import { firstMonthsFree } from "@/lib/i18n/free-period";
import { CONNECT_HOW_LONG, holdHowItWorksSentence } from "@/lib/setup-hold-public-copy";
import {
  ASK_CHAT,
  FEATURES,
  HERO_POOL_INVITE,
  LANDING_SPOTLIGHTS,
  PERSONAS,
  PLAYER_STAT_CARDS,
  SPORTS,
  spotlightFor,
  type Step,
} from "./landing-content";
import {
  CardGrid,
  ChatMock,
  DISPLAY_FONT,
  LandingFooter,
  PersonaCard,
  PoolInviteButton,
  SectionIntro,
  SpotlightSection,
  StepList,
} from "./landing-sections";
import { LandingHeader } from "./landing-nav";
import { PricingTeaser } from "./pricing-section";

/**
 * Public marketing landing page served at `/` for signed-out visitors.
 * Signed-in visitors see the player dashboard instead (the branching
 * happens in app/page.tsx). Everything here is presentational: no auth
 * state, no data fetching.
 *
 * The feature lists and the spotlight sections (partner clubs, the admin
 * group, the settings) are data in `landing-content.ts`, laid out by the
 * shared components in `landing-sections.tsx`. A new spotlight section is
 * one entry in `LANDING_SPOTLIGHTS`. The price lives in pricing-section.tsx
 * (the /pricing page; a teaser here). The hero, the steps and the closing
 * call stay here because they are built from the free period
 * and setup-hold helpers.
 *
 * Typography: body uses Inter (loaded in app/layout.tsx as
 * --font-geist-sans for back-compat); display copy uses Plus Jakarta
 * Sans via `DISPLAY_FONT`. Every heading on a dark section is explicitly
 * `text-white` so colour never inherits dark-on-dark from the body
 * defaults.
 */

/**
 * `earlyList`: will a pool sign-up made now go on the early sign-up list
 * (`signupGoesOnEarlyListForPage`)? The pool section says so only then.
 *
 * `holdOn`: SETUP_HOLD_ENABLED as the page that renders this read it
 * (`setupHoldEnabledForRequest`). On, step 2 gains the one sentence about
 * waiting for GO; off, the page reads as it always did.
 */
export function LandingPage({ holdOn = false, earlyList = true }: { holdOn?: boolean; earlyList?: boolean } = {}) {
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
      {/* ── Top bar: For clubs and For players menus (landing-nav.tsx) ── */}
      <LandingHeader onHome />

      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <section className="relative pt-24 pb-20 sm:pt-32 sm:pb-28 px-5 sm:px-8">
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
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 border border-white/15 text-xs font-medium text-blue-100 backdrop-blur mb-4 sm:mb-6">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 motion-safe:animate-pulse" />
            Lives in your WhatsApp group · No app for players
          </div>
          <h1
            className="text-4xl sm:text-6xl font-extrabold tracking-tight leading-[1.05] text-white"
            style={DISPLAY_FONT}
          >
            Run your weekly match
            <br />
            <span className="bg-gradient-to-r from-blue-400 via-teal-300 to-emerald-400 bg-clip-text text-transparent">
              on autopilot.
            </span>
          </h1>
          <p className="mt-4 sm:mt-6 text-[15px] sm:text-lg lg:text-xl text-slate-200 max-w-2xl mx-auto leading-relaxed">
            MatchTime sits in your WhatsApp group and does the organiser&apos;s
            job: it tracks who&apos;s in, runs the bench, chases when you&apos;re
            short, asks partner clubs nearby when you&apos;re still a player
            down, picks balanced teams and collects ratings after the game.
          </p>
          <div className="mt-6 sm:mt-8 grid grid-cols-2 sm:flex sm:flex-row gap-3 items-center justify-center">
            <Link
              href="/signup"
              className="inline-flex items-center justify-center gap-2 px-4 sm:px-7 py-3 sm:py-3.5 rounded-xl bg-gradient-to-br from-blue-500 to-teal-500 hover:from-blue-400 hover:to-teal-400 text-white font-semibold text-sm sm:text-base shadow-xl shadow-blue-500/30 transition-all hover:-translate-y-0.5"
            >
              Start your group
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="#how-it-works"
              className="inline-flex items-center justify-center gap-2 px-4 sm:px-7 py-3 sm:py-3.5 rounded-xl bg-white/10 hover:bg-white/15 text-white font-medium text-sm sm:text-base border border-white/15 backdrop-blur transition-colors"
            >
              See how it works
            </Link>
          </div>

          {/* The players' invitation (Kemal, 2026-10-25): its own panel
              under the organisers' buttons, on the first screen at phone
              width, with the pulsing button. Payments are described in the
              features and pricing further down, not here. */}
          <PlayerPoolPanel />
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
        <SpotlightSection key={s.id} s={spotlightFor(s, earlyList)} />
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

      {/* ── Pricing teaser: the free period first; the full page is /pricing ── */}
      <PricingTeaser />

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

      <LandingFooter />

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

/**
 * The hero's invitation to players: a panel of its own, so a player who
 * has no group sees what is in it for him on the first screen. The copy
 * is `HERO_POOL_INVITE`; the button is the shared pulsing one.
 */
function PlayerPoolPanel() {
  const h = HERO_POOL_INVITE;
  return (
    <section
      aria-labelledby="hero-pool-heading"
      className="mt-6 sm:mt-10 mx-auto max-w-4xl rounded-2xl border border-emerald-300/30 bg-emerald-400/10 p-4 sm:p-6 text-left shadow-xl shadow-emerald-900/30 backdrop-blur lg:grid lg:grid-cols-[1fr_auto] lg:items-center lg:gap-8"
    >
      <div className="flex items-start gap-4">
        <span className="hidden sm:inline-flex shrink-0 items-center justify-center w-11 h-11 rounded-xl bg-emerald-400/20 text-emerald-300">
          <Users className="w-6 h-6" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">{h.eyebrow}</p>
          <h2 id="hero-pool-heading" className="mt-1 text-lg sm:text-2xl font-extrabold leading-snug text-white" style={DISPLAY_FONT}>
            {h.title}
          </h2>
          <p className="mt-1.5 text-sm sm:text-base text-slate-200 leading-relaxed">{h.body}</p>
        </div>
      </div>
      <div className="mt-3 lg:mt-0 flex flex-col items-stretch sm:items-center gap-2">
        <PoolInviteButton cta={h.cta} testId="hero-pool-cta" />
        <Link href={h.more.href} className="text-center text-sm font-semibold text-emerald-200 underline underline-offset-4 hover:text-white">
          {h.more.label}
        </Link>
        <p className="text-center text-xs text-slate-300">{h.smallPrint}</p>
      </div>
    </section>
  );
}
