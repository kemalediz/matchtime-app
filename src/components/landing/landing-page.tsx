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
            <Link href="/help/player" className="hover:text-white transition-colors">
              Player guide
            </Link>
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
            Free to use · Lives in your WhatsApp group · No app for players
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
            short, picks balanced teams and collects ratings after the game.
            Add it to your group for free. Don&apos;t like it? Remove it.
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
              Free to use
            </span>
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
              Every weekly-match organiser knows the drill: counting names,
              chasing late replies, sorting the bench, picking fair teams and
              collecting the money. MatchTime handles that whole cycle in the
              group you already use, and stays out of the way the rest of the
              time.
            </p>
          </div>

          <div className="mt-16 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <FeatureCard
              color="green"
              icon={<MessageCircle className="w-6 h-6" />}
              title="Tracks who&apos;s in"
              body="Players say In or Out the way they always have. MatchTime ticks each one with ✅ and keeps the squad list. Say &ldquo;maybe&rdquo; and it checks back with you by DM a day before kickoff."
            />
            <FeatureCard
              color="purple"
              icon={<Users className="w-6 h-6" />}
              title="Runs the bench"
              body="When the squad is full, late Ins go on the bench 🪑. When someone drops, the bench is offered the spot in the group and by DM, and the first to claim it plays."
            />
            <FeatureCard
              color="rose"
              icon={<Zap className="w-6 h-6" />}
              title="Chases when short, stops when full"
              body="Short of players? MatchTime asks the group in its daily update, on match morning and in the last hours before kickoff. The moment you&apos;re full, it stops. Admins can also ask it to invite recent players by DM."
            />
            <FeatureCard
              color="blue"
              icon={<Scale className="w-6 h-6" />}
              title="Balanced teams when you ask"
              body="Tag it with &ldquo;@Match Time generate the teams&rdquo; and it splits the confirmed squad using each player&apos;s rating and position. Admins can swap players or edit the teams from the dashboard."
            />
            <FeatureCard
              color="amber"
              icon={<Trophy className="w-6 h-6" />}
              title="Ratings &amp; Man of the Match"
              body="After the game every player gets a private link to rate the others from 1 to 10 and pick a Man of the Match. The winner is announced in the group once everyone has voted."
            />
            <FeatureCard
              color="violet"
              icon={<BarChart3 className="w-6 h-6" />}
              title="Stats questions, answered in the group"
              body="Ask &ldquo;@Match Time top 5 rated players this season&rdquo; or &ldquo;who&apos;s played the most?&rdquo; and the answer is posted right there for everyone to see."
            />
            <FeatureCard
              color="teal"
              icon={<CreditCard className="w-6 h-6" />}
              title="Payments, if you want them"
              body="Switch on card or bank payments and each player gets a pay link after the game. MatchTime chases whoever hasn&apos;t paid, so you stop doing the money chase yourself."
            />
            <FeatureCard
              color="green"
              icon={<ShieldCheck className="w-6 h-6" />}
              title="Quiet during the banter"
              body="MatchTime only speaks when it&apos;s tagged, or when someone says In or Out. The jokes and the arguments about last week&apos;s penalty are left alone. Tagged messages are answered straight away."
            />
            <FeatureCard
              color="blue"
              icon={<Link2 className="w-6 h-6" />}
              title="Replacements that just work"
              body="&ldquo;Sam is replacing Joe&rdquo; and Sam takes Joe&apos;s place in the squad. If the teams are already out, Sam steps into Joe&apos;s team too."
            />
            <FeatureCard
              color="rose"
              icon={<Clock className="w-6 h-6" />}
              title="Short-week safety net"
              body="Numbers low the day before? Admins get a DM offering a switch to a smaller format, or a cancellation if you&apos;re below the minimum. No phone-call chains."
            />
            <FeatureCard
              color="amber"
              icon={<Building2 className="w-6 h-6" />}
              title="Book the whole season"
              body="Set up a season of weekly matches in one go, then cancel the holiday weeks in bulk. Game-day reminders tell the group to bring gloves, a ball and bibs."
            />
            <FeatureCard
              color="teal"
              icon={<Gamepad2 className="w-6 h-6" />}
              title="No accounts, no passwords"
              body="Players never download an app or remember a password. Every link MatchTime sends signs them straight in, and they can reply &ldquo;stop&rdquo; to turn off the DMs they don&apos;t want."
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
                <Sparkles className="w-3.5 h-3.5" /> Player stats
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
                Every rating and result builds into a stats page each player
                owns. They tap a link (no app, no password) and see how
                they&apos;re really doing, week by week. Bragging rights drive
                turnout.
              </p>
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
            <GlassStat icon={<Flame className="w-5 h-5" />} title="Form &amp; momentum" body="Hot, cold or steady over your last five games: the streak everyone wants to keep alive." />
            <GlassStat icon={<ListOrdered className="w-5 h-5" />} title="Live leaderboard" body="The whole squad ranked by rating, with ↑↓ arrows showing who climbed since last week&apos;s match." />
            <GlassStat icon={<Crown className="w-5 h-5" />} title="Team of the Season" body="The best lineup by position, auto-picked from real ratings. Did you make the cut?" />
            <GlassStat icon={<Users className="w-5 h-5" />} title="Chemistry" body="Who you win most with, and who brings out your best game." />
            <GlassStat icon={<Swords className="w-5 h-5" />} title="Rivalries" body="Your nemesis, and the opponent you own. Settled by results, not banter." />
            <GlassStat icon={<Medal className="w-5 h-5" />} title="Badges" body="Iron Man, MoM Machine, Masterclass and more to unlock as you play." />
            <GlassStat icon={<Share2 className="w-5 h-5" />} title="Season “Wrapped” card" body="A season recap card players screenshot straight into the group." />
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
              Players tag <strong>@Match Time</strong> in the group and ask
              about the next match, who&apos;s playing, the leaderboard or
              anyone&apos;s record this season. Tagged questions are answered
              straight away.
            </p>
            <ul className="mt-7 space-y-3">
              <li className="flex items-start gap-3 text-slate-700">
                <MessageCircle className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
                <span>Answered in the group, so everyone sees the same numbers.</span>
              </li>
              <li className="flex items-start gap-3 text-slate-700">
                <ShieldCheck className="w-5 h-5 text-emerald-500 mt-0.5 shrink-0" />
                <span>
                  Ask &ldquo;@Match Time my stats&rdquo; and your own stats page link arrives by DM.
                </span>
              </li>
            </ul>
          </div>

          {/* Chat mock */}
          <div className="rounded-3xl bg-white border border-slate-200 shadow-xl p-5 sm:p-7 space-y-4">
            <ChatRow from="player" text="@Match Time when’s the next match and am I in?" />
            <ChatRow
              from="bot"
              text="Tuesday at 8pm, Riverside Sports Centre 🟢 You’re confirmed. 12 of 14 in so far."
            />
            <ChatRow from="player" text="@Match Time top 5 rated players this season" />
            <ChatRow
              from="bot"
              text="1. Marcus 8.1  2. Danny 7.9  3. Alex 7.4  4. Ryan 7.4  5. Sam 7.4"
            />
            <ChatRow from="player" text="@Match Time who’s played the most?" />
            <ChatRow
              from="bot"
              text="Danny, with 24 games this season. Marcus is next on 22 👀"
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
              It&apos;s free, and you can remove it from your group any time.
            </p>
          </div>

          <ol className="mt-16 grid grid-cols-1 md:grid-cols-3 gap-6">
            <Step
              n={1}
              title="Create your club"
              body="Sign up and set your weekly match: sport and format, day, kickoff time, venue and squad size."
            />
            <Step
              n={2}
              title="Add MatchTime to your WhatsApp group"
              body="Add the MatchTime number to your group and we connect it to your club. Players don&apos;t install anything; they keep saying In and Out as normal."
            />
            <Step
              n={3}
              title="Play &amp; rate"
              body="Ask for teams when you want them, post the score after the game, and everyone gets a rating link. Man of the Match is announced, and it all starts again next week."
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
                "A bench that sorts itself out when someone drops",
                "Balanced teams when you ask, instead of arguing over picks",
                "Attendance, ratings and payments logged for you",
              ]}
            />
            <PersonaCard
              role="Players"
              bullets={[
                "Chat as normal: &lsquo;IN&rsquo;, &lsquo;count me in&rsquo;, &lsquo;sorry not tonight&rsquo;",
                "Balanced teams, no favouritism",
                "Your own stats page: rating over time, MoMs, wins, chemistry &amp; badges",
                "A live leaderboard, Team of the Season &amp; a season card to share",
                "Ask @Match Time about your matches, right in the group",
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
            MatchTime is free to use. Add it to your group, and if you
            don&apos;t like it, remove it. Card and bank payments are there
            if you want them.
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
              "MatchTime lives in your WhatsApp group and runs your weekly game: attendance, the bench, chasing, balanced teams, ratings, Man of the Match and optional card or bank payments. Free to use.",
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
