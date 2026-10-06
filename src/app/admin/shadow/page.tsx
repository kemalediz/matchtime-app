import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import type {
  WindowVerdict as WindowVerdictShape,
  WindowStateChange,
} from "@/lib/window-analyzer";

/**
 * /admin/shadow — read-only dashboard over the `WindowVerdict` table.
 *
 * Built 2026-05-29 to compare the shadow window-analyzer's single-diff
 * verdict against the live per-message analyzer's verdicts for the same
 * batch, and to give us a week of comparison data before deciding
 * whether to cut over.
 *
 * ── THE LIVE SHADOW IS RETIRED (§10 step 7/8, 2026-09-06) ───────────
 *
 *   `isShadowAnalysisEnabled` used to drive the banner below; the flag,
 *   `runShadowAnalysis` and the whole one-coherent-diff prompt are
 *   deleted. The shadow was a COMPARISON against the mega-prompt, and
 *   step 8 deleted the mega-prompt, so there is nothing left on the
 *   other side of the diff. `src/lib/window-analyzer.ts` carries the
 *   full argument.
 *
 *   THIS PAGE IS NOT DEAD AND IS NOT AN ARCHIVE. Two reasons it keeps
 *   earning its place:
 *
 *     1. Three months of historical rows are the record of how the
 *        cut-over decision was reached.
 *     2. `api/cron/none-bucket-shadow` still WRITES new `WindowVerdict`
 *        rows — §11.1's fourth containment, the nightly re-examination
 *        of the messages the router called banter. After step 8 that
 *        sweep is the ONLY thing watching for a real IN the router got
 *        wrong, so its output is the most important thing on this page.
 *
 *   The "Live (per-message)" column is joined from `AnalyzedMessage` and
 *   keeps working unchanged: those rows are written by whichever owner
 *   handled the message, which since step 8 is an engine rather than the
 *   analyzer.
 *
 * Layout: per WindowVerdict row, show
 *   - window timestamps + cost + latency
 *   - the messages in the window (resolved via waMessageId join)
 *   - the recorded verdict: summary, stateChanges, groupReply
 *   - live verdicts: per AnalyzedMessage row, intent + action
 *   - cheap "agreement" badge — heuristic, not authoritative
 */
