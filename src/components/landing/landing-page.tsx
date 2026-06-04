import Link from "next/link";
import {
  MessageCircle,
  Scale,
  Star,
  Trophy,
  Users,
  CreditCard,
  Zap,
  Shield,
  ArrowRight,
  Check,
  Sparkles,
  Link2,
  Building2,
  BarChart3,
  Clock,
  Gamepad2,
  TrendingUp,
  Crown,
  Swords,
  Medal,
  Share2,
  Flame,
  ListOrdered,
  ShieldCheck,
} from "lucide-react";
import { StatsShowcase, WrappedCard } from "./stats-showcase";

/**
 * Public marketing landing page served at `/` for signed-out visitors.
 * Signed-in visitors see the player dashboard instead — branching happens
 * in app/page.tsx. Everything here is presentational: no auth state, no
 * data fetching.
 *
 * Typography: body uses Inter (loaded in app/layout.tsx as
 * --font-geist-sans for back-compat); display copy uses Plus Jakarta
 * Sans via `style={{ fontFamily: "var(--font-display)" }}` so headings
 * render in the geometric display face regardless of surrounding CSS.
 * Every heading on a dark section is also explicitly `text-white` so
 * colour never inherits dark-on-dark from the body defaults.
 */
const DISPLAY_FONT: React.CSSProperties = {
  fontFamily: "var(--font-display), system-ui, sans-serif",
};

