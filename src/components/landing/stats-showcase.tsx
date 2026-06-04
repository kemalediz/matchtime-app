/**
 * Marketing showcase for the player season-stats feature. Faithful,
 * pixel-clean recreations of the real /profile/stats screens and the
 * Wrapped share card — rendered in code (not screenshots) so they stay
 * sharp on retina and fully responsive. ALL data here is invented
 * (fictional players + "Riverside FC") — no real squad data, per
 * data-sharing rules.
 */

const DISPLAY: React.CSSProperties = { fontFamily: "var(--font-display), system-ui, sans-serif" };

/** A phone-shaped frame with a clipped screen, like a real screenshot. */
function Phone({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <figure className="shrink-0 w-[268px] snap-center">
      <div className="relative rounded-[2.5rem] bg-slate-800 p-2 shadow-2xl ring-1 ring-white/10">
        <div className="absolute left-1/2 top-2 z-10 h-5 w-28 -translate-x-1/2 rounded-b-2xl bg-slate-800" />
        <div className="h-[540px] overflow-hidden rounded-[2rem] bg-slate-50">
          <div className="h-full overflow-hidden p-3">{children}</div>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-sm text-slate-400">{label}</figcaption>
    </figure>
  );
}

function StatCard({ value, label, sub, subClass = "text-slate-400", valueClass = "text-slate-900" }: {
  value: string; label: string; sub?: string; subClass?: string; valueClass?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className={`text-2xl font-extrabold ${valueClass}`} style={DISPLAY}>{value}</p>
      <p className="text-[11px] font-medium text-slate-600">{label}</p>
      {sub && <p className={`text-[10px] ${subClass}`}>{sub}</p>}
    </div>
  );
}

/** Mini ratings line chart — "You" (solid blue) vs squad avg (dashed). */
function RatingsChart() {
  const you = [7.6, 7.0, 7.5, 7.1, 7.2, 7.6];
  const squad = [6.9, 6.7, 7.0, 6.8, 6.9, 6.9];
  const W = 232, H = 96, min = 5, max = 9;
  const x = (i: number) => 6 + (i * (W - 12)) / (you.length - 1);
  const y = (v: number) => H - 8 - ((v - min) / (max - min)) * (H - 20);
  const path = (a: number[]) => a.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {[9, 7, 5].map((g) => (
        <g key={g}>
          <line x1="6" x2={W - 6} y1={y(g)} y2={y(g)} stroke="#e2e8f0" strokeDasharray="2 3" />
          <text x="0" y={y(g) + 3} fontSize="8" fill="#94a3b8">{g}</text>
        </g>
      ))}
      <path d={path(squad)} fill="none" stroke="#cbd5e1" strokeWidth="2" strokeDasharray="4 3" />
      <path d={path(you)} fill="none" stroke="#2563eb" strokeWidth="2.5" strokeLinecap="round" />
      {you.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="3" fill="#2563eb" />)}
      {/* MoM marker on the 5th point */}
      <circle cx={x(4)} cy={y(you[4])} r="4.5" fill="#f59e0b" />
      <text x={x(4) - 5} y={y(you[4]) - 7} fontSize="11">🔥</text>
    </svg>
  );
}

const LEADERBOARD: Array<[number, string, string, string]> = [
  [1, "Marcus Bell", "—", "8.1"],
  [2, "Danny Cole", "—", "7.9"],
  [3, "Alex (you)", "↑3", "7.4"],
  [4, "Ryan Park", "new", "7.4"],
  [5, "Sam Reid", "—", "7.4"],
  [6, "Jay Patel", "↓2", "7.3"],
  [7, "Chris Adeyemi", "↑1", "7.2"],
  [8, "Luca Romano", "new", "7.1"],
  [9, "Tom Frost", "new", "7.0"],
  [10, "Nico Vidal", "↓7", "7.0"],
  [11, "Omar Haddad", "↓4", "6.9"],
];

