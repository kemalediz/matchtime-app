"use client";

/**
 * The hero's feature deck (variant E, 2026-10-26): eight cards in a
 * horizontal scroll-snap row (swipe on touch), with prev and next buttons
 * and dots on every size, and arrow keys on the row.
 *
 * Opening a card shows its detail, one at a time:
 *   - phone (under 768px): a bottom sheet, a modal dialog with a close
 *     button; Escape and the backdrop close it; focus moves into it, stays
 *     in it, and goes back to the card on close.
 *   - wider: a panel under the deck, text on the left and a larger drawing
 *     on the right; its close button and Escape close it.
 *
 * The words are data (`HERO_DECK` in landing-content.ts); this file only
 * lays them out. Fictional data, drawn with HTML, no images.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import Link from "next/link";
import {
  Armchair,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Handshake,
  Languages,
  Lock,
  MapPin,
  MessageCircle,
  Scale,
  Shirt,
  Star,
  Trophy,
  Users,
  X,
} from "lucide-react";
import { HERO_DECK, type DeckCard, type DeckChat, type DeckKey, type DeckLine } from "./landing-content";
import { DISPLAY_FONT } from "./display-font";

const PHONE_QUERY = "(max-width: 767px)";
const CARDS: DeckCard[] = HERO_DECK.cards;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function HeroDeck() {
  const [idx, setIdx] = useState(0);
  const [open, setOpen] = useState<DeckKey | null>(null);
  const [isPhone, setIsPhone] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const sync = () => setIsPhone(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  /** Where the track must scroll to put card `i` at its start. */
  const leftOf = useCallback((i: number) => {
    const track = trackRef.current;
    const card = cardRefs.current[i];
    if (!track || !card) return 0;
    return card.offsetLeft - parseFloat(getComputedStyle(track).paddingLeft || "0");
  }, []);

  const go = useCallback(
    (i: number) => {
      const n = Math.max(0, Math.min(CARDS.length - 1, i));
      trackRef.current?.scrollTo({ left: leftOf(n), behavior: prefersReducedMotion() ? "auto" : "smooth" });
      setIdx(n);
    },
    [leftOf],
  );

  const onScroll = () => {
    const track = trackRef.current;
    if (!track) return;
    let best = 0;
    let dist = Infinity;
    CARDS.forEach((_, i) => {
      const d = Math.abs(leftOf(i) - track.scrollLeft);
      if (d < dist) [best, dist] = [i, d];
    });
    setIdx((cur) => (cur === best ? cur : best));
  };

  const onTrackKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(idx + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(idx - 1);
    }
  };

  const close = useCallback(() => {
    setOpen(null);
    const opener = openerRef.current;
    if (opener) requestAnimationFrame(() => opener.focus({ preventScroll: true }));
  }, []);

  const pick = (key: DeckKey, el: HTMLButtonElement) => {
    if (open === key) return close();
    openerRef.current = el;
    setOpen(key);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  const card = open ? CARDS.find((c) => c.key === open)! : null;

  return (
    <section aria-label={HERO_DECK.sectionLabel} className="mt-10 sm:mt-14 grid grid-cols-1 md:grid-cols-[1fr_auto] md:items-center gap-x-4 gap-y-3 md:gap-y-4 text-left">
      <div className="min-w-0">
        <h2 className="text-[17px] md:text-2xl font-extrabold text-white" style={DISPLAY_FONT}>
          {HERO_DECK.title}
        </h2>
        <p className="text-[13px] md:text-[15px] text-slate-400">
          <span className="md:hidden">{HERO_DECK.hintPhone}</span>
          <span className="hidden md:inline">{HERO_DECK.hintDesktop}</span>
        </p>
      </div>

      <div className="order-3 md:order-none flex items-center justify-center gap-2">
        <NavButton label={HERO_DECK.prevLabel} disabled={idx <= 0} onClick={() => go(idx - 1)}>
          <ChevronLeft className="w-5 h-5" aria-hidden="true" />
        </NavButton>
        <div role="group" aria-label={HERO_DECK.dotsLabel} className="flex items-center">
          {CARDS.map((c, i) => (
            <button
              key={c.key}
              type="button"
              onClick={() => go(i)}
              aria-label={HERO_DECK.dotLabel(i + 1)}
              aria-current={i === idx ? "true" : undefined}
              className="w-[26px] h-11 inline-flex items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-blue-400"
            >
              <span className={`block h-2 rounded transition-all ${i === idx ? "w-5 bg-blue-400" : "w-2 bg-slate-600"}`} />
            </button>
          ))}
        </div>
        <NavButton label={HERO_DECK.nextLabel} disabled={idx >= CARDS.length - 1} onClick={() => go(idx + 1)}>
          <ChevronRight className="w-5 h-5" aria-hidden="true" />
        </NavButton>
      </div>

      <div
        ref={trackRef}
        data-testid="deck-track"
        onScroll={onScroll}
        onKeyDown={onTrackKey}
        className="md:col-span-2 relative -mx-5 sm:-mx-8 md:mx-0 flex gap-3 md:gap-4 overflow-x-auto snap-x snap-mandatory scroll-pl-5 sm:scroll-pl-8 md:scroll-pl-0 px-5 sm:px-8 md:px-0 pt-0.5 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {CARDS.map((c, i) => (
          <DeckCardButton
            key={c.key}
            card={c}
            selected={open === c.key}
            controls={open === c.key ? panelId : undefined}
            setRef={(el) => {
              cardRefs.current[i] = el;
            }}
            onPick={(el) => pick(c.key, el)}
          />
        ))}
        {/* Room after the last card, so every card can slide to the start. */}
        <span aria-hidden="true" className="shrink-0 w-[calc(100%-264px)] md:w-[calc(100%-288px)]" />
      </div>

      <div className="order-5 md:col-span-2 flex justify-center md:justify-start">
        <Link
          href={HERO_DECK.poolLink.href}
          className="inline-flex min-h-11 items-center gap-2 text-sm sm:text-base font-semibold text-emerald-300 underline-offset-4 hover:underline hover:text-white"
        >
          {HERO_DECK.poolLink.label}
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </Link>
      </div>

      {card && !isPhone && <DetailPanel card={card} id={panelId} onClose={close} />}
      {card && isPhone && <DetailSheet card={card} id={panelId} onClose={close} />}
    </section>
  );
}

function NavButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="w-11 h-11 inline-flex items-center justify-center rounded-xl border border-white/20 bg-white/5 text-white transition-opacity hover:bg-white/10 disabled:opacity-40 disabled:cursor-default"
    >
      {children}
    </button>
  );
}

function DeckCardButton({
  card,
  selected,
  controls,
  setRef,
  onPick,
}: {
  card: DeckCard;
  selected: boolean;
  controls?: string;
  setRef: (el: HTMLButtonElement | null) => void;
  onPick: (el: HTMLButtonElement) => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  return (
    <button
      ref={setRef}
      type="button"
      onClick={(e) => onPick(e.currentTarget)}
      aria-expanded={selected}
      aria-controls={controls}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className={`shrink-0 w-[252px] md:w-[272px] snap-start flex flex-col gap-3 p-3 pb-3.5 rounded-[20px] bg-[#0c1631] border-[1.5px] text-left text-slate-50 cursor-pointer transition-colors hover:border-blue-400/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 ${
        selected ? "border-blue-400" : "border-slate-400/20"
      }`}
    >
      <span aria-hidden="true" className="h-[104px] md:h-[112px] p-3 rounded-[14px] bg-[#0a1633] flex items-center">
        <CardVisual card={card} />
      </span>
      <span className="px-1 flex flex-1 flex-col gap-1">
        <span id={titleId} className="text-lg font-extrabold leading-tight text-white" style={DISPLAY_FONT}>
          {card.title}
        </span>
        <span id={bodyId} className="text-sm leading-snug text-slate-300">
          {card.body}
        </span>
        <span aria-hidden="true" className="mt-auto pt-1 inline-flex items-center gap-1.5 text-[13px] font-semibold text-blue-300">
          {HERO_DECK.seeHow}
          <ArrowRight className="w-3.5 h-3.5" />
        </span>
      </span>
    </button>
  );
}

// ─── The small drawing on each card ────────────────────────────────────

function TickBadge({ size = "sm" }: { size?: "sm" | "lg" }) {
  const box = size === "lg" ? "w-[30px] h-[30px] -right-2.5 -top-2.5 border-[3px] border-[#0c1631]" : "w-5 h-5 -right-2 -bottom-1.5 border-2 border-[#0a1633]";
  return (
    <span className={`absolute ${box} rounded-full bg-emerald-500 inline-flex items-center justify-center`}>
      <Check className={size === "lg" ? "w-4 h-4 text-white" : "w-3 h-3 text-white"} strokeWidth={3} />
    </span>
  );
}

function Pill({ children, tone }: { children: ReactNode; tone: "green" | "blue" | "amber" }) {
  const tones = {
    green: "bg-emerald-500/15 border-emerald-400/40 text-emerald-100",
    blue: "bg-blue-400/10 border-blue-400/35 text-blue-100",
    amber: "bg-amber-400/15 border-amber-400/40 text-amber-100",
  } as const;
  return <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-bold ${tones[tone]}`}>{children}</span>;
}

function CardVisual({ card }: { card: DeckCard }) {
  const v = card.visual;
  switch (card.key) {
    case "att":
      return (
        <span className="flex flex-col gap-2.5 items-start w-full">
          <span className="flex items-center gap-3.5">
            {v.slice(0, 2).map((t) => (
              <span key={t} className="relative px-2.5 py-1 rounded-[12px_12px_12px_4px] bg-slate-800 text-[13px] text-slate-100">
                {t}
                <TickBadge />
              </span>
            ))}
          </span>
          <span className="mt-1">
            <Pill tone="green">{v[2]}</Pill>
          </span>
        </span>
      );
    case "bench":
      return (
        <span className="flex items-center gap-3 w-full">
          <span className="w-14 h-14 shrink-0 rounded-2xl bg-violet-400/15 border border-violet-400/40 inline-flex items-center justify-center">
            <Armchair className="w-7 h-7 text-violet-300" />
          </span>
          <span className="flex flex-col gap-1.5 items-start">
            <span className="text-[13px] font-bold text-blue-300">{v[0]}</span>
            <span className="px-2 py-1 rounded-[10px_10px_10px_3px] bg-[#0f3d3a] border border-teal-300/30 text-xs text-slate-100">{v[1]}</span>
          </span>
        </span>
      );
    case "short": {
      const tiles = [
        { Icon: Armchair, label: v[0], box: "w-10 h-10 bg-violet-400/15 border-violet-400/40", icon: "text-violet-300", text: "text-violet-300" },
        { Icon: Handshake, label: v[1], box: "w-10 h-10 bg-amber-400/10 border-amber-400/40", icon: "text-amber-300", text: "text-amber-300" },
        { Icon: MapPin, label: v[2], box: "w-[46px] h-[46px] bg-emerald-500/20 border-emerald-400/70 shadow-lg shadow-emerald-500/20", icon: "text-emerald-300", text: "text-emerald-300" },
      ];
      return (
        <span className="flex items-end justify-center gap-1.5 w-full">
          {tiles.map((t, i) => (
            <span key={t.label} className="contents">
              {i > 0 && <ChevronRight className="w-4 h-4 mb-6 text-slate-500 shrink-0" />}
              <span className="flex flex-col items-center gap-1 w-[64px]">
                <span className={`rounded-xl border inline-flex items-center justify-center ${t.box}`}>
                  <t.Icon className={`w-5 h-5 ${t.icon}`} />
                </span>
                <span className={`text-[11px] font-bold text-center leading-tight ${t.text}`}>{t.label}</span>
              </span>
            </span>
          ))}
        </span>
      );
    }
    case "teams":
      return (
        <span className="flex items-center justify-center gap-5 w-full">
          <Shirt className="w-11 h-11 text-blue-400" fill="rgba(96,165,250,0.25)" />
          <Scale className="w-9 h-9 text-slate-300" />
          <Shirt className="w-11 h-11 text-orange-400" fill="rgba(251,146,60,0.25)" />
        </span>
      );
    case "ratings":
      return (
        <span className="flex flex-col items-center gap-2.5 w-full">
          <span className="flex gap-1">
            {[0, 1, 2, 3, 4].map((i) => (
              <Star key={i} className={`w-6 h-6 ${i < 4 ? "text-amber-300" : "text-slate-600"}`} fill={i < 4 ? "currentColor" : "none"} />
            ))}
          </span>
          <Pill tone="amber">
            <Trophy className="w-3.5 h-3.5" />
            {v[0]}
          </Pill>
        </span>
      );
    case "fees":
      return (
        <span className="flex items-center justify-center gap-3.5 w-full">
          <span className="relative w-[116px] h-[72px] rounded-xl bg-gradient-to-br from-blue-900 to-teal-700 px-3 py-2.5 flex flex-col justify-between">
            <span className="w-[22px] h-4 rounded bg-amber-200/85" />
            <span className="text-lg font-extrabold text-white" style={DISPLAY_FONT}>
              {v[0]}
            </span>
            <TickBadge size="lg" />
          </span>
          <span className="flex flex-col gap-1.5">
            <Pill tone="blue">{v[1]}</Pill>
            <Pill tone="blue">{v[2]}</Pill>
          </span>
        </span>
      );
    case "admin":
      return (
        <span className="flex flex-col gap-2 w-full">
          {v.slice(0, 2).map((t) => (
            <span key={t} className="self-end px-2.5 py-1 rounded-[12px_12px_3px_12px] bg-blue-900 text-xs text-slate-50">
              {t}
            </span>
          ))}
          <span className="self-start inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400">
            <Lock className="w-3.5 h-3.5" />
            {v[2]}
          </span>
        </span>
      );
    case "lang":
      return (
        <span className="flex items-center justify-center gap-4 w-full">
          <Languages className="w-11 h-11 text-teal-300" />
          <span className="flex flex-col gap-2">
            {v.map((t, i) => (
              <span key={i} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[12px_12px_12px_3px] bg-[#0f3d3a] border border-teal-300/30">
                <span className="text-xs font-extrabold text-teal-300">{t}</span>
                <span className={`h-1.5 rounded-sm bg-slate-100/50 ${i === 0 ? "w-14" : "w-10"}`} />
              </span>
            ))}
          </span>
        </span>
      );
  }
}

// ─── The detail: a panel (desktop) or a bottom sheet (phone) ───────────

function Details({ card }: { card: DeckCard }) {
  return (
    <ul className="flex flex-col gap-2">
      {card.details.map((d) => (
        <li key={d} className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-2.5 text-[15px] leading-relaxed text-slate-300">
          <Check className="w-[18px] h-[18px] mt-[3px] text-emerald-400" aria-hidden="true" />
          <span>{d}</span>
        </li>
      ))}
    </ul>
  );
}

function CloseButton({ onClose, buttonRef }: { onClose: () => void; buttonRef?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClose}
      aria-label={HERO_DECK.closeLabel}
      className="shrink-0 w-11 h-11 rounded-xl border border-white/20 bg-white/5 inline-flex items-center justify-center text-white hover:bg-white/10"
    >
      <X className="w-5 h-5" aria-hidden="true" />
    </button>
  );
}

function DetailPanel({ card, id, onClose }: { card: DeckCard; id: string; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [card.key]);
  return (
    <section
      ref={ref}
      id={id}
      aria-label={HERO_DECK.detailsLabel}
      className="order-4 md:col-span-2 mt-2 p-8 lg:px-10 lg:py-9 rounded-[28px] bg-[#0b1430] border border-blue-400/35 flex flex-wrap items-start gap-x-16 gap-y-10"
    >
      <div className="flex-[1_1_380px] min-w-0 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <h3 ref={headingRef} tabIndex={-1} className="pt-1 text-[32px] font-extrabold leading-tight text-white outline-none" style={DISPLAY_FONT}>
            {card.title}
          </h3>
          <CloseButton onClose={onClose} />
        </div>
        <Details card={card} />
      </div>
      <div className="flex-[0_1_380px] min-w-0 flex justify-center">
        <Drawing card={card} />
      </div>
    </section>
  );
}

function DetailSheet({ card, id, onClose }: { card: DeckCard; id: string; onClose: () => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const body = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = body;
    };
  }, [card.key]);

  // Keep Tab inside the sheet while it is open.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => !el.hasAttribute("disabled"));
    if (items.length === 0) return;
    const [first, last] = [items[0], items[items.length - 1]];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button type="button" tabIndex={-1} aria-label="Close details" onClick={onClose} className="absolute inset-0 bg-slate-950/70 backdrop-blur-[2px]" />
      <div
        ref={dialogRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="relative max-h-[88vh] overflow-y-auto overscroll-contain rounded-t-[28px] bg-[#0b1430] border-t border-blue-400/35 px-5 pt-3 pb-8 text-left"
      >
        <div aria-hidden="true" className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-600" />
        <div className="flex items-start justify-between gap-4">
          <h3 id={titleId} className="pt-1.5 text-2xl font-extrabold leading-tight text-white" style={DISPLAY_FONT}>
            {card.title}
          </h3>
          <CloseButton onClose={onClose} buttonRef={closeRef} />
        </div>
        <div className="mt-4">
          <Details card={card} />
        </div>
        <div className="mt-6 flex justify-center">
          <Drawing card={card} />
        </div>
      </div>
    </div>
  );
}

// ─── The larger drawings ───────────────────────────────────────────────

function Drawing({ card }: { card: DeckCard }) {
  if (card.settings) return <SettingsDrawing s={card.settings} />;
  return (
    <div className="w-full max-w-[360px] flex flex-col gap-4">
      {card.steps && (
        <ol aria-label="Who is asked, in order" className="grid grid-cols-3 gap-2">
          {card.steps.map((s) => (
            <li
              key={s.title}
              className={`rounded-2xl border p-2.5 flex flex-col gap-1 ${
                s.highlight ? "bg-emerald-500/15 border-emerald-400/60" : "bg-[#0a1633] border-slate-400/20"
              }`}
            >
              <span className={`text-[13px] font-bold leading-tight ${s.highlight ? "text-emerald-200" : "text-white"}`}>{s.title}</span>
              <span className="text-[11px] leading-snug text-slate-400">{s.sub}</span>
            </li>
          ))}
        </ol>
      )}
      {card.chat && <ChatDrawing chat={card.chat} />}
    </div>
  );
}

const NAME_COLOURS = ["text-violet-300", "text-blue-300", "text-amber-300", "text-pink-300", "text-emerald-300"];

function nameColour(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return NAME_COLOURS[h % NAME_COLOURS.length];
}

/** `*bold*` segments, WhatsApp style. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split("*").map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : <span key={i}>{part}</span>))}
    </>
  );
}

function ChatDrawing({ chat }: { chat: DeckChat }) {
  const avatar =
    chat.kind === "group" ? (
      <span className="w-8 h-8 rounded-full bg-green-900 inline-flex items-center justify-center">
        <Users className="w-4 h-4 text-green-200" aria-hidden="true" />
      </span>
    ) : chat.kind === "admin" ? (
      <span className="w-8 h-8 rounded-full bg-slate-700 inline-flex items-center justify-center">
        <Lock className="w-4 h-4 text-slate-200" aria-hidden="true" />
      </span>
    ) : (
      <span className="w-8 h-8 rounded-full bg-blue-600 inline-flex items-center justify-center">
        <MessageCircle className="w-4 h-4 text-white" aria-hidden="true" />
      </span>
    );
  return (
    <figure aria-label={`${chat.title}, ${chat.subtitle}`} className="w-full rounded-[22px] bg-[#0a1633] border border-slate-400/20 overflow-hidden">
      <figcaption className="flex items-center gap-2.5 px-3.5 pt-3 pb-2.5 border-b border-slate-400/15">
        {avatar}
        <span className="flex flex-col text-left">
          <span className="text-sm font-semibold text-slate-100">{chat.title}</span>
          <span className="text-xs text-slate-400">{chat.subtitle}</span>
        </span>
      </figcaption>
      <div className="p-3 pb-4 flex flex-col gap-2.5 text-left">
        {chat.lines.map((l, i) => (
          <Bubble key={i} line={l} />
        ))}
      </div>
    </figure>
  );
}

function Bubble({ line }: { line: DeckLine }) {
  const paras = line.text.split("\n");
  if (line.from === "self") {
    return (
      <div className="self-end max-w-[80%] px-3 py-2 rounded-[14px_14px_4px_14px] bg-blue-900">
        <div className="text-sm text-slate-50">{line.text}</div>
        <div className="text-[11px] text-blue-200/70 text-right">{line.time}</div>
      </div>
    );
  }
  if (line.from === "player") {
    return (
      <div className="self-start relative max-w-[80%] px-3 pt-1.5 pb-2 rounded-[14px_14px_14px_4px] bg-slate-800">
        <div className={`text-xs font-semibold ${nameColour(line.name ?? "")}`}>{line.name}</div>
        <div className="text-sm text-slate-100">{line.text}</div>
        <div className="text-[11px] text-slate-400 text-right">{line.time}</div>
        {line.tick && <TickBadge />}
      </div>
    );
  }
  return (
    <div className="self-start max-w-[88%] px-3 py-2 rounded-[14px_14px_14px_4px] bg-[#0f3d3a] border border-teal-300/30 flex flex-col gap-1.5">
      <div className="text-xs font-bold text-teal-300">MatchTime</div>
      {paras.map((p, i) => (
        <div key={i} className={`text-sm leading-snug ${p.startsWith("@") ? "font-bold text-blue-300" : "text-slate-100"}`}>
          <Rich text={p} />
        </div>
      ))}
      {line.teams && (
        <div className="flex flex-col gap-1">
          {line.teams.map((t, i) => (
            <div key={t.name} className="flex items-center gap-2 text-sm text-slate-100">
              <Shirt className={`w-4 h-4 shrink-0 ${i === 0 ? "text-blue-400" : "text-orange-400"}`} aria-hidden="true" />
              <span>
                <strong>{t.name}</strong> {t.players}
              </span>
            </div>
          ))}
        </div>
      )}
      {line.link && (
        <span className="self-start inline-flex items-center px-2.5 py-1 rounded-lg bg-blue-500/20 text-[13px] font-semibold text-blue-200 underline underline-offset-2">
          {line.link}
        </span>
      )}
      <div className="text-[11px] text-slate-400 text-right">{line.time}</div>
    </div>
  );
}

function SettingsDrawing({ s }: { s: NonNullable<DeckCard["settings"]> }) {
  return (
    <div className="w-full max-w-[360px] rounded-[22px] bg-[#0a1633] border border-slate-400/20 overflow-hidden text-left">
      <div className="flex items-center gap-3 px-4 py-3.5 border-b border-slate-400/15">
        <span className="w-9 h-9 rounded-xl bg-teal-400/15 inline-flex items-center justify-center">
          <Languages className="w-5 h-5 text-teal-300" aria-hidden="true" />
        </span>
        <span className="flex flex-col">
          <span className="text-sm font-semibold text-slate-100">{s.title}</span>
          <span className="text-xs text-slate-400">{s.value}</span>
        </span>
      </div>
      <ul className="p-2">
        {s.items.map((it) => (
          <li key={it} className="flex items-center justify-between gap-3 px-3 py-3 text-sm text-slate-100 border-b last:border-b-0 border-slate-400/10">
            {it}
            <Check className="w-4 h-4 text-emerald-400" aria-hidden="true" />
          </li>
        ))}
      </ul>
    </div>
  );
}
