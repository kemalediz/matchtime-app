/**
 * The landing page's shared building blocks: the section heading, the
 * cards, the numbered steps, the chat mock and the spotlight section that
 * puts them together from a `Spotlight` entry in `landing-content.ts`.
 * Presentational only: no data fetching, no auth state.
 *
 * Text is rendered as text (no `dangerouslySetInnerHTML`): the content is
 * plain words.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Bell,
  Building2,
  Calendar,
  CalendarX,
  Check,
  ClipboardList,
  Clock,
  CreditCard,
  Crown,
  Flame,
  Gamepad2,
  Hand,
  Handshake,
  Image as ImageIcon,
  Languages,
  Link2,
  ListOrdered,
  Lock,
  MapPin,
  Medal,
  Megaphone,
  MessageCircle,
  Pencil,
  Repeat,
  Scale,
  Share2,
  ShieldCheck,
  Sparkles,
  Shuffle,
  Star,
  Swords,
  TrendingUp,
  Trophy,
  UserPlus,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { t } from "@/lib/i18n/t";
import { DISPLAY_FONT } from "./display-font";
import { PRIVACY_PATH } from "@/lib/privacy-policy";
import type { Card, ChatLine, ColorKey, Cta, IconKey, Spotlight, Step } from "./landing-content";
import { HERO_POOL_INVITE } from "./landing-content";
import { ChatDrawing } from "./chat-drawing";

export { DISPLAY_FONT };

const ICONS: Record<IconKey, LucideIcon> = {
  message: MessageCircle,
  users: Users,
  zap: Zap,
  scale: Scale,
  trophy: Trophy,
  chart: BarChart3,
  card: CreditCard,
  "shield-check": ShieldCheck,
  link: Link2,
  clock: Clock,
  building: Building2,
  gamepad: Gamepad2,
  trending: TrendingUp,
  flame: Flame,
  list: ListOrdered,
  crown: Crown,
  swords: Swords,
  medal: Medal,
  share: Share2,
  handshake: Handshake,
  "map-pin": MapPin,
  clipboard: ClipboardList,
  pencil: Pencil,
  shuffle: Shuffle,
  "calendar-x": CalendarX,
  image: ImageIcon,
  hand: Hand,
  bell: Bell,
  repeat: Repeat,
  calendar: Calendar,
  megaphone: Megaphone,
  languages: Languages,
  "user-plus": UserPlus,
};

export function Icon({ k, className }: { k: IconKey; className?: string }) {
  const C = ICONS[k];
  return <C className={className} aria-hidden="true" />;
}

const COLORS: Record<ColorKey, string> = {
  blue: "bg-blue-50 text-blue-600 border-blue-100",
  green: "bg-emerald-50 text-emerald-600 border-emerald-100",
  amber: "bg-amber-50 text-amber-600 border-amber-100",
  purple: "bg-purple-50 text-purple-600 border-purple-100",
  teal: "bg-teal-50 text-teal-600 border-teal-100",
  rose: "bg-rose-50 text-rose-600 border-rose-100",
  violet: "bg-violet-50 text-violet-600 border-violet-100",
};

type Tone = "light" | "dark";

/** The eyebrow, heading and lead every section opens with. */
export function SectionIntro({
  id,
  eyebrow,
  title,
  lead,
  tone = "light",
  center = false,
  children,
}: {
  /** The heading's id, for the section's `aria-labelledby`. */
  id?: string;
  eyebrow: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  tone?: Tone;
  center?: boolean;
  children?: ReactNode;
}) {
  const dark = tone === "dark";
  return (
    <div className={center ? "max-w-2xl mx-auto text-center" : "max-w-2xl"}>
      <span
        className={`inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] ${
          dark ? "text-emerald-300" : "text-blue-600"
        }`}
      >
        {eyebrow}
      </span>
      <h2
        id={id}
        className={`mt-3 text-3xl sm:text-5xl font-extrabold tracking-tight ${dark ? "text-white" : "text-slate-900"}`}
        style={DISPLAY_FONT}
      >
        {title}
      </h2>
      {lead && (
        <p className={`mt-5 text-lg leading-relaxed ${dark ? "text-slate-300" : "text-slate-600"}`}>{lead}</p>
      )}
      {children}
    </div>
  );
}

