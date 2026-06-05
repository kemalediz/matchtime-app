import { RemoveFromMatchButton } from "./remove-from-match-button";

interface AttendancePlayer {
  id: string;
  status: string;
  position: number;
  user: {
    id: string;
    name: string | null;
    image: string | null;
    positions: string[];
  };
}

function Initials({ name }: { name: string | null }) {
  const letter = (name ?? "?").charAt(0).toUpperCase();
  return (
    <div className="w-8 h-8 rounded-full bg-blue-50 text-blue-700 flex items-center justify-center text-xs font-semibold shrink-0">
      {letter}
    </div>
  );
}

export function AttendanceList({
  attendances,
  maxPlayers,
  admin = false,
  matchId,
}: {
  attendances: AttendancePlayer[];
  maxPlayers: number;
  /** When true (and matchId given), show an admin remove (×) per row. */
  admin?: boolean;
  matchId?: string;
}) {
  const confirmed = attendances
    .filter((a) => a.status === "CONFIRMED")
    .sort((a, b) => a.position - b.position);
  const bench = attendances
    .filter((a) => a.status === "BENCH")
    .sort((a, b) => a.position - b.position);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
          Players ({confirmed.length}/{maxPlayers})
        </h3>
        <ul className="space-y-2">
          {confirmed.map((a, i) => (
            <li key={a.id} className="flex items-center gap-3 py-1">
              <span className="text-xs text-slate-400 w-5 text-right font-mono">{i + 1}</span>
              <Initials name={a.user.name} />
              <span className="text-sm font-medium text-slate-800 truncate">{a.user.name}</span>
              <div className="ml-auto flex items-center gap-1.5">
                {a.user.positions.slice(0, 2).map((pos) => (
                  <span
                    key={pos}
                    className="inline-flex px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-semibold"
                  >
                    {pos}
                  </span>
                ))}
                {admin && matchId && (
                  <RemoveFromMatchButton matchId={matchId} userId={a.user.id} name={a.user.name} />
                )}
              </div>
            </li>
          ))}
          {confirmed.length === 0 && (
            <li className="text-sm text-slate-400 py-3">No confirmed players yet.</li>
          )}
        </ul>
      </div>

      {bench.length > 0 && (
        <div className="pt-6 border-t border-slate-100">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
            Bench ({bench.length})
          </h3>
          <ul className="space-y-2">
            {bench.map((a, i) => (
              <li key={a.id} className="flex items-center gap-3 py-1 opacity-70">
                <span className="text-xs text-slate-400 w-5 text-right font-mono">{i + 1}</span>
                <Initials name={a.user.name} />
                <span className="text-sm text-slate-700">{a.user.name}</span>
                {admin && matchId && (
                  <span className="ml-auto">
                    <RemoveFromMatchButton matchId={matchId} userId={a.user.id} name={a.user.name} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