export function LandingPage() {
  return (
    <div className="bg-slate-950 text-slate-100 overflow-x-hidden font-sans">
      {/* ── Top nav ───────────────────────────────────────────────────── */}
      <header className="absolute top-0 inset-x-0 z-20">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-5 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 group">
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
          <nav className="hidden md:flex items-center gap-7 text-sm text-slate-300">
            <a href="#features" className="hover:text-white transition-colors">
              Features
            </a>
            <a href="#player-stats" className="hover:text-white transition-colors">
              Player stats
            </a>
            <a href="#ask" className="hover:text-white transition-colors">
              Ask anything
            </a>
            <a href="#how-it-works" className="hover:text-white transition-colors">
              How it works
            </a>
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
            maskImage:
              "radial-gradient(ellipse 80% 50% at 50% 40%, black 40%, transparent 80%)",
          }}
        />

        <div className="relative max-w-6xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 border border-white/15 text-xs font-medium text-blue-100 backdrop-blur mb-6">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            AI-powered · Live in WhatsApp · No app install for players
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
            MatchTime reads your WhatsApp group, understands who&apos;s playing,
            balances teams, chases replacements, and handles ratings — so you
            stop refereeing the group chat.
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

          <div className="mt-14 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-xs sm:text-sm text-slate-300">
            <span className="inline-flex items-center gap-1.5">
              <Check className="w-4 h-4 text-emerald-400" />
              No player sign-ups required
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Check className="w-4 h-4 text-emerald-400" />
              Any sport, any format
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Check className="w-4 h-4 text-emerald-400" />
              Multiple groups, multiple admins
            </span>
          </div>
        </div>
      </section>

      {/* ── Features grid ─────────────────────────────────────────────── */}
      <section
        id="features"
        className="relative py-24 sm:py-32 px-5 sm:px-8 bg-slate-50 text-slate-800"
      >
        <div className="max-w-6xl mx-auto">
          <div className="max-w-2xl">
            <span className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">
              Why MatchTime
            </span>
            <h2
              className="mt-3 text-3xl sm:text-5xl font-extrabold tracking-tight text-slate-900"
              style={DISPLAY_FONT}
            >
              The boring admin, done for you.
            </h2>
            <p className="mt-5 text-lg text-slate-600 leading-relaxed">
              Every weekly-match organiser knows the pain: chasing names,
              rebalancing teams, collecting money, nagging late replies,
              arguing over who&apos;s on the bench. MatchTime reads the chat,
              understands it, and handles the whole cycle — in the same group
              you already use.
            </p>
          </div>

          <div className="mt-16 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <FeatureCard
              color="violet"
              icon={<Sparkles className="w-6 h-6" />}
              title="AI reads the group chat"
              body="Claude understands every message — not just 'IN' or 'OUT'. Excuses, conditional commitments, replacement requests and questions all get classified and handled correctly."
            />
            <FeatureCard
              color="green"
              icon={<MessageCircle className="w-6 h-6" />}
              title="Zero-friction attendance"
              body="Players reply naturally in WhatsApp. The bot logs them, reacts with their slot number, and answers 'do we have enough?' questions instantly."
            />
            <FeatureCard
              color="blue"
              icon={<Scale className="w-6 h-6" />}
              title="Auto-balanced teams"
              body="Elo from real match results + per-position composition + peer ratings. Snake-draft seed, hill-climb refine. Posted on match-day morning."
            />
            <FeatureCard
              color="amber"
              icon={<Trophy className="w-6 h-6" />}
              title="Ratings &amp; Man of the Match"
              body="One-tap magic-link DMs collect 1–10 ratings + MoM picks. Votes merge from WhatsApp polls + in-app. Winner announced 5 days later."
            />
            <FeatureCard
              color="purple"
              icon={<Users className="w-6 h-6" />}
              title="Smart bench + replacement chase"
              body="Someone drops, the bot asks the group — and chases again at the right times: match morning, 3 h before, 2 h pre-kickoff. Stops the moment you're full."
            />
            <FeatureCard
              color="teal"
              icon={<CreditCard className="w-6 h-6" />}
              title="Payment polls"
              body="Tick to pay. Posted after every game, tracked in the admin dashboard. No more 'who didn't pay last week' detective work."
            />
            <FeatureCard
              color="rose"
              icon={<Zap className="w-6 h-6" />}
              title="Short-week safety net"
              body="Low numbers? The bot DMs admins the day before with a one-tap switch to a smaller format, or a cancellation if you're below the minimum. No phone-call chains."
            />
            <FeatureCard
              color="blue"
              icon={<Link2 className="w-6 h-6" />}
              title="Magic-link sign-in"
              body="Players never create accounts or remember passwords. Every link the bot DMs signs them in automatically for 5 days."
            />
            <FeatureCard
              color="green"
              icon={<Building2 className="w-6 h-6" />}
              title="Multi-group, multi-admin"
              body="Run Tuesday 7-a-side AND Thursday basketball from the same dashboard. Add or remove admins; everyone gets chase DMs."
            />
            <FeatureCard
              color="amber"
              icon={<BarChart3 className="w-6 h-6" />}
              title="Elo rating that self-calibrates"
              body="Every recorded score updates each player's rating. Margin of victory counts. Over a season the team-balancer actually gets smarter."
            />
            <FeatureCard
              color="violet"
              icon={<Clock className="w-6 h-6" />}
              title="Time-smart reminders"
              body="Daily roll-call at 17:00. Pre-kickoff at T−2 h. Football? Bot reminds the group to bring goalie gloves and a ball. No mental load for you."
            />
            <FeatureCard
              color="teal"
              icon={<Gamepad2 className="w-6 h-6" />}
              title="Any sport, any format"
              body="Football 5/7/11-a-side, futsal, basketball 5v5 or 3v3, netball, volleyball, cricket — or roll your own custom sport with positions and team size."
            />
          </div>
        </div>
      </section>

      {/* ── Player stats & rewards ────────────────────────────────────── */}
      <section
        id="player-stats"
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
            {/* Copy */}
            <div>
              <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">
                <Sparkles className="w-3.5 h-3.5" /> New · Player experience
              </span>
              <h2
                className="mt-3 text-3xl sm:text-5xl font-extrabold tracking-tight text-white"
                style={DISPLAY_FONT}
              >
                Stats that make players
                <br />
                <span className="bg-gradient-to-r from-blue-400 via-teal-300 to-emerald-400 bg-clip-text text-transparent">
                  actually show up.
                </span>
              </h2>
              <p className="mt-5 text-lg text-slate-300 leading-relaxed">
                Every rating and result becomes a season your players care about.
                They open one link — no app, no login — and see how they&apos;re
                really doing, week by week. Bragging rights drive turnout.
              </p>
              <ul className="mt-7 space-y-3">
                {[
                  "Their rating over time, plotted against the whole squad",
                  "A live leaderboard with weekly ↑↓ movement",
                  "Badges, milestones and a shareable season card",
                ].map((b) => (
                  <li key={b} className="flex items-start gap-3 text-slate-200">
                    <Check className="w-5 h-5 text-emerald-400 mt-0.5 shrink-0" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Wrapped share card — faithful recreation, fictional data */}
            <WrappedCard />
          </div>

          {/* Phone mockups — the real screens, recreated sharp (fictional data) */}
          <div className="mt-16">
            <StatsShowcase />
          </div>

          {/* Stat feature grid */}
          <div className="mt-20 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <GlassStat icon={<TrendingUp className="w-5 h-5" />} title="Ratings over time" body="Your line vs the squad average, with 👑 markers on your MoM games. Tap any point for the detail." />
            <GlassStat icon={<Flame className="w-5 h-5" />} title="Form &amp; momentum" body="Hot, cold or steady over your last five — the streak everyone wants to keep alive." />
            <GlassStat icon={<ListOrdered className="w-5 h-5" />} title="Live leaderboard" body="The whole squad ranked by rating, with ↑↓ arrows showing who climbed since last week." />
            <GlassStat icon={<Crown className="w-5 h-5" />} title="Team of the Season" body="The best lineup by position, auto-picked from real ratings. Did you make the cut?" />
            <GlassStat icon={<Users className="w-5 h-5" />} title="Chemistry" body="Who you win most with, and who brings out your best game." />
            <GlassStat icon={<Swords className="w-5 h-5" />} title="Rivalries" body="Your nemesis — and the opponent you own. Settled by results, not banter." />
            <GlassStat icon={<Medal className="w-5 h-5" />} title="Badges" body="Iron Man, MoM Machine, Masterclass and more to unlock as you play." />
            <GlassStat icon={<Share2 className="w-5 h-5" />} title="Season “Wrapped” card" body="A Spotify-Wrapped-style recap players screenshot straight into the group." />
          </div>
        </div>
      </section>

      {/* ── Ask MatchTime anything ─────────────────────────────────────── */}
      <section
        id="ask"
        className="relative py-24 sm:py-32 px-5 sm:px-8 bg-slate-50 text-slate-800"
      >
        <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[0.95fr_1.05fr] gap-12 lg:gap-16 items-center">
          <div>
            <span className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">
              Conversational
            </span>
            <h2
              className="mt-3 text-3xl sm:text-5xl font-extrabold tracking-tight text-slate-900"
              style={DISPLAY_FONT}
            >
              Your group&apos;s match-day brain, on call.
            </h2>
            <p className="mt-5 text-lg text-slate-600 leading-relaxed">
              Players just ask — DM the bot, or tag it in the group — about the
              next match, who&apos;s playing, their own stats, the leaderboard.
              They get a friendly answer back in seconds.
            </p>
            <ul className="mt-7 space-y-3">
              <li className="flex items-start gap-3 text-slate-700">
                <MessageCircle className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
                <span>Answered privately by DM, so the group chat stays clean.</span>
              </li>
              <li className="flex items-start gap-3 text-slate-700">
                <ShieldCheck className="w-5 h-5 text-emerald-500 mt-0.5 shrink-0" />
                <span>
                  Locked to <strong>your</strong>{" "}group&apos;s matches — it can&apos;t
                  reveal phone numbers, other people&apos;s data, or anything off-topic.
                </span>
              </li>
            </ul>
          </div>

          {/* Chat mock */}
          <div className="rounded-3xl bg-white border border-slate-200 shadow-xl p-5 sm:p-7 space-y-4">
            <ChatRow from="player" text="When’s the next match and am I in?" />
            <ChatRow
              from="bot"
              text="Tuesday 9 Jun, 9:30pm at Goals 🟢 You’re confirmed in — full squad of 14. See you there!"
            />
            <ChatRow from="player" text="Who’s top of the leaderboard?" />
            <ChatRow
              from="bot"
              text="Abid’s top on rating right now, and you’re joint-top for attendance at 100% 🙌"
            />
            <ChatRow from="player" text="What’s Elvin’s number?" />
            <ChatRow
              from="bot"
              text="I can’t share anyone’s contact details 🙂 — but I can help with anything about Sutton FC’s matches."
            />
          </div>
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────────────────── */}
      <section
        id="how-it-works"
        className="relative py-24 sm:py-32 px-5 sm:px-8 bg-white text-slate-800"
      >
        <div className="max-w-6xl mx-auto">
          <div className="max-w-2xl mx-auto text-center">
            <span className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">
              How it works
            </span>
            <h2
              className="mt-3 text-3xl sm:text-5xl font-extrabold tracking-tight text-slate-900"
              style={DISPLAY_FONT}
            >
              Three steps to autopilot.
            </h2>
            <p className="mt-5 text-lg text-slate-600">
              Set it up once, play every week. MatchTime takes care of the rest.
            </p>
          </div>

          <ol className="mt-16 grid grid-cols-1 md:grid-cols-3 gap-6">
            <Step
              n={1}
              title="Create your group"
              body="Pick a sport preset (football 7-a-side, basketball 5v5, or custom). Set your venue, day, time and squad size. Takes under five minutes."
            />
            <Step
              n={2}
              title="Add the bot to WhatsApp"
              body="Invite MatchTime's number to your group. It auto-onboards every member, reads the chat every 10 minutes and starts handling attendance, questions and drops."
            />
            <Step
              n={3}
              title="Play &amp; rate"
              body="On match day the bot posts balanced teams, asks for the score, DMs rating links, tallies MoM votes — and does it all again next week."
            />
          </ol>

          <div className="mt-16 p-6 sm:p-10 rounded-2xl bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 border border-white/10 relative overflow-hidden">
            <div
              className="absolute inset-0 opacity-30"
              style={{
                backgroundImage:
                  "radial-gradient(400px circle at 20% 50%, rgba(20,184,166,0.3), transparent 50%)",
              }}
            />
            <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-6 items-center">
              <div>
                <h3
                  className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white"
                  style={DISPLAY_FONT}
                >
                  Built for the admin, invisible to the player.
                </h3>
                <p className="mt-3 text-slate-200 max-w-xl leading-relaxed">
                  Players never have to download anything. Admins get a full
                  dashboard — override positions, seed ratings, switch formats,
                  see every rating ever given. The bot sits in the middle doing
                  the tedious bit.
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
        className="relative py-24 sm:py-32 px-5 sm:px-8 bg-slate-50 text-slate-800"
      >
        <div className="max-w-6xl mx-auto">
          <div className="max-w-2xl">
            <span className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">
              Who it&apos;s for
            </span>
            <h2
              className="mt-3 text-3xl sm:text-5xl font-extrabold tracking-tight text-slate-900"
              style={DISPLAY_FONT}
            >
              If you play every week, this is for you.
            </h2>
          </div>

          <div className="mt-16 grid grid-cols-1 md:grid-cols-2 gap-6">
            <PersonaCard
              role="Organisers &amp; captains"
              bullets={[
                "No more counting ‘IN’ messages or chasing late replies",
                "One tap to drop to a smaller format when numbers are short",
                "Automatic balanced teams instead of arguing over drafts",
                "Every attendance, rating and payment auto-logged",
              ]}
            />
            <PersonaCard
              role="Players"
              bullets={[
                "Chat naturally in WhatsApp — &lsquo;IN&rsquo;, &lsquo;count me in&rsquo;, &lsquo;sorry not tonight&rsquo;, the bot gets it.",
                "Balanced teams every match, no favouritism",
                "A full season of stats: rating timeline, form, chemistry, rivalries &amp; badges",
                "A live leaderboard, Team of the Season &amp; a shareable season card",
                "Ask the bot anything about your matches — by DM or in the group",
              ]}
            />
          </div>

          <div className="mt-14 flex flex-wrap items-center justify-center gap-3 text-sm text-slate-500">
            {[
              "Football 7-a-side",
              "Football 5-a-side",
              "Football 11-a-side",
              "Futsal",
              "Basketball 5v5",
              "Basketball 3v3",
              "Netball",
              "Volleyball",
              "Cricket",
              "Custom sport",
            ].map((s) => (
              <span
                key={s}
                className="inline-flex items-center px-3.5 py-1.5 rounded-full bg-white border border-slate-200 text-slate-700 text-xs font-medium shadow-sm"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ─────────────────────────────────────────────────── */}
      <section className="relative py-24 sm:py-32 px-5 sm:px-8 bg-gradient-to-br from-slate-950 via-blue-950 to-slate-950 overflow-hidden">
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "radial-gradient(600px circle at 50% 50%, rgba(59,130,246,0.3), transparent 60%)",
          }}
        />
        <div className="relative max-w-3xl mx-auto text-center">
          <Shield className="w-10 h-10 mx-auto text-blue-400 mb-5" />
          <h2
            className="text-3xl sm:text-5xl font-extrabold tracking-tight text-white"
            style={DISPLAY_FONT}
          >
            Ready for a quieter
            <br /> match-day morning?
          </h2>
          <p className="mt-5 text-lg text-slate-200 leading-relaxed">
            Set your group up in under five minutes. First month on us — no
            credit card needed.
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
              href="/login"
              className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white/10 hover:bg-white/15 text-white font-medium text-base border border-white/15 backdrop-blur transition-colors"
            >
              Sign in
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
            <a
              href="mailto:admin@cressoft.io"
              className="hover:text-white transition-colors"
            >
              Contact
            </a>
            <a
              href="https://cressoft.io"
              target="_blank"
              rel="noreferrer"
              className="hover:text-white transition-colors"
            >
              By Cressoft
            </a>
          </div>
          <p className="text-xs text-slate-500">
            © {new Date().getFullYear()} MatchTime. All rights reserved.
          </p>
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
              "AI-powered WhatsApp-first attendance, auto-balanced teams, player ratings, Man-of-the-Match voting and payment polls for recurring sports groups.",
            url: "https://matchtime.ai",
            offers: {
              "@type": "Offer",
              price: "0",
              priceCurrency: "GBP",
            },
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

const COLORS = {
  blue: "bg-blue-50 text-blue-600 border-blue-100",
  green: "bg-emerald-50 text-emerald-600 border-emerald-100",
  amber: "bg-amber-50 text-amber-600 border-amber-100",
  purple: "bg-purple-50 text-purple-600 border-purple-100",
  teal: "bg-teal-50 text-teal-600 border-teal-100",
  rose: "bg-rose-50 text-rose-600 border-rose-100",
  violet: "bg-violet-50 text-violet-600 border-violet-100",
} as const;

function FeatureCard({
  color,
  icon,
  title,
  body,
}: {
  color: keyof typeof COLORS;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="group relative p-7 rounded-2xl bg-white border border-slate-200 hover:border-slate-300 hover:shadow-xl shadow-slate-900/5 transition-all hover:-translate-y-1">
      <div
        className={`w-12 h-12 rounded-xl border flex items-center justify-center ${COLORS[color]}`}
      >
        {icon}
      </div>
      <h3
        className="mt-5 text-lg font-bold text-slate-900"
        style={DISPLAY_FONT}
        dangerouslySetInnerHTML={{ __html: title }}
      />
      <p
        className="mt-2 text-sm leading-relaxed text-slate-600"
        dangerouslySetInnerHTML={{ __html: body }}
      />
    </div>
  );
}

function Step({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: string;
}) {
  return (
    <li className="relative p-7 rounded-2xl bg-white border border-slate-200">
      <div className="absolute -top-4 left-7 w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-teal-500 text-white font-black flex items-center justify-center shadow-lg shadow-blue-500/30">
        {n}
      </div>
      <h3
        className="mt-2 text-lg font-bold text-slate-900"
        style={DISPLAY_FONT}
        dangerouslySetInnerHTML={{ __html: title }}
      />
      <p
        className="mt-2 text-sm leading-relaxed text-slate-600"
        dangerouslySetInnerHTML={{ __html: body }}
      />
    </li>
  );
}

function GlassStat({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="group p-5 rounded-2xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all backdrop-blur">
      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/30 to-emerald-500/20 border border-white/10 flex items-center justify-center text-blue-200">
        {icon}
      </div>
      <h3
        className="mt-4 text-base font-bold text-white"
        style={DISPLAY_FONT}
        dangerouslySetInnerHTML={{ __html: title }}
      />
      <p
        className="mt-1.5 text-sm leading-relaxed text-slate-400"
        dangerouslySetInnerHTML={{ __html: body }}
      />
    </div>
  );
}

function ChatRow({ from, text }: { from: "player" | "bot"; text: string }) {
  const isBot = from === "bot";
  return (
    <div className={`flex ${isBot ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[80%] px-4 py-2.5 text-sm leading-relaxed shadow-sm ${
          isBot
            ? "bg-white border border-slate-200 text-slate-700 rounded-2xl rounded-bl-md"
            : "bg-emerald-600 text-white rounded-2xl rounded-br-md"
        }`}
      >
        {isBot && (
          <span className="block text-[11px] font-semibold text-blue-600 mb-0.5">MatchTime</span>
        )}
        {text}
      </div>
    </div>
  );
}

function PersonaCard({ role, bullets }: { role: string; bullets: string[] }) {
  return (
    <div className="p-7 rounded-2xl bg-white border border-slate-200 shadow-sm">
      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-semibold mb-4">
        <Star className="w-3 h-3" />
        <span dangerouslySetInnerHTML={{ __html: role }} />
      </div>
      <ul className="space-y-3">
        {bullets.map((b) => (
          <li key={b} className="flex items-start gap-3 text-sm text-slate-700">
            <Check className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
            <span dangerouslySetInnerHTML={{ __html: b }} />
          </li>
        ))}
      </ul>
    </div>
  );
}
