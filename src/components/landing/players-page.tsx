/**
 * /players: the website's page for players (Kemal, 2026-10-25). The
 * benefit and the big pulsing button first, then how it works, why
 * players join, what is shared and the questions players ask.
 *
 * Every word is `PLAYERS_PAGE` and `PLAYERS_FAQ` in landing-content.ts,
 * which reuse the home page's pool section (steps, points, privacy note,
 * footnote), so the two cannot disagree. English only, like the home page.
 * Presentational: no session, no data fetching.
 */
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { PRIVACY_PATH } from "@/lib/privacy-policy";
import { PLAYERS_FAQ, PLAYERS_PAGE } from "./landing-content";
import { LandingHeader } from "./landing-nav";
import { CardGrid, DISPLAY_FONT, LandingFooter, NoteBox, PoolInviteButton, SectionIntro, StepList } from "./landing-sections";

export function PlayersPage() {
  const p = PLAYERS_PAGE;
  return (
    <div className="bg-slate-950 text-slate-100 overflow-x-hidden font-sans">
      <LandingHeader onHome={false} />

      {/* ── The benefit and the button ─────────────────────────────────── */}
      <section aria-labelledby="players-heading" className="relative pt-28 pb-16 sm:pt-40 sm:pb-24 px-5 sm:px-8">
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950 via-emerald-950 to-slate-950" aria-hidden="true" />
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-50"
          style={{
            backgroundImage:
              "radial-gradient(600px circle at 20% 20%, rgba(16,185,129,0.25), transparent 45%), radial-gradient(700px circle at 85% 70%, rgba(59,130,246,0.18), transparent 50%)",
          }}
        />
        <div className="relative max-w-3xl mx-auto text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">{p.eyebrow}</p>
          <h1
            id="players-heading"
            className="mt-3 text-3xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.1] text-white"
            style={DISPLAY_FONT}
          >
            {p.title}
          </h1>
          <p className="mt-5 text-base sm:text-lg text-slate-200 leading-relaxed">{p.lead}</p>
          <div className="mt-8">
            <PoolInviteButton cta={p.cta} testId="players-join" size="lg" />
          </div>
          <p className="mt-4 text-xs sm:text-sm text-slate-300">{p.smallPrint}</p>
        </div>
      </section>

      {/* ── How it works ───────────────────────────────────────────────── */}
      <section aria-labelledby="players-how" className="py-20 sm:py-28 px-5 sm:px-8 bg-white text-slate-800">
        <div className="max-w-6xl mx-auto">
          <SectionIntro id="players-how" eyebrow={p.eyebrow} title={p.stepsTitle} center />
          <div className="mt-12">
            <StepList steps={p.steps} label={p.stepsTitle} />
          </div>
        </div>
      </section>

      {/* ── Why players join, and what is shared ───────────────────────── */}
      <section aria-labelledby="players-why" className="py-20 sm:py-28 px-5 sm:px-8 bg-slate-50 text-slate-800">
        <div className="max-w-6xl mx-auto">
          <SectionIntro id="players-why" eyebrow={p.eyebrow} title={p.pointsTitle} center />
          <div className="mt-12">
            <CardGrid cards={p.points} />
          </div>
          <div className="mt-12">
            <NoteBox title={p.note.title} items={p.note.items} tone="light" />
            <p className="mt-4 text-sm text-slate-600">
              <Link href={PRIVACY_PATH} className="font-semibold text-blue-700 underline underline-offset-4">
                {p.privacyLink}
              </Link>
            </p>
          </div>
        </div>
      </section>

      {/* ── Questions ──────────────────────────────────────────────────── */}
      <section aria-labelledby="players-faq" className="py-20 sm:py-28 px-5 sm:px-8 bg-white text-slate-800">
        <div className="max-w-3xl mx-auto">
          <SectionIntro id="players-faq" eyebrow={p.eyebrow} title={p.faqTitle} center />
          <div className="mt-10 divide-y divide-slate-200 rounded-2xl border border-slate-200">
            {PLAYERS_FAQ.map((q) => (
              <details key={q.key} className="group px-5 py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold text-slate-900">
                  {q.question}
                  <ChevronDown className="w-5 h-5 shrink-0 text-slate-500 transition-transform group-open:rotate-180" aria-hidden="true" />
                </summary>
                <p className="mt-3 text-slate-600 leading-relaxed">{q.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ── Closing ────────────────────────────────────────────────────── */}
      <section className="py-20 sm:py-24 px-5 sm:px-8 bg-gradient-to-br from-slate-950 via-emerald-950 to-slate-950">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white" style={DISPLAY_FONT}>
            {p.closingTitle}
          </h2>
          <div className="mt-8">
            <PoolInviteButton cta={p.closingCta} testId="players-join-closing" />
          </div>
          <p className="mt-6 text-sm text-slate-300">{p.footnote}</p>
        </div>
      </section>

      <LandingFooter />
    </div>
  );
}
