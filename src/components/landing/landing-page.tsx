import Link from "next/link";
import { MessageCircle, Shield, ArrowRight, Check, Sparkles, ShieldCheck } from "lucide-react";
import { StatsShowcase, WrappedCard } from "./stats-showcase";
import { firstMonthsFree } from "@/lib/i18n/free-period";
import { CONNECT_HOW_LONG, holdHowItWorksSentence } from "@/lib/setup-hold-public-copy";
import {
  ASK_CHAT,
  FEATURES,
  HERO_LINKS,
  HERO_POOL_INVITE,
  LANDING_SPOTLIGHTS,
  PERSONAS,
  PLAYER_STAT_CARDS,
  poolOpeningLine,
  HERO,
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
  Stopped,
  SpotlightSection,
  StepList,
} from "./landing-sections";
import { LandingHeader } from "./landing-nav";
import { DropoutSection } from "./dropout-section";
import { KeyFeatures } from "./key-features";
import { PoolSection } from "./pool-section";
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
 * (the /pricing page; a teaser here). The hero's words are `HERO` and the
 * dropout story right after it is `DROPOUT_STORY` (dropout-section.tsx);
 * the steps and the closing call stay here because they are built from
 * the free period and setup-hold helpers.
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
      body: "Sign up and set your weekly match: the format, day, kickoff time, venue and squad size.",
    },
    {
      key: "connect",
      title: "We'll help you add MatchTime to your WhatsApp group",
      body: `Sign up and we'll get your group connected, ${CONNECT_HOW_LONG}.${holdSentence ? ` ${holdSentence}` : ""}`,
    },
    {
      key: "play",
      title: "Play and rate",
      body: "Players say In or Out as normal. Ask for teams, post the score, and everyone gets a rating link. Man of the Match is announced, and next week starts again.",
    },
  ];

  return (
    <div className="bg-slate-950 text-slate-100 overflow-x-hidden font-sans">
      {/* ── Top bar: For clubs and For players menus (landing-nav.tsx) ── */}
      <LandingHeader onHome />

      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <section className="relative pt-20 pb-16 sm:pt-32 sm:pb-24 px-5 sm:px-8">
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

        <div className="relative max-w-6xl mx-auto flex flex-col items-center text-center gap-4 sm:gap-6">
          <p className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-blue-400/10 border border-blue-400/35 text-sm font-semibold text-blue-200">
            <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="#93c5fd" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
              <circle cx="10" cy="10" r="8" />
              <polygon points="10,6.5 13.3,8.9 12,12.8 8,12.8 6.7,8.9" />
            </svg>
            {HERO.pill}
          </p>
          <h1
            className="text-[2.5rem] sm:text-6xl lg:text-7xl font-extrabold tracking-tight leading-[1.05] text-white"
            style={DISPLAY_FONT}
          >
            <span className="block">
              <Stopped text={HERO.titleLead} />
            </span>{" "}
            <span className="block bg-gradient-to-r from-blue-400 via-teal-300 to-emerald-400 bg-clip-text text-transparent">
              <Stopped text={HERO.titleTail} />
            </span>
          </h1>
          <p className="max-w-xl text-[17px] sm:text-xl text-slate-300 leading-relaxed">{HERO.lead}</p>
          <div className="mt-1 sm:mt-2 grid grid-cols-2 sm:flex gap-3 items-stretch sm:items-center justify-center w-full sm:w-auto">
            <Link
              href={HERO_LINKS.primary}
              className="inline-flex items-center justify-center gap-1.5 sm:gap-2 min-h-[52px] px-3 sm:px-7 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-[15px] sm:text-base shadow-xl shadow-blue-500/30 transition-all hover:-translate-y-0.5"
            >
              {HERO.primaryCta}
              <ArrowRight className="w-4 h-4 shrink-0" aria-hidden="true" />
            </Link>
            <Link
              href={HERO_LINKS.secondary}
              className="inline-flex items-center justify-center gap-2 min-h-[52px] px-3 sm:px-7 rounded-xl border-[1.5px] border-slate-500 hover:bg-white/10 text-white font-semibold text-[15px] sm:text-base transition-colors"
            >
              {HERO.secondaryCta}
            </Link>
          </div>
          <ul aria-label="Good to know" className="flex flex-wrap justify-center gap-x-7 gap-y-2.5">
            <li className="inline-flex items-center gap-2 text-[15px] text-slate-200">
              <Check className="w-4 h-4 text-emerald-400" strokeWidth={2.6} aria-hidden="true" />
              {HERO.tick}
            </li>
          </ul>
          {/* The players card (variant D round 2): the pool invitation,
              marked New, with the pulsing button to /play?src=site-hero. */}
          <aside
            aria-labelledby="hero-players-title"
            data-testid="hero-players-card"
            className="mt-2 sm:mt-4 w-full max-w-2xl rounded-2xl border border-emerald-400/45 bg-emerald-950/50 backdrop-blur px-5 py-4 sm:p-6 text-left shadow-[0_0_48px_rgba(16,185,129,0.18)]"
          >
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-400 text-emerald-950 text-[11px] font-extrabold uppercase tracking-wider">
                    {HERO_POOL_INVITE.badge}
                  </span>
                  <span className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">{HERO_POOL_INVITE.eyebrow}</span>
                </div>
                <h2 id="hero-players-title" className="mt-2 text-xl sm:text-2xl font-extrabold tracking-tight text-white" style={DISPLAY_FONT}>
                  {HERO_POOL_INVITE.title}
                </h2>
                <p className="mt-1.5 text-[15px] leading-snug text-slate-200">{HERO_POOL_INVITE.body}</p>
              </div>
              <div className="flex flex-col items-stretch sm:items-center gap-2 shrink-0">
                <PoolInviteButton cta={HERO_POOL_INVITE.cta} testId="hero-pool-cta" />
                <p className="text-xs text-slate-300 text-center">{HERO_POOL_INVITE.smallPrint}</p>
              </div>
            </div>
          </aside>
        </div>
      </section>

      {/* ── What happens when a player drops out (variant D) ──────────── */}
      <DropoutSection />

      {/* ── The key features, one short line each (round 2) ──────────── */}
      <KeyFeatures />

      {/* ── The player pool, for players, straight after (round 2) ───── */}
      {LANDING_SPOTLIGHTS.filter((s) => s.id === "player-pool").map((s) => (
        <PoolSection key={s.id} s={s} openingLine={poolOpeningLine(earlyList)} />
      ))}

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
            lead="Counting names, chasing replies, sorting the bench, picking teams, collecting the money. MatchTime does it in the group you already use."
          />
          <div className="mt-16">
            <CardGrid cards={FEATURES} />
          </div>
        </div>
      </section>

      {/* ── Spotlights: partner clubs, the admin group, the settings (the pool is above) ── */}
      {LANDING_SPOTLIGHTS.filter((s) => s.id !== "player-pool").map((s) => (
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
              lead="Every rating and result builds a stats page each player owns: one tap, no app, no password. Bragging rights drive turnout."
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
                  Players download nothing. Organisers get a dashboard to fix
                  attendance, edit teams, set starting ratings and book a season.
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
              "MatchTime lives in your WhatsApp group and runs your weekly football: attendance, the bench, chasing, partner clubs nearby to fill a missing place, an admin group for organisers, balanced teams, ratings, Man of the Match and optional card or bank payments.",
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