export default async function ShadowDashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");

  const orgId = membership.orgId;

  const verdicts = await db.windowVerdict.findMany({
    where: { orgId, createdAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) } },
    orderBy: { windowEnd: "desc" },
    take: 100,
  });

  // For each verdict, load: (a) the inbound messages by waMessageId, (b) the
  // live AnalyzedMessage rows for those waMessageIds.
  const enriched = await Promise.all(
    verdicts.map(async (v) => {
      const refs = v.currentVerdictRefs;
      const [analyzedMessages, groupMessages] = await Promise.all([
        db.analyzedMessage.findMany({
          where: { waMessageId: { in: refs } },
          select: {
            waMessageId: true,
            authorName: true,
            body: true,
            intent: true,
            action: true,
            handledBy: true,
            reasoning: true,
          },
        }),
        db.groupMessage.findMany({
          where: { waMessageId: { in: refs } },
          select: { waMessageId: true, body: true, senderPushname: true, timestamp: true },
        }),
      ]);
      const amByWa = new Map(analyzedMessages.map((m) => [m.waMessageId, m]));
      const gmByWa = new Map(groupMessages.map((m) => [m.waMessageId, m]));
      const shadow = v.verdictJson as unknown as WindowVerdictShape;
      return { v, shadow, amByWa, gmByWa };
    }),
  );

  const totalCost = verdicts.reduce((s, v) => s + (v.costUsd ?? 0), 0);
  const dayCount = Math.max(1, Math.ceil((Date.now() - (verdicts.at(-1)?.createdAt.getTime() ?? Date.now())) / (24 * 60 * 60 * 1000)));

  return (
    <div className="space-y-4">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
        <ArrowLeft className="w-4 h-4" /> Back to admin
      </Link>

      <div>
        <h1 className="text-2xl font-bold text-slate-900">Window verdicts</h1>
        <p className="text-sm text-slate-600 mt-1">
          Window-level verdicts recorded alongside the live per-message ones. No attendance is
          written from this path: it is a read-only comparison view.
        </p>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">The shadow window-analyzer is retired. This page shows historical runs.</p>
        <p className="mt-1">
          It ran on every batch from 29 May to 31 Aug 2026 (a second, uncached Sonnet call per
          batch, roughly 30% of the analyzer bill) and was switched off on 31 Aug without a
          decision ever having been taken from it. On 6 Sep 2026 it was deleted outright: it
          compared the new pipeline against the old mega-prompt, and the mega-prompt is gone, so
          there is nothing left on the other side of the diff.
        </p>
        <p className="mt-2">
          Rows dated before then are historical and are kept as the record of how that decision was
          reached. There is no flag to turn it back on.
        </p>
        <p className="mt-2">
          <span className="font-semibold">New rows can still appear here.</span> The nightly
          none-bucket sweep (<code className="font-mono text-xs">NONE_BUCKET_SHADOW_ENABLED</code>)
          writes into the same table when it re-examines messages the router treated as banter. That
          sweep is now the only thing watching for a real IN the router got wrong, so its rows are
          the ones worth reading.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Windows analyzed (14d)" value={verdicts.length.toString()} />
        <Stat label="Total model cost" value={`$${totalCost.toFixed(4)}`} />
        <Stat label="Avg cost/window" value={`$${(verdicts.length ? totalCost / verdicts.length : 0).toFixed(4)}`} />
      </div>

      {verdicts.length === 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
          No window verdicts in the last 14 days. The shadow analyzer that used to fill this table on
          every batch is retired, so this is expected. Nothing is broken. Rows appear here when the
          nightly none-bucket sweep runs.
        </div>
      )}

      <div className="space-y-3">
        {enriched.map(({ v, shadow, amByWa, gmByWa }) => {
          const agreement = computeAgreement(shadow, amByWa);
          return (
            <div key={v.id} className="rounded-lg border border-slate-200 bg-white overflow-hidden">
              <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 flex items-center justify-between text-xs">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-slate-700">
                    {format(v.windowStart, "EEE d MMM HH:mm")} to {format(v.windowEnd, "HH:mm")}
                  </span>
                  <span className="text-slate-500">({formatDistanceToNow(v.createdAt, { addSuffix: true })})</span>
                  <span className="text-slate-500">{v.modelMs}ms</span>
                  <span className="text-slate-500">${v.costUsd?.toFixed(4) ?? "-"}</span>
                  <AgreementBadge agreement={agreement} />
                </div>
                <div className="text-slate-400 font-mono">{v.batchHash.slice(0, 8)}</div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x divide-slate-200">
                {/* Shadow side */}
                <div className="p-4 space-y-3 bg-emerald-50/40">
                  <div className="text-xs uppercase tracking-wider text-emerald-700 font-semibold">Recorded (window-level)</div>
                  <p className="text-sm text-slate-800 italic">"{shadow.windowSummary}"</p>
                  {shadow.stateChanges.length === 0 ? (
                    <div className="text-xs text-slate-500 italic">No state changes.</div>
                  ) : (
                    <ul className="space-y-1">
                      {shadow.stateChanges.map((c, i) => (
                        <li key={i} className="text-xs">
                          <span className="font-mono px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">{c.action}</span>{" "}
                          <span className="font-medium">{c.targetName}</span>
                          {c.swapWithName ? <span className="text-slate-500"> ↔ {c.swapWithName}</span> : null}
                          {typeof c.scoreRed === "number" && typeof c.scoreYellow === "number" ? (
                            <span className="text-slate-500"> ({c.scoreRed}-{c.scoreYellow})</span>
                          ) : null}
                          <div className="text-slate-500 ml-1">{c.reason}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {shadow.groupReply && (
                    <div className="text-xs">
                      <div className="text-slate-500 uppercase tracking-wider mb-1">Group reply</div>
                      <div className="rounded bg-white border border-emerald-200 p-2 whitespace-pre-wrap font-mono text-[11px]">
                        {shadow.groupReply}
                      </div>
                    </div>
                  )}
                </div>

                {/* Live side */}
                <div className="p-4 space-y-3 bg-amber-50/40">
                  <div className="text-xs uppercase tracking-wider text-amber-700 font-semibold">Live (per-message)</div>
                  <ul className="space-y-2">
                    {v.currentVerdictRefs.map((wa) => {
                      const am = amByWa.get(wa);
                      const gm = gmByWa.get(wa);
                      return (
                        <li key={wa} className="text-xs">
                          <div className="font-mono text-slate-700">
                            {gm?.senderPushname ?? am?.authorName ?? "(unknown)"}
                          </div>
                          <div className="text-slate-600 whitespace-pre-wrap">{(gm?.body ?? am?.body ?? "").slice(0, 200)}</div>
                          <div className="mt-1">
                            {am ? (
                              <>
                                <span className="font-mono px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">{am.intent ?? "-"}</span>{" "}
                                {am.action && <span className="text-slate-500">act: {am.action}</span>}
                              </>
                            ) : (
                              <span className="text-slate-400 italic">(no AnalyzedMessage row)</span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-lg font-semibold text-slate-900">{value}</div>
    </div>
  );
}

type Agreement = "agree" | "diff" | "needs-review";

function AgreementBadge({ agreement }: { agreement: Agreement }) {
  const styles: Record<Agreement, string> = {
    agree: "bg-green-100 text-green-700",
    diff: "bg-red-100 text-red-700",
    "needs-review": "bg-slate-200 text-slate-700",
  };
  const label: Record<Agreement, string> = {
    agree: "agree",
    diff: "diff",
    "needs-review": "needs review",
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${styles[agreement]}`}>
      {label[agreement]}
    </span>
  );
}

/** Cheap heuristic: do the recorded stateChange action-counts match the
 *  live verdicts' implied actions (IN/OUT/etc)? Not authoritative —
 *  this is a glance-filter for the dashboard. */
function computeAgreement(
  shadow: WindowVerdictShape,
  amByWa: Map<
    string,
    { intent: string | null; action: string | null; reasoning: string | null }
  >,
): Agreement {
  if (amByWa.size === 0 || shadow.stateChanges.length === 0) {
    // Both empty → trivially agree.
    const liveAttRelevant = [...amByWa.values()].filter(
      (am) =>
        am.action === "IN" ||
        am.action === "OUT" ||
        am.action === "BENCH" ||
        am.intent === "replacement_request",
    ).length;
    if (liveAttRelevant === 0 && shadow.stateChanges.length === 0) return "agree";
    return "diff";
  }
  const shadowDrops = shadow.stateChanges.filter((c) => c.action === "drop").length;
  const shadowAdds = shadow.stateChanges.filter(
    (c: WindowStateChange) => c.action === "add" || c.action === "bench",
  ).length;
  const liveDrops = [...amByWa.values()].filter(
    (am) => am.action === "OUT" || am.intent === "replacement_request",
  ).length;
  const liveAdds = [...amByWa.values()].filter(
    (am) => am.action === "IN" || am.action === "BENCH",
  ).length;
  if (shadowDrops === liveDrops && shadowAdds === liveAdds) return "agree";
  return "diff";
}