/** A feature card, on a light section or a dark one. */
export function FeatureCard({ card, tone = "light" }: { card: Card; tone?: Tone }) {
  if (tone === "dark") {
    return (
      <div className="p-6 rounded-2xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all backdrop-blur">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/30 to-emerald-500/20 border border-white/10 flex items-center justify-center text-blue-200">
          <Icon k={card.icon} className="w-5 h-5" />
        </div>
        <h3 className="mt-4 text-base font-bold text-white" style={DISPLAY_FONT}>
          {card.title}
        </h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{card.body}</p>
      </div>
    );
  }
  return (
    <div className="group relative p-7 rounded-2xl bg-white border border-slate-200 hover:border-slate-300 hover:shadow-xl shadow-slate-900/5 transition-all hover:-translate-y-1">
      <div className={`w-12 h-12 rounded-xl border flex items-center justify-center ${COLORS[card.color]}`}>
        <Icon k={card.icon} className="w-6 h-6" />
      </div>
      <h3 className="mt-5 text-lg font-bold text-slate-900" style={DISPLAY_FONT}>
        {card.title}
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{card.body}</p>
    </div>
  );
}

/** A grid of cards. */
export function CardGrid({ cards, tone = "light", columns = 3 }: { cards: Card[]; tone?: Tone; columns?: 3 | 4 }) {
  const cols = columns === 4 ? "sm:grid-cols-2 lg:grid-cols-4 gap-4" : "md:grid-cols-2 lg:grid-cols-3 gap-6";
  return (
    <div className={`grid grid-cols-1 ${cols}`}>
      {cards.map((c) => (
        <FeatureCard key={c.key} card={c} tone={tone} />
      ))}
    </div>
  );
}

/** One numbered step, inside an `<ol>`. */
export function StepItem({ n, step, tone = "light" }: { n: number; step: Step; tone?: Tone }) {
  const dark = tone === "dark";
  return (
    <li
      className={`relative p-7 rounded-2xl border ${
        dark ? "bg-white/5 border-white/10 backdrop-blur" : "bg-white border-slate-200"
      }`}
    >
      <div
        aria-hidden="true"
        className="absolute -top-4 left-7 w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-teal-500 text-white font-black flex items-center justify-center shadow-lg shadow-blue-500/30"
      >
        {n}
      </div>
      <h3 className={`mt-2 text-lg font-bold ${dark ? "text-white" : "text-slate-900"}`} style={DISPLAY_FONT}>
        {step.title}
      </h3>
      <p className={`mt-2 text-sm leading-relaxed ${dark ? "text-slate-300" : "text-slate-600"}`}>{step.body}</p>
    </li>
  );
}

/** A row of numbered steps. */
export function StepList({ steps, label, tone = "light" }: { steps: Step[]; label?: string; tone?: Tone }) {
  const cols = steps.length === 4 ? "md:grid-cols-2 lg:grid-cols-4" : "md:grid-cols-3";
  return (
    <ol aria-label={label} className={`grid grid-cols-1 ${cols} gap-x-6 gap-y-10`}>
      {steps.map((s, i) => (
        <StepItem key={s.key} n={i + 1} step={s} tone={tone} />
      ))}
    </ol>
  );
}

/** One chat bubble in a mock conversation. */
export function ChatRow({ line }: { line: ChatLine }) {
  const isBot = line.from === "bot";
  return (
    <div className={`flex ${isBot ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[85%] px-4 py-2.5 text-sm leading-relaxed shadow-sm break-words ${
          isBot
            ? "bg-white border border-slate-200 text-slate-700 rounded-2xl rounded-bl-md"
            : "bg-emerald-600 text-white rounded-2xl rounded-br-md"
        }`}
      >
        {isBot && <span className="block text-[11px] font-semibold text-blue-600 mb-0.5">MatchTime</span>}
        {line.text}
      </div>
    </div>
  );
}

/** A mock conversation, named by its caption for screen readers. */
export function ChatMock({ caption, lines }: { caption: string; lines: ChatLine[] }) {
  return (
    <figure
      className="rounded-3xl bg-slate-50 border border-slate-200 shadow-xl p-5 sm:p-7 space-y-4 text-left"
    >
      {lines.map((l, i) => (
        <ChatRow key={i} line={l} />
      ))}
      <figcaption className="pt-1 text-xs text-slate-500 text-center">{caption}</figcaption>
    </figure>
  );
}

