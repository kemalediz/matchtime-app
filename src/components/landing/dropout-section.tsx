/**
 * "What happens when a player drops out on match day" (variant D,
 * 2026-10-26): a drawn WhatsApp group chat beside a timeline. On desktop
 * the phone is on the left and the timeline on the right; on a phone they
 * stack. The words are `DROPOUT_STORY` (landing-content.ts); MatchTime's
 * own messages are the bot's real strings (`dropout-bot-lines.ts`).
 * Presentational only.
 */
import Link from "next/link";
import { ArrowRight, Check, MapPin } from "lucide-react";
import { DROPOUT_STORY, type DropoutMessage } from "./landing-content";
import { boldSegments, dropoutBotLines } from "./dropout-bot-lines";
import { DISPLAY_FONT } from "./display-font";

function Marked({ line }: { line: string }) {
  return (
    <>
      {boldSegments(line).map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : <span key={i}>{p.text}</span>))}
    </>
  );
}

function Time({ t, className }: { t: string; className: string }) {
  return <div className={`text-[11px] text-right ${className}`}>{t}</div>;
}

function Bubble({ m, bot }: { m: DropoutMessage; bot: Record<"bench-offer" | "bench-claim", string> }) {
  if (m.from === "player") {
    return (
      <div className="self-start relative max-w-[80%] px-3 pt-1.5 pb-2 rounded-2xl rounded-bl-sm bg-slate-800">
        <div className={`text-xs font-semibold ${m.name === DROPOUT_STORY.chat.dropped ? "text-violet-300" : "text-blue-300"}`}>{m.name}</div>
        <div className="text-sm text-slate-100">{m.text}</div>
        <Time t={m.time} className="text-slate-400" />
        {m.ticked && (
          <span
            className="absolute -right-2 -bottom-1.5 w-5 h-5 rounded-full bg-emerald-500 border-2 border-[#0a1633] inline-flex items-center justify-center"
            role="img"
            aria-label="MatchTime ticked it"
          >
            <Check className="w-3 h-3 text-emerald-950" strokeWidth={3} aria-hidden="true" />
          </span>
        )}
      </div>
    );
  }
  if (m.from === "you") {
    return (
      <div className="self-end max-w-[80%] px-3 pt-2 pb-1.5 rounded-2xl rounded-br-sm bg-blue-900">
        <div className="text-sm text-slate-50">{m.text}</div>
        <Time t={m.time} className="text-blue-200" />
      </div>
    );
  }
  const shell = "self-start px-3 py-2 rounded-2xl rounded-bl-sm bg-[#0f3d3a] border border-teal-300/30 flex flex-col gap-1.5";
  const name = <div className="text-xs font-bold text-teal-300">MatchTime</div>;
  if (m.bot === "teams") {
    return (
      <div className={`${shell} w-[90%]`}>
        {name}
        <div className="text-sm text-slate-100">{m.text}</div>
        <ul className="grid grid-cols-2 gap-2" aria-label="Teams">
          {m.teams.map((t, i) => (
            <li
              key={t.key}
              className={`p-2 rounded-lg flex flex-col items-center gap-1 ${i === 0 ? "bg-blue-400/15" : "bg-amber-400/15"}`}
            >
              <svg width="28" height="32" viewBox="0 0 74 88" fill="none" stroke={i === 0 ? "#60a5fa" : "#fbbf24"} strokeWidth="5" strokeLinejoin="round" aria-hidden="true">
                <path d="M24 2Q37 16 50 2L66 8L72 28L62 32L60 26V86H14V26L12 32L2 28L8 8Z" />
              </svg>
              <span className={`text-[13px] font-bold ${i === 0 ? "text-blue-200" : "text-amber-200"}`}>{t.name}</span>
              <span className="text-xs text-slate-200 text-center">{t.players}</span>
            </li>
          ))}
        </ul>
        <Time t={m.time} className="text-teal-200/70" />
      </div>
    );
  }
  const paragraphs = bot[m.bot].split(/\n{2,}/);
  return (
    <div className={`${shell} max-w-[88%]`}>
      {name}
      {paragraphs.map((p, i) =>
        /^(@\S+\s*)+$/.test(p) ? (
          <div key={i} className="text-sm font-semibold text-blue-300">{p}</div>
        ) : (
          <div key={i} className="text-sm text-slate-100 leading-snug">
            <Marked line={p} />
          </div>
        ),
      )}
      <Time t={m.time} className="text-teal-200/70" />
    </div>
  );
}

