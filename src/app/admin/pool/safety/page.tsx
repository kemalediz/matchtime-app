import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { formatLondon } from "@/lib/london-time";
import { loadPoolSafety } from "@/lib/pool/safety";
import { LiftPauseButton, ReviewedButton } from "./safety-controls";

/**
 * /admin/pool/safety: the platform owner's player pool safety page (slice
 * L7, plan sections 5.5 and 9). Where the owner DMs about the pool point:
 *   - open reports, from a club about a guest or from a player about a
 *     club (each side's report reaches only this page and the owner, never
 *     the other side), with "Mark reviewed";
 *   - pauses MatchTime decided (no-shows, reports from two clubs, the
 *     owner), whether the player asked a person to look, and "Lift the
 *     pause" (he is told offers are on again);
 *   - clubs that marked more than 3 different pool players no-show in 30
 *     days (a club abusing the marker).
 * OWNER ONLY: 404 to anybody who is not `User.isSuperadmin`; the actions
 * check again (`app/actions/pool-safety.ts`). English only (owner copy).
 */
export const dynamic = "force-dynamic";

const REASON: Record<string, string> = { "no-shows": "No-shows", reports: "Reports from two clubs", admin: "Paused by the owner" };
const when = (d: Date | null) => (d ? formatLondon(d, "d MMM yyyy, HH:mm") : "");

export default async function PoolSafetyPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isSuperadmin(session.user.id))) notFound();
  const v = await loadPoolSafety();

  return (
    <div className="space-y-10" data-testid="pool-safety-page">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Player pool safety</h2>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Reports from clubs and players, pauses MatchTime decided, and clubs marking many no-shows. Nothing here is shown to the other side.
        </p>
      </div>

      <section aria-labelledby="ps-reports" className="space-y-3">
        <h3 id="ps-reports" className="text-lg font-semibold text-slate-900">
          Open reports ({v.reports.length})
        </h3>
        {v.reports.length === 0 ? (
          <p className="text-sm text-slate-600">None.</p>
        ) : (
          <ul className="space-y-3">
            {v.reports.map((r) => (
              <li key={r.id} data-testid="ps-report" data-by={r.by} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-2">
                <p className="text-sm text-slate-600">
                  {r.by === "club" ? `${r.club} about their guest ${r.player ?? "(no name)"}` : `${r.player ?? "A player"} about ${r.club}`} · {when(r.createdAt)}
                </p>
                <p className="whitespace-pre-wrap break-words text-sm text-slate-900" data-testid="ps-report-text">
                  {r.text}
                </p>
                <ReviewedButton reportId={r.id} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="ps-pauses" className="space-y-3">
        <h3 id="ps-pauses" className="text-lg font-semibold text-slate-900">
          Pauses MatchTime decided ({v.pauses.length})
        </h3>
        {v.pauses.length === 0 ? (
          <p className="text-sm text-slate-600">None.</p>
        ) : (
          <ul className="space-y-3">
            {v.pauses.map((p) => (
              <li key={p.userId} data-testid="ps-pause" data-reason={p.reason} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-2">
                <p className="font-medium text-slate-900">{p.name}</p>
                <p className="text-sm text-slate-600">
                  {REASON[p.reason] ?? p.reason} since {when(p.pausedAt)}
                  {p.status === "stopped" ? " (he has stopped offers himself too)" : ""}. Turned up to {p.record.played} of {p.record.played + p.record.missed} guest games.
                </p>
                {p.reviewRequestedAt && (
                  <p className="text-sm font-medium text-amber-800" data-testid="ps-review-asked">
                    Asked a person to look at it, {when(p.reviewRequestedAt)}.
                  </p>
                )}
                <LiftPauseButton userId={p.userId} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="ps-clubs" className="space-y-3">
        <h3 id="ps-clubs" className="text-lg font-semibold text-slate-900">
          Clubs marking many no-shows
        </h3>
        {v.flaggedClubs.length === 0 ? (
          <p className="text-sm text-slate-600">None in the last 30 days.</p>
        ) : (
          <ul className="space-y-2">
            {v.flaggedClubs.map((c) => (
              <li key={c.orgId} data-testid="ps-flagged-club" className="text-sm text-slate-800">
                {c.name}: {c.players} different pool players marked no-show in 30 days
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
