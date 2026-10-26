/**
 * The player pool on the home page (variant D round 2): "Get called up
 * for local games." Right after the key features, so a player meets it
 * early. The invitation, the benefit and the pulsing button beside a drawn
 * WhatsApp offer (the bot's real words, `pool-offer-lines.ts`), then how a
 * call-up works, the points and what stays private.
 *
 * Every word is `PLAYER_POOL` (the spotlight /players also reads) and
 * `POOL_SECTION` in landing-content.ts. Presentational only.
 */
import { Sparkles } from "lucide-react";
import { POOL_SECTION, type Spotlight } from "./landing-content";
import { CardGrid, NoteBox, PoolInviteButton, StepList, Stopped } from "./landing-sections";
import { DISPLAY_FONT } from "./display-font";
import { boldSegments } from "./dropout-bot-lines";
import { poolOfferMock } from "./pool-offer-lines";

function Marked({ line }: { line: string }) {
  return (
    <>
      {boldSegments(line).map((p, i) => (p.bold ? <strong key={i} className="font-semibold text-white">{p.text}</strong> : <span key={i}>{p.text}</span>))}
    </>
  );
}

/** The drawn offer: MatchTime's DM, the player's yes, and the confirmation. */
function OfferPhone() {
  const o = POOL_SECTION.offer;
  const m = poolOfferMock();
  const [before, after] = m.cta.split(o.link);
  return (
    <figure className="w-full max-w-[340px] mx-auto lg:mx-0 lg:justify-self-end rounded-[46px] border-[3px] border-slate-700 p-2.5 bg-[#0b1226] shadow-2xl shadow-emerald-500/10">
      <div className="rounded-[36px] bg-[#0a1633] overflow-hidden">
        <div className="flex items-center gap-2.5 px-3.5 pt-4 pb-3 border-b border-slate-400/15">
          <span className="w-[34px] h-[34px] rounded-full bg-teal-900 inline-flex items-center justify-center text-xs font-bold text-teal-200" aria-hidden="true">
            MT
          </span>
          <div className="flex flex-col text-left">
            <span className="text-sm font-semibold text-slate-100">{o.chatName}</span>
            <span className="text-xs text-slate-400">{o.chatKind}</span>
          </div>
        </div>
        <div className="px-3 pt-3.5 pb-4 flex flex-col gap-2.5 text-left">
          <div className="self-start max-w-[92%] px-3 py-2 rounded-2xl rounded-bl-sm bg-[#0f3d3a] border border-teal-300/30 flex flex-col gap-1">
            <ul className="flex flex-col gap-1 text-sm leading-snug text-slate-100" aria-label="The offer">
              {m.offer.map((l) => (
                <li key={l}>
                  <Marked line={l} />
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-sm leading-snug text-slate-100">
              {before}
              <span className="text-sky-300 underline underline-offset-2">{o.link}</span>
              {after}
            </p>
            <div className="text-[11px] text-right text-teal-200/70">{o.time}</div>
          </div>
          <div className="self-end max-w-[80%] px-3 pt-2 pb-1.5 rounded-2xl rounded-br-sm bg-emerald-700">
            <div className="text-sm text-white">{o.reply}</div>
            <div className="text-[11px] text-right text-emerald-100">{o.replyTime}</div>
          </div>
          <div className="self-start max-w-[92%] px-3 py-2 rounded-2xl rounded-bl-sm bg-[#0f3d3a] border border-teal-300/30">
            <div className="text-sm leading-snug text-slate-100">
              <Marked line={m.placed} />
            </div>
            <div className="text-[11px] text-right text-teal-200/70">{o.replyTime}</div>
          </div>
        </div>
      </div>
      <figcaption className="sr-only">{o.caption}</figcaption>
    </figure>
  );
}

/** `openingLine`: /play's own early or open note (`poolOpeningLine`, the
 *  server's switch), shown under the lead in smaller type. */
export function PoolSection({ s, openingLine }: { s: Spotlight; openingLine: string }) {
  const headingId = `${s.id}-heading`;
  return (
    <section
      id={s.id}
      aria-labelledby={headingId}
      className="relative py-20 sm:py-28 px-5 sm:px-8 overflow-hidden scroll-mt-4 bg-gradient-to-b from-slate-950 via-emerald-950 to-slate-950 text-slate-100"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-50"
        style={{
          backgroundImage:
            "radial-gradient(700px circle at 15% 20%, rgba(16,185,129,0.22), transparent 45%), radial-gradient(700px circle at 85% 75%, rgba(59,130,246,0.16), transparent 50%)",
        }}
      />
      <div className="relative max-w-6xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-12 lg:gap-16 items-center">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2.5">
              {s.badge && (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-emerald-400 text-emerald-950 text-xs font-extrabold uppercase tracking-wider">
                  {s.badge}
                </span>
              )}
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">{s.eyebrow}</span>
            </div>
            <h2 id={headingId} className="mt-4 text-4xl sm:text-6xl font-extrabold tracking-tight leading-[1.05] text-white" style={DISPLAY_FONT}>
              <Stopped text={s.title} />
            </h2>
            <p className="mt-5 text-lg sm:text-xl leading-relaxed text-slate-100">{s.lead}</p>
            <p className="mt-3 text-[15px] leading-relaxed text-slate-300">{openingLine}</p>
            <p className="mt-5 inline-flex items-start gap-2.5 text-lg font-semibold text-emerald-200">
              <Sparkles className="w-5 h-5 mt-1 shrink-0 text-emerald-300" aria-hidden="true" />
              <span>{POOL_SECTION.benefit}</span>
            </p>
            {s.cta && (
              <div className="mt-8 flex flex-col items-start gap-3">
                <PoolInviteButton cta={s.cta} testId="spotlight-cta" size="lg" />
                <p className="text-sm text-slate-300">{POOL_SECTION.smallPrint}</p>
              </div>
            )}
          </div>
          <OfferPhone />
        </div>

        {s.steps && (
          <div className="mt-20">
            <h3 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white" style={DISPLAY_FONT}>
              {s.stepsLabel}
            </h3>
            <div className="mt-10">
              <StepList steps={s.steps} label={s.stepsLabel} tone="dark" />
            </div>
          </div>
        )}

        <div className="mt-12">
          <CardGrid cards={s.points} tone="dark" columns={4} />
        </div>

        {s.note && (
          <div className="mt-12">
            <NoteBox title={s.note.title} items={s.note.items} tone="dark" />
          </div>
        )}

        {s.footnote && <p className="mt-10 text-sm text-slate-400">{s.footnote}</p>}
      </div>
    </section>
  );
}
