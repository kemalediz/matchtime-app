/**
 * Two real pages, drawn for the hero deck (round three, 2026-10-27).
 *
 *   RateSketch   src/app/matches/[matchId]/rate/page.tsx: the page a
 *                player's private rating link opens.
 *   StatsSketch  src/app/profile/stats/page.tsx: a player's own stats page,
 *                badges included (badge-rules.ts BADGES).
 *
 * The layout, labels and controls mirror those pages (light cards on a
 * slate-50 page, blue score circles, the amber Man of the Match box, the
 * stat tiles, the badge grid with unearned badges greyed). The words and
 * numbers are data (`RATE_SKETCH`, `STATS_SKETCH` in landing-content.ts),
 * fictional. Static: nothing here is a real control.
 */
import { Send, Star, Trophy } from "lucide-react";
import { RATE_SKETCH, STATS_SKETCH } from "./landing-content";

/** A phone screen: a light page inside a dark frame, like the chat drawings. */
function Screen({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <figure aria-label={label} className="w-full max-w-[360px] rounded-[26px] bg-slate-950 p-1.5 ring-1 ring-white/10 text-left">
      <div className="rounded-[21px] bg-slate-50 px-3 py-4 text-slate-800">{children}</div>
    </figure>
  );
}

function Initial({ name }: { name: string }) {
  return (
    <span className="w-7 h-7 rounded-full bg-blue-50 text-blue-700 flex items-center justify-center text-[11px] font-semibold shrink-0">
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export function RateSketch() {
  const r = RATE_SKETCH;
  return (
    <Screen label="The rating page a player opens">
      <div className="text-center">
        <p className="text-lg font-bold text-slate-800">{r.title}</p>
        <p className="mt-0.5 text-[11px] text-slate-500">{r.prompt}</p>
      </div>
      <div className="mt-3 space-y-2">
        {r.players.map((p) => (
          <div key={p.name} className="rounded-xl border border-slate-200 bg-white p-2.5 shadow-sm">
            <div className="mb-2 flex items-center gap-2">
              <Initial name={p.name} />
              <span className="flex-1 truncate text-[13px] font-semibold text-slate-800">{p.name}</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-600">{p.position}</span>
              <span className="w-6 text-center text-base font-bold text-blue-600">{p.score}</span>
            </div>
            <div className="flex justify-between gap-0.5">
              {r.scores.map((s) => (
                <span
                  key={s}
                  className={`w-[24px] h-[24px] rounded-full text-[10px] font-bold inline-flex items-center justify-center ${
                    s === p.score ? "bg-blue-600 text-white shadow-md scale-110" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2.5 rounded-xl border-2 border-amber-200 bg-white p-2.5 shadow-sm">
        <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-slate-800">
          <Trophy className="w-4 h-4 text-amber-500" aria-hidden="true" />
          {r.mom}
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {r.players.map((p) => {
            const picked = p.name === r.momPick;
            return (
              <span
                key={p.name}
                className={`flex items-center gap-1.5 rounded-lg border p-1.5 ${picked ? "border-amber-400 bg-amber-50" : "border-slate-200"}`}
              >
                <Initial name={p.name} />
                <span className="truncate text-xs font-medium text-slate-800">{p.name}</span>
                {picked && <Star className="ml-auto w-3.5 h-3.5 shrink-0 fill-amber-500 text-amber-500" aria-hidden="true" />}
              </span>
            );
          })}
        </div>
      </div>
      <span className="mt-2.5 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 text-[13px] font-medium text-white shadow-lg">
        <Send className="w-3.5 h-3.5" aria-hidden="true" />
        {r.submit}
      </span>
      <span className="mt-2 flex h-9 w-full items-center justify-center rounded-lg bg-slate-100 text-xs font-medium text-slate-700">{r.seeStats}</span>
    </Screen>
  );
}

const TILE_TONE: Record<string, string> = {
  green: "bg-emerald-50 border-emerald-200",
  amber: "bg-amber-50 border-amber-200",
  blue: "bg-blue-50 border-blue-200",
  slate: "bg-white border-slate-200",
};

/** His line (blue) against the squad's (dashed grey), as RatingTimeline draws them. */
function Timeline({ you, squad }: { you: number[]; squad: number[] }) {
  const W = 300, H = 84, min = 5, max = 9;
  const x = (i: number) => 14 + (i * (W - 20)) / (you.length - 1);
  const y = (v: number) => H - 8 - ((v - min) / (max - min)) * (H - 16);
  const path = (a: number[]) => a.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-hidden="true">
      {[9, 7, 5].map((g) => (
        <g key={g}>
          <line x1="14" x2={W - 6} y1={y(g)} y2={y(g)} stroke="#e2e8f0" strokeDasharray="2 3" />
          <text x="0" y={y(g) + 3} fontSize="8" fill="#94a3b8">
            {g}
          </text>
        </g>
      ))}
      <path d={path(squad)} fill="none" stroke="#cbd5e1" strokeWidth="2" strokeDasharray="4 3" />
      <path d={path(you)} fill="none" stroke="#2563eb" strokeWidth="2.5" strokeLinecap="round" />
      {you.map((v, i) => (
        <circle key={i} cx={x(i)} cy={y(v)} r="2.8" fill="#2563eb" />
      ))}
    </svg>
  );
}

export function StatsSketch() {
  const s = STATS_SKETCH;
  const earned = s.badges.filter((b) => b.earned).length;
  return (
    <Screen label="A player's stats page">
      <p className="text-lg font-bold text-slate-900">{s.heading}</p>
      <p className="text-[11px] text-slate-500">{s.sub}</p>
      <p className="mt-3 text-xs font-semibold text-slate-800">{s.clubRatingLabel}</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {s.tiles.map((t) => (
          <div key={t.label} className={`rounded-xl border p-2.5 ${TILE_TONE[t.tone]}`}>
            <p className="text-xl font-extrabold text-slate-900">{t.big}</p>
            <p className="text-[10px] font-medium text-slate-600">{t.label}</p>
            {t.sub && <p className="text-[10px] text-slate-500">{t.sub}</p>}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-400">{s.form.label}</p>
          <p className="text-sm font-semibold text-slate-800">{s.form.value}</p>
        </div>
        <div className="text-right">
          <p className="text-xl font-bold text-slate-900">{s.form.avg}</p>
          <p className="text-[10px] text-slate-400">{s.form.sub}</p>
        </div>
      </div>
      <div className="mt-2 rounded-2xl border border-slate-200 bg-white p-3">
        <p className="mb-1 text-xs font-semibold text-slate-800">{s.timeline.title}</p>
        <Timeline you={s.timeline.you} squad={s.timeline.squad} />
      </div>
      <div className="mt-2 rounded-2xl border border-slate-200 bg-white p-3">
        <p className="mb-1.5 text-xs font-semibold text-slate-800">{s.chemistry.title}</p>
        <p className="text-[10px] uppercase tracking-wider text-slate-400">{s.chemistry.row}</p>
        <p className="text-sm font-semibold text-slate-800">{s.chemistry.name}</p>
        <p className="text-[10px] text-slate-500">{s.chemistry.detail}</p>
      </div>
      <div className="mt-2 rounded-2xl border border-slate-200 bg-white p-3">
        <p className="mb-2 text-xs font-semibold text-slate-800">
          {s.badgesTitle}{" "}
          <span className="font-normal text-slate-400">
            ({earned}/{s.badges.length})
          </span>
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {s.badges.map((b) => (
            <div
              key={b.key}
              className={`flex items-center gap-1.5 rounded-xl border p-2 ${b.earned ? "bg-amber-50 border-amber-200" : "bg-slate-50 border-slate-200 opacity-50"}`}
            >
              <span className={`text-base ${b.earned ? "" : "grayscale"}`} aria-hidden="true">
                {b.emoji}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-semibold text-slate-800">{b.label}</span>
                <span className="block text-[9px] leading-tight text-slate-400">{b.hint}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </Screen>
  );
}
