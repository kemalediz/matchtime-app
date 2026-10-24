import { FUNNEL_STEPS, FUNNEL_STEP_LABEL, percent, type FunnelCounts, type FunnelStep } from "@/lib/pool/funnel-rules";

/**
 * The funnel drawn as bars, one per step, widest first (growth slice G2).
 * Plain server-rendered SVG: no chart library, no client code. Each bar is
 * its count against the first step; the conversion from the step before
 * follows the count.
 */
const W = 360;
const ROW = 36;
const BAR = 12;

export function FunnelChart({ counts, conversion }: { counts: FunnelCounts; conversion: Record<FunnelStep, number | null> }) {
  const max = Math.max(1, counts.signedUp);
  const summary = FUNNEL_STEPS.map((s) => `${FUNNEL_STEP_LABEL[s]} ${counts[s]}`).join(", ");
  return (
    <svg
      viewBox={`0 0 ${W} ${ROW * FUNNEL_STEPS.length}`}
      role="img"
      aria-label={`Funnel: ${summary}`}
      data-testid="funnel-chart"
      className="w-full max-w-xl"
    >
      {FUNNEL_STEPS.map((s, i) => {
        const y = i * ROW;
        const width = counts[s] === 0 ? 0 : Math.max(2, (counts[s] / max) * W);
        const rate = percent(conversion[s]);
        return (
          <g key={s} data-testid="funnel-bar" data-step={s} data-count={counts[s]}>
            <text x={0} y={y + 13} fontSize={12} fill="#334155">
              {FUNNEL_STEP_LABEL[s]}
            </text>
            <text x={W} y={y + 13} fontSize={12} fill="#0f172a" textAnchor="end" fontWeight={600}>
              {counts[s]}
              {rate !== null ? ` (${rate})` : ""}
            </text>
            <rect x={0} y={y + 18} width={W} height={BAR} rx={3} fill="#f1f5f9" />
            <rect x={0} y={y + 18} width={width} height={BAR} rx={3} fill="#2563eb" />
          </g>
        );
      })}
    </svg>
  );
}
