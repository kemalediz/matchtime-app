/**
 * A drawn WhatsApp chat (the hero deck's details and the pool section's
 * offer): a header with the chat's name, then the bubbles. `*word*` is bold,
 * WhatsApp style, and `\n` starts a new paragraph. Fictional data, drawn
 * with HTML, no images. Shared by hero-deck.tsx and landing-sections.tsx.
 */
import { Check, Lock, MessageCircle, Shirt, Users } from "lucide-react";
import type { DeckChat, DeckLine } from "./landing-content";

export function TickBadge({ size = "sm" }: { size?: "sm" | "lg" }) {
  const box = size === "lg" ? "w-[30px] h-[30px] -right-2.5 -top-2.5 border-[3px] border-[#0c1631]" : "w-5 h-5 -right-2 -bottom-1.5 border-2 border-[#0a1633]";
  return (
    <span className={`absolute ${box} rounded-full bg-emerald-500 inline-flex items-center justify-center`}>
      <Check className={size === "lg" ? "w-4 h-4 text-white" : "w-3 h-3 text-white"} strokeWidth={3} />
    </span>
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

export function ChatDrawing({ chat }: { chat: DeckChat }) {
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

