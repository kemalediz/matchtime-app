"use client";

/**
 * The website's top bar (Kemal, 2026-10-25: "we need separate menu for
 * players and for clubs"): the logo, a "For clubs" and a "For players"
 * menu, and Sign in. On desktop each group is a dropdown; on a phone one
 * Menu button opens both groups as two labelled sections.
 *
 * The groups are data (`LANDING_NAV_GROUPS` in landing-content.ts). A
 * home-page anchor is stored as `/#id`, so the same menu works on
 * /players; on the home page itself it is rendered as `#id`.
 *
 * A menu closes on Escape, on a click outside it and when a link in it is
 * followed.
 */
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, Menu as MenuIcon, X } from "lucide-react";
import { LANDING_NAV_GROUPS, type NavAudience, type NavGroup, type NavLink } from "./landing-content";
import { DISPLAY_FONT } from "./display-font";

type Open = NavAudience | "phone" | null;

function hrefFor(href: string, onHome: boolean): string {
  return onHome && href.startsWith("/#") ? href.slice(1) : href;
}

function MenuLink({ link, onHome, onPick, className }: { link: NavLink; onHome: boolean; onPick: () => void; className: string }) {
  const href = hrefFor(link.href, onHome);
  return href.startsWith("#") ? (
    <a href={href} onClick={onPick} className={className}>
      {link.label}
    </a>
  ) : (
    <Link href={href} onClick={onPick} className={className}>
      {link.label}
    </Link>
  );
}

/** One group's links and its button, as a desktop dropdown or a phone section. */
function GroupBody({ g, onHome, onPick, labelId }: { g: NavGroup; onHome: boolean; onPick: () => void; labelId: string }) {
  const players = g.id === "players";
  return (
    <div role="group" aria-labelledby={labelId}>
      <ul className="space-y-0.5">
        {g.links.map((l) => (
          <li key={l.href}>
            <MenuLink
              link={l}
              onHome={onHome}
              onPick={onPick}
              className="block rounded-lg px-3 py-2 text-sm text-slate-200 hover:bg-white/10 hover:text-white"
            />
          </li>
        ))}
      </ul>
      <MenuLink
        link={g.cta}
        onHome={onHome}
        onPick={onPick}
        className={`mt-3 flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-sm font-semibold ${
          players
            ? "bg-emerald-500 text-slate-950 hover:bg-emerald-400"
            : "bg-gradient-to-br from-blue-500 to-teal-500 text-white hover:from-blue-400 hover:to-teal-400"
        }`}
      />
    </div>
  );
}

export function LandingHeader({ onHome }: { onHome: boolean }) {
  const [open, setOpen] = useState<Open>(null);
  const ref = useRef<HTMLElement>(null);
  const uid = useId();
  const close = () => setOpen(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <header ref={ref} className="absolute top-0 inset-x-0 z-30">
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

        {/* Desktop: one dropdown per audience. */}
        <nav aria-label="Main" className="hidden lg:flex items-center gap-2 text-sm text-slate-200">
          {LANDING_NAV_GROUPS.map((g) => {
            const isOpen = open === g.id;
            const labelId = `${uid}-${g.id}`;
            return (
              <div key={g.id} className="relative">
                <button
                  type="button"
                  id={labelId}
                  aria-expanded={isOpen}
                  aria-controls={`${labelId}-panel`}
                  onClick={() => setOpen(isOpen ? null : g.id)}
                  className="inline-flex items-center gap-1 rounded-lg px-3 py-2 font-medium hover:bg-white/10 hover:text-white"
                >
                  {g.label}
                  <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? "rotate-180" : ""}`} aria-hidden="true" />
                </button>
                {isOpen && (
                  <div
                    id={`${labelId}-panel`}
                    className="absolute left-0 top-full mt-2 w-64 rounded-xl border border-white/10 bg-slate-900/95 p-3 shadow-2xl backdrop-blur"
                  >
                    <GroupBody g={g} onHome={onHome} onPick={close} labelId={labelId} />
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white text-slate-900 font-semibold text-sm hover:bg-slate-100 transition-colors shadow-sm"
          >
            Sign in
            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </Link>
          {/* Phone: one Menu button for both groups. */}
          <button
            type="button"
            aria-label="Menu"
            aria-expanded={open === "phone"}
            aria-controls={`${uid}-phone`}
            onClick={() => setOpen(open === "phone" ? null : "phone")}
            className="lg:hidden inline-flex items-center justify-center w-10 h-10 rounded-lg border border-white/15 bg-white/10 text-white hover:bg-white/15"
          >
            {open === "phone" ? <X className="w-5 h-5" aria-hidden="true" /> : <MenuIcon className="w-5 h-5" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {open === "phone" && (
        <nav
          id={`${uid}-phone`}
          aria-label="Menu"
          className="lg:hidden mx-4 rounded-2xl border border-white/10 bg-slate-900/95 p-4 shadow-2xl backdrop-blur max-h-[calc(100vh-6rem)] overflow-y-auto"
        >
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            {LANDING_NAV_GROUPS.map((g) => {
              const labelId = `${uid}-phone-${g.id}`;
              return (
                <div key={g.id}>
                  <p
                    id={labelId}
                    className={`px-3 pb-1 text-xs font-semibold uppercase tracking-[0.18em] ${g.id === "players" ? "text-emerald-300" : "text-blue-300"}`}
                  >
                    {g.label}
                  </p>
                  <GroupBody g={g} onHome={onHome} onPick={close} labelId={labelId} />
                </div>
              );
            })}
          </div>
        </nav>
      )}
    </header>
  );
}
