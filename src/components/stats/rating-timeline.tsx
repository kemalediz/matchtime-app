"use client";

/**
 * Mobile-first ratings timeline (recharts). Two lines:
 *   - your average peer rating per game (bold)
 *   - the squad average that game (dashed grey) — "you vs the field"
 * MoM games get a gold crown marker. Tapping a point opens a tooltip
 * with that game's detail: your avg, field avg, how many people rated
 * you, and the result/score. Touch-friendly tooltip (recharts handles
 * tap-to-show on mobile).
 */

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  type DotProps,
} from "recharts";

export interface TimelinePointDTO {
  matchId: string;
  label: string;
  myAvg: number | null;
  raterCount: number;
  fieldAvg: number | null;
  isMoM: boolean;
  result: "W" | "D" | "L" | null;
  scoreLine: string | null;
}

const RESULT_LABEL: Record<"W" | "D" | "L", string> = {
  W: "Win",
  D: "Draw",
  L: "Loss",
};

// Custom dot: gold crown ring on MoM games, plain dot otherwise.
function MyDot(props: DotProps & { payload?: TimelinePointDTO }) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || !payload) return null;
  if (payload.isMoM) {
    return (
      <g>
        <circle cx={cx} cy={cy} r={7} fill="#f59e0b" stroke="#fff" strokeWidth={2} />
        <text x={cx} y={cy - 12} textAnchor="middle" fontSize={13}>
          👑
        </text>
      </g>
    );
  }
  return <circle cx={cx} cy={cy} r={4} fill="#2563eb" stroke="#fff" strokeWidth={1.5} />;
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: TimelinePointDTO }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-xl bg-white shadow-lg border border-slate-200 px-3 py-2 text-xs">
      <div className="font-semibold text-slate-800 flex items-center gap-1">
        {p.label}
        {p.isMoM && <span title="Man of the Match">👑</span>}
      </div>
      <div className="mt-1 space-y-0.5">
        <div className="text-blue-600 font-medium">
          You: {p.myAvg?.toFixed(1) ?? "—"}
          <span className="text-slate-400 font-normal">
            {" "}
            · rated by {p.raterCount} {p.raterCount === 1 ? "player" : "players"}
          </span>
        </div>
        <div className="text-slate-500">Squad avg: {p.fieldAvg?.toFixed(1) ?? "—"}</div>
        {p.result && (
          <div className="text-slate-600">
            {RESULT_LABEL[p.result]} {p.scoreLine ?? ""}
          </div>
        )}
      </div>
    </div>
  );
}

export function RatingTimeline({ data }: { data: TimelinePointDTO[] }) {
  if (data.length === 0) {
    return (
      <div className="text-sm text-slate-400 text-center py-10">
        No rated games yet — your timeline fills in after your first rated match.
      </div>
    );
  }

  // Y domain: a little headroom below the lowest value, capped at 10.
  const allVals = data.flatMap((d) =>
    [d.myAvg, d.fieldAvg].filter((x): x is number => x != null),
  );
  const lo = Math.max(0, Math.floor(Math.min(...allVals) - 1));
  const yDomain: [number, number] = [lo, 10];

  return (
    <div className="w-full" style={{ height: 280 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 24, right: 12, left: -16, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: "#64748b" }}
            tickLine={false}
            axisLine={{ stroke: "#e2e8f0" }}
          />
          <YAxis
            domain={yDomain}
            tick={{ fontSize: 11, fill: "#64748b" }}
            tickLine={false}
            axisLine={false}
            width={32}
            allowDecimals={false}
          />
          <Tooltip content={<CustomTooltip />} />
          <Line
            type="monotone"
            dataKey="fieldAvg"
            name="Squad avg"
            stroke="#94a3b8"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={{ r: 3, fill: "#cbd5e1", strokeWidth: 0 }}
            isAnimationActive={false}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="myAvg"
            name="You"
            stroke="#2563eb"
            strokeWidth={3}
            dot={<MyDot />}
            activeDot={{ r: 6 }}
            isAnimationActive={false}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="flex items-center justify-center gap-4 text-[11px] text-slate-500 mt-1">
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-0.5 bg-blue-600" /> You
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-0.5 bg-slate-400" style={{ borderTop: "2px dashed #94a3b8" }} /> Squad avg
        </span>
        <span className="flex items-center gap-1">👑 Man of the Match</span>
      </div>
    </div>
  );
}