function moveClass(m: string) {
  if (m.startsWith("↑")) return "text-emerald-600";
  if (m.startsWith("↓")) return "text-red-500";
  if (m === "new") return "text-blue-500";
  return "text-slate-300";
}

const TOTS: Array<[string, string, string]> = [
  ["GK", "Alex (you)", "7.4"],
  ["DEF", "Marcus Bell", "8.1"],
  ["DEF", "Jay Patel", "7.3"],
  ["MID", "Danny Cole", "7.9"],
  ["MID", "Ryan Park", "7.4"],
  ["FWD", "Sam Reid", "7.4"],
  ["FWD", "Chris Adeyemi", "7.2"],
];

const BADGES: Array<[string, string, string, boolean]> = [
  ["👟", "On the board", "Played your first game", true],
  ["🔟", "Regular", "Played 10+ games", false],
  ["🏋️", "Iron Man", "Played every single match", true],
  ["🏆", "Man of the Match", "Won MoM at least once", true],
  ["🥈", "MoM Machine", "Won MoM 3+ times", false],
  ["⭐", "Masterclass", "Averaged 9+ in a game", false],
  ["🟫", "Mr Reliable", "Consistently strong ratings", true],
  ["📈", "Above the Curve", "Rating above squad average", true],
];

export function StatsShowcase() {
  return (
    <div className="-mx-5 flex gap-6 overflow-x-auto px-5 pb-4 snap-x sm:mx-0 sm:justify-center sm:px-0">
      {/* Phone 1 — dashboard + ratings chart */}
      <Phone label="The season dashboard">
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            <StatCard value="7.4" label="Avg rating" sub="+11% vs squad" subClass="text-emerald-600" valueClass="text-emerald-600" />
            <StatCard value="1" label="Man of the Match" sub="🏆" valueClass="text-amber-500" />
            <StatCard value="7" label="Games played" sub="100% attendance" valueClass="text-blue-600" />
            <StatCard value="2-2-3" label="W–D–L" sub="GD -3" />
          </div>
          <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-slate-400">Current form</p>
              <p className="font-bold text-slate-800">➡️ Steady</p>
            </div>
            <div className="text-right">
              <p className="text-xl font-extrabold text-slate-900" style={DISPLAY}>7.4</p>
              <p className="text-[10px] text-slate-400">last 5 games</p>
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-sm font-bold text-slate-800">Ratings over time</p>
            <p className="mb-1 text-[10px] text-slate-400">Tap a point for that game&apos;s detail.</p>
            <RatingsChart />
            <div className="mt-1 flex justify-center gap-3 text-[9px] text-slate-500">
              <span>— You</span><span className="text-slate-400">--- Squad avg</span><span>🔥 MoM</span>
            </div>
          </div>
        </div>
      </Phone>

      {/* Phone 2 — leaderboard + team of the season */}
      <Phone label="Leaderboard & Team of the Season">
        <div className="space-y-2.5">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="mb-1.5 text-sm font-bold text-slate-800">Squad leaderboard</p>
            <div className="space-y-0.5">
              {LEADERBOARD.map(([rank, name, move, rating]) => {
                const you = name.includes("you");
                return (
                  <div key={rank} className={`flex items-center gap-2 rounded-md px-1.5 py-1 text-[12px] ${you ? "bg-blue-50" : ""}`}>
                    <span className="w-3 text-slate-400">{rank}</span>
                    <span className={`flex-1 truncate ${you ? "font-bold text-blue-700" : "text-slate-700"}`}>{name}</span>
                    <span className={`w-7 text-right text-[11px] font-medium ${moveClass(move)}`}>{move}</span>
                    <span className="w-7 text-right font-semibold text-slate-900">{rating}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="rounded-xl bg-gradient-to-br from-emerald-800 to-emerald-900 p-3 text-white shadow">
            <p className="mb-1.5 text-sm font-bold">⚽ Team of the Season</p>
            <div className="space-y-1">
              {TOTS.map(([pos, name, rating]) => (
                <div key={pos + name} className="flex items-center gap-2 text-[12px]">
                  <span className="w-8 text-emerald-300">{pos}</span>
                  <span className="flex-1 truncate">{name}</span>
                  <span className="font-semibold">{rating}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Phone>

      {/* Phone 3 — badges + chemistry/rivalries */}
      <Phone label="Badges, chemistry & rivalries">
        <div className="space-y-2.5">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="mb-2 text-sm font-bold text-slate-800">Badges <span className="text-slate-400">(5/8)</span></p>
            <div className="grid grid-cols-2 gap-2">
              {BADGES.map(([icon, name, desc, earned]) => (
                <div key={name} className={`rounded-lg border p-2 ${earned ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50 opacity-60"}`}>
                  <p className="text-base leading-none">{icon}</p>
                  <p className="mt-1 text-[11px] font-bold leading-tight text-slate-800">{name}</p>
                  <p className="text-[9px] leading-tight text-slate-500">{desc}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="mb-1 text-sm font-bold text-slate-800">Rivalries</p>
            <p className="text-[10px] uppercase tracking-wider text-slate-400">🤬 Your nemesis</p>
            <p className="text-[12px] font-semibold text-slate-800">Ryan Park <span className="font-normal text-slate-500">· won 0 of 4</span></p>
            <p className="mt-1.5 text-[10px] uppercase tracking-wider text-slate-400">😎 You own</p>
            <p className="text-[12px] font-semibold text-slate-800">Danny Cole <span className="font-normal text-slate-500">· 2 from 2</span></p>
          </div>
        </div>
      </Phone>
    </div>
  );
}

/** The Spotify-Wrapped-style share card players screenshot into the group. */
export function WrappedCard() {
  return (
    <div className="relative mx-auto w-full max-w-sm">
      <div className="absolute -inset-4 rounded-[2rem] bg-gradient-to-br from-blue-500/30 to-emerald-500/20 blur-2xl" />
      <div className="relative rounded-[1.75rem] border border-white/10 bg-gradient-to-br from-slate-900 via-blue-950 to-blue-900 p-7 shadow-2xl">
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-1.5 font-bold text-white">⚽ MatchTime</span>
          <span className="text-blue-300">Riverside FC</span>
        </div>
        <p className="mt-6 text-xs tracking-widest text-slate-400">SEASON SO FAR</p>
        <p className="text-3xl font-extrabold text-white" style={DISPLAY}>Alex</p>
        <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-5 text-center">
          <p className="text-[11px] tracking-widest text-blue-300">AVERAGE RATING</p>
          <p className="mt-1 text-6xl font-extrabold leading-none text-white" style={DISPLAY}>7.4</p>
          <p className="mt-2 text-sm font-semibold text-emerald-400">▲ 11% vs squad average</p>
        </div>
        <div className="mt-5 flex items-center justify-between text-center">
          <div><p className="text-2xl font-extrabold text-white">1</p><p className="text-[11px] text-slate-400">🏆 MoM</p></div>
          <div><p className="text-2xl font-extrabold text-white">7</p><p className="text-[11px] text-slate-400">👟 Games</p></div>
          <div><p className="text-2xl font-extrabold text-white">2-2-3</p><p className="text-[11px] text-slate-400">W-D-L</p></div>
        </div>
        <div className="mt-5 space-y-1 text-sm text-slate-200">
          <p>➡️ Steady · last 5: 7.4</p>
          <p>📈 Above the Curve</p>
          <p className="text-xs text-blue-300">Best game: 21 Apr — 8.0 ⭐</p>
        </div>
      </div>
      <div className="absolute -bottom-3 -right-2 flex rotate-3 items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-slate-900 shadow-xl">
        📲 Shareable card
      </div>
    </div>
  );
}