function PhoneChat() {
  const c = DROPOUT_STORY.chat;
  const bot = dropoutBotLines();
  return (
    <figure
      className="w-full max-w-[340px] shrink-0 mx-auto lg:mx-0 rounded-[46px] border-[3px] border-slate-700 p-2.5 bg-[#0b1226]"
    >
      <div className="rounded-[36px] bg-[#0a1633] overflow-hidden">
        <div className="flex items-center gap-2.5 px-3.5 pt-4 pb-3 border-b border-slate-400/15">
          <span className="w-[34px] h-[34px] rounded-full bg-green-900 inline-flex items-center justify-center" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#86efac" strokeWidth="1.6" strokeLinejoin="round">
              <circle cx="10" cy="10" r="8" />
              <polygon points="10,6.5 13.3,8.9 12,12.8 8,12.8 6.7,8.9" />
            </svg>
          </span>
          <div className="flex flex-col text-left">
            <span className="text-sm font-semibold text-slate-100">{c.groupName}</span>
            <span className="text-xs text-slate-400">{c.groupKind}</span>
          </div>
        </div>
        <div className="px-3 pt-3.5 pb-4 flex flex-col gap-2.5 text-left">
          {c.messages.map((m) => (
            <Bubble key={m.key} m={m} bot={bot} />
          ))}
        </div>
      </div>
      <figcaption className="sr-only">{c.caption}</figcaption>
    </figure>
  );
}

function Timeline() {
  const steps = DROPOUT_STORY.timeline;
  return (
    <ol aria-label="Timeline" className="w-full max-w-[520px] flex flex-col">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const dot = s.key === "claim" ? "bg-emerald-400 shadow-[0_0_0_5px_rgba(52,211,153,0.18)]" : last ? "bg-amber-400 shadow-[0_0_0_5px_rgba(251,191,36,0.18)]" : "bg-blue-400 shadow-[0_0_0_5px_rgba(96,165,250,0.18)]";
        return (
          <li key={s.key} className="grid grid-cols-[52px_24px_minmax(0,1fr)] sm:grid-cols-[60px_24px_minmax(0,1fr)] gap-x-3 sm:gap-x-3.5">
            <span className={`text-[15px] font-bold pt-0.5 tabular-nums ${last ? "text-amber-300" : "text-blue-300"}`}>{s.time}</span>
            <span className="flex flex-col items-center" aria-hidden="true">
              <span className={`w-3.5 h-3.5 mt-1.5 rounded-full ${dot}`} />
              {!last && <span className="flex-1 w-0.5 bg-slate-700 mt-2" />}
            </span>
            <div className={last ? "" : "pb-8"}>
              <h3 className="text-lg sm:text-xl font-extrabold text-white" style={DISPLAY_FONT}>
                {s.title}
              </h3>
              <p className="mt-1.5 text-[15px] sm:text-base leading-relaxed text-slate-300">{s.body}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function DropoutSection() {
  const d = DROPOUT_STORY;
  const headingId = `${d.id}-heading`;
  return (
    <section
      id={d.id}
      aria-labelledby={headingId}
      className="relative bg-[#06102a] border-t border-slate-400/15 py-20 sm:py-28 px-4 sm:px-8 text-slate-100"
    >
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col items-center text-center gap-4">
          <p className="m-0 inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-amber-400/10 border border-amber-400/40 text-sm font-semibold text-amber-200">
            {d.eyebrow}
          </p>
          <h2 id={headingId} className="max-w-3xl text-3xl sm:text-5xl font-extrabold leading-tight tracking-tight text-white" style={DISPLAY_FONT}>
            {d.title}
          </h2>
          <p className="text-base sm:text-lg leading-relaxed text-slate-300">{d.lead}</p>
        </div>

        <div className="mt-12 sm:mt-16 flex flex-col lg:flex-row items-center lg:items-center justify-center gap-14 lg:gap-20">
          <PhoneChat />
          <Timeline />
        </div>

        <p className="mt-12 sm:mt-16 mx-auto max-w-3xl flex items-start gap-3 px-5 py-4 rounded-2xl bg-emerald-400/10 border border-emerald-300/30 text-[15px] sm:text-base leading-relaxed text-emerald-100">
          <MapPin className="w-5 h-5 mt-0.5 shrink-0 text-emerald-300" aria-hidden="true" />
          <span>{d.shortNote}</span>
        </p>

        <div className="mt-10 flex justify-center lg:hidden">
          <Link
            href={d.cta.href}
            className="inline-flex items-center justify-center gap-2 min-h-[48px] px-7 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-base transition-colors"
          >
            {d.cta.label}
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