/** A boxed list of short promises (the partner clubs' privacy). */
export function NoteBox({ title, items, tone }: { title: string; items: Array<{ key: string; text: string }>; tone: Tone }) {
  const dark = tone === "dark";
  return (
    <div
      className={`p-6 sm:p-8 rounded-2xl border ${
        dark ? "bg-emerald-400/5 border-emerald-300/20" : "bg-emerald-50 border-emerald-100"
      }`}
    >
      <h3
        className={`flex items-center gap-2 text-lg font-bold ${dark ? "text-white" : "text-slate-900"}`}
        style={DISPLAY_FONT}
      >
        <Lock className={`w-5 h-5 ${dark ? "text-emerald-300" : "text-emerald-600"}`} aria-hidden="true" />
        {title}
      </h3>
      <ul className="mt-4 space-y-3">
        {items.map((it) => (
          <li key={it.key} className={`flex items-start gap-3 text-sm ${dark ? "text-slate-200" : "text-slate-700"}`}>
            <Check className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" aria-hidden="true" />
            <span>{it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SECTION_TONE: Record<Tone, string> = {
  light: "bg-white text-slate-800",
  dark: "bg-slate-950 text-slate-100",
};

/**
 * A spotlight section from its content entry: heading and lead (with the
 * example chat beside them when there is one), the numbered steps, the
 * cards, the boxed note and a closing line.
 */
export function SpotlightSection({ s }: { s: Spotlight }) {
  const headingId = `${s.id}-heading`;
  const dark = s.tone === "dark";
  return (
    <section
      id={s.id}
      aria-labelledby={headingId}
      className={`relative py-24 sm:py-32 px-5 sm:px-8 overflow-hidden scroll-mt-4 ${SECTION_TONE[s.tone]}`}
    >
      {dark && (
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-50"
          style={{
            backgroundImage:
              "radial-gradient(700px circle at 80% 20%, rgba(20,184,166,0.18), transparent 45%), radial-gradient(700px circle at 10% 85%, rgba(59,130,246,0.18), transparent 50%)",
          }}
        />
      )}
      <div className="relative max-w-6xl mx-auto">
        <div
          className={
            s.chat ? "grid grid-cols-1 lg:grid-cols-[1.05fr_0.95fr] gap-12 lg:gap-16 items-center" : undefined
          }
        >
          <div>
            <SectionIntro id={headingId} eyebrow={s.eyebrow} title={s.title} lead={s.lead} tone={s.tone} />
            {s.cta && <SpotlightCta cta={s.cta} />}
          </div>
          {s.chat && <ChatMock caption={s.chat.caption} lines={s.chat.lines} />}
        </div>

        {s.steps && (
          <div className="mt-16">
            <StepList steps={s.steps} label={s.stepsLabel} tone={s.tone} />
          </div>
        )}

        <div className="mt-12">
          <CardGrid cards={s.points} tone={s.tone} />
        </div>

        {s.note && (
          <div className="mt-12">
            <NoteBox title={s.note.title} items={s.note.items} tone={s.tone} />
          </div>
        )}

        {s.footnote && (
          <p className={`mt-10 text-sm ${dark ? "text-slate-400" : "text-slate-500"}`}>{s.footnote}</p>
        )}
      </div>
    </section>
  );
}

/**
 * The players' card in the hero (round two, 2026-10-26): a "New" badge, the
 * call-up, one line, the strong pulsing button and the small print. Stacked
 * on a phone, one row on desktop; on the first screen at both.
 */
export function HeroPlayersCard() {
  const h = HERO_POOL_INVITE;
  return (
    // A plain div, not <aside>: the app shell's signed-in sidebar is the
    // page's only <aside> (the e2e session checks rely on it).
    <div
      data-testid="hero-players-card"
      className="relative mt-6 md:mt-7 w-full max-w-4xl mx-auto rounded-[22px] p-[1.5px] bg-gradient-to-br from-emerald-300 via-teal-400 to-blue-500 shadow-2xl shadow-emerald-500/20 text-left"
    >
      <div className="rounded-[20.5px] bg-gradient-to-br from-[#06281f] via-[#0a2230] to-[#0b1736] px-4 py-4 md:px-7 md:py-4 flex flex-col md:flex-row md:items-center gap-3 md:gap-6">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-400 text-slate-950 text-[11px] font-extrabold uppercase tracking-wider">
              <Sparkles className="w-3 h-3" aria-hidden="true" />
              {h.badge}
            </span>
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">{h.eyebrow}</span>
          </p>
          <h2 id="hero-players-title" className="mt-2 text-[22px] md:text-2xl font-extrabold leading-tight text-white" style={DISPLAY_FONT}>
            {h.title}
          </h2>
          <p className="mt-1 text-sm md:text-[15px] leading-snug text-slate-200">{h.body}</p>
        </div>
        <div className="shrink-0 flex flex-col items-stretch md:items-center gap-1.5">
          <PoolInviteButton cta={h.cta} testId="hero-pool-join" />
          <p className="text-xs text-center text-slate-300">{h.smallPrint}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * The player pool's section, straight under the hero (round two,
 * 2026-10-26): the call-up headline, the lead and the benefit beside a drawn
 * WhatsApp offer, then the four steps, the points, what is shared and the
 * closing line. Same contract as `SpotlightSection` (an h2 naming the
 * region, h3 steps and points, the note), so the menu and tests treat it
 * the same.
 */
export function PoolSpotlightSection({ s }: { s: Spotlight }) {
  const headingId = `${s.id}-heading`;
  return (
    <section
      id={s.id}
      aria-labelledby={headingId}
      className="relative py-20 sm:py-28 px-5 sm:px-8 overflow-hidden scroll-mt-4 bg-gradient-to-b from-emerald-50 via-white to-white text-slate-800"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-70"
        style={{ backgroundImage: "radial-gradient(600px circle at 85% 10%, rgba(16,185,129,0.16), transparent 50%)" }}
      />
      <div className="relative max-w-6xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-10 lg:gap-16 items-center">
          <div>
            <SectionIntro
              id={headingId}
              eyebrow={
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700 tracking-[0.14em]">
                  <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                  {s.eyebrow}
                </span>
              }
              title={s.title}
              lead={s.lead}
            />
            {s.benefit && (
              <p className="mt-5 flex items-start gap-2.5 text-lg font-bold text-emerald-700" style={DISPLAY_FONT}>
                <Zap className="w-5 h-5 mt-1 shrink-0 text-emerald-500" aria-hidden="true" />
                {s.benefit}
              </p>
            )}
            {s.cta && (
              <div className="mt-8">
                <PoolInviteButton cta={s.cta} testId="spotlight-cta" />
              </div>
            )}
          </div>
          {s.offerChat && (
            <div className="mx-auto w-full max-w-[380px] rounded-[34px] bg-slate-950 p-2.5 shadow-2xl shadow-emerald-900/25 ring-1 ring-slate-900/10">
              <ChatDrawing chat={s.offerChat} />
            </div>
          )}
        </div>

        {s.steps && (
          <div className="mt-16">
            <StepList steps={s.steps} label={s.stepsLabel} />
          </div>
        )}

        <div className="mt-12">
          <CardGrid cards={s.points} columns={4} />
        </div>

        {s.note && (
          <div className="mt-12">
            <NoteBox title={s.note.title} items={s.note.items} tone="light" />
          </div>
        )}

        {s.footnote && <p className="mt-10 text-sm text-slate-500">{s.footnote}</p>}
      </div>
    </section>
  );
}

/**
 * The players' invitation button: the one place the pulse class is put on
 * a button. `pulse` adds the soft ring (globals.css `.pool-invite-pulse`),
 * which stops for anyone who prefers reduced motion.
 */
export function PoolInviteButton({
  cta,
  testId,
  size = "md",
}: {
  cta: Cta;
  testId?: string;
  size?: "md" | "lg";
}) {
  const pad = size === "lg" ? "px-6 sm:px-8 py-4 text-base sm:text-lg" : "px-4 sm:px-7 py-3 sm:py-3.5 text-[15px] sm:text-base";
  return (
    <Link
      href={cta.href}
      data-testid={testId}
      className={`inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 font-bold text-slate-950 shadow-lg shadow-emerald-500/30 transition-colors hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 ${pad} ${cta.pulse ? "pool-invite-pulse" : ""}`}
    >
      {cta.label}
      <ArrowRight className="w-4 h-4" aria-hidden="true" />
    </Link>
  );
}

/** A spotlight's button. */
export function SpotlightCta({ cta }: { cta: NonNullable<Spotlight["cta"]> }) {
  return (
    <div className="mt-8 text-center">
      <PoolInviteButton cta={cta} testId="spotlight-cta" />
    </div>
  );
}

/** A persona card on the "Who it's for" section. */
export function PersonaCard({ role, bullets }: { role: string; bullets: string[] }) {
  return (
    <div className="p-7 rounded-2xl bg-white border border-slate-200 shadow-sm">
      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-semibold mb-4">
        <Star className="w-3 h-3" aria-hidden="true" />
        <span>{role}</span>
      </div>
      <ul className="space-y-3">
        {bullets.map((b) => (
          <li key={b} className="flex items-start gap-3 text-sm text-slate-700">
            <Check className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" aria-hidden="true" />
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The website's footer, on the home page and /players. */
export function LandingFooter() {
  return (
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
  );
}
