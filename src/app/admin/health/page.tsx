import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg, isSuperadmin } from "@/lib/org";
import { SectionInfo } from "@/components/info/section-info";
import { formatLondon } from "@/lib/london-time";
import { alertKindLabel, clubStatus, isActiveAlert, type ClubStatus } from "@/lib/ops-alerts";
import { notFound, redirect } from "next/navigation";
import { formatDistanceToNow } from "date-fns";

/**
 * /admin/health: the platform owner's view of routine ops alerts.
 *
 * Replaces the daily WhatsApp DMs and emails (2026-09-28): Kemal asked for
 * these to live "on the website where i can click and see whenever i
 * want", and to stop arriving on his phone and in his inbox. Nothing on
 * this page is ever sent anywhere; see `src/lib/ops-alerts.ts`.
 *
 * OWNER ONLY. The /admin layout lets any club admin in; this page then
 * answers 404 to anybody who is not `User.isSuperadmin`, so a club admin
 * cannot see other clubs' names or MatchTime's own plumbing, and cannot
 * even tell the page exists.
 */
export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;
const MAX_ROWS = 200;

const STATUS_COPY: Record<ClubStatus, { label: string; className: string }> = {
  ok: { label: "All good", className: "bg-emerald-100 text-emerald-800" },
  warning: { label: "Worth a look", className: "bg-amber-100 text-amber-800" },
  problem: { label: "Needs attention", className: "bg-red-100 text-red-800" },
};

/** The start of the recent-alerts window. Outside the component so the
 *  render stays pure; this page is dynamic and re-reads on every visit. */
function windowStart(): Date {
  return new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

function when(d: Date): string {
  return formatLondon(d, "EEE d MMM, HH:mm");
}

export default async function HealthPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isSuperadmin(session.user.id))) notFound();
  // The ⓘ copy follows the owner's own club, English when there is none.
  const lang = (await getUserOrg(session.user.id))?.org.language ?? null;

  const since = windowStart();
  const [clubs, alerts, openConditions] = await Promise.all([
    db.organisation.findMany({
      where: { whatsappBotEnabled: true, whatsappGroupId: { not: null } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.opsAlert.findMany({
      where: { OR: [{ lastSeenAt: { gte: since } }, { resolvedAt: null }] },
      orderBy: { lastSeenAt: "desc" },
      take: MAX_ROWS,
    }),
    // Every open condition, whatever its age, so the summary is never
    // missing one because the recent list was cut short.
    db.opsAlert.findMany({
      where: { resolvedAt: null, kind: { startsWith: "health:" } },
      select: { orgId: true, kind: true, severity: true, resolvedAt: true, title: true },
    }),
  ]);

  const orgIds = [
    ...new Set([
      ...clubs.map((c) => c.id),
      ...alerts.map((a) => a.orgId).filter((x): x is string => !!x),
    ]),
  ];
  const [orgs, beats] = await Promise.all([
    db.organisation.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }),
    db.botHealth.findMany({
      where: { orgId: { in: clubs.map((c) => c.id) } },
      select: { orgId: true, lastHeartbeatAt: true },
    }),
  ]);
  const nameOf = new Map(orgs.map((o) => [o.id, o.name]));
  const beatOf = new Map(beats.map((b) => [b.orgId, b.lastHeartbeatAt]));

  const summary = clubs.map((c) => {
    const open = openConditions.filter((a) => a.orgId === c.id);
    return {
      id: c.id,
      name: c.name,
      status: clubStatus(open),
      open: open.filter(isActiveAlert),
      heartbeat: beatOf.get(c.id) ?? null,
    };
  });

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-slate-800">Health</h2>
        <p className="text-sm text-slate-500 mt-1">
          What the WhatsApp bot and the message pipeline have flagged in the last {WINDOW_DAYS}{" "}
          days, across every club. Only you can see this page, and none of it is sent to your
          phone or inbox.
        </p>
      </div>

      <section aria-labelledby="current-status">
        <div className="flex items-center gap-1 mb-3">
          <h3 id="current-status" className="text-sm font-semibold text-slate-700">
            Current status
          </h3>
          <SectionInfo k="health_status" lang={lang} />
        </div>
        {summary.length === 0 ? (
          <p className="text-sm text-slate-500">No club has the WhatsApp bot switched on.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {summary.map((c) => (
              <li
                key={c.id}
                data-testid="club-status"
                className="rounded-lg border border-slate-200 bg-white p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-slate-800 truncate">{c.name}</span>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_COPY[c.status].className}`}
                  >
                    {STATUS_COPY[c.status].label}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {c.heartbeat
                    ? `Bot last reported ${formatDistanceToNow(c.heartbeat, { addSuffix: true })}.`
                    : "The bot has not reported yet."}
                </p>
                {c.open.length > 0 && (
                  <ul className="mt-2 space-y-1 text-sm text-slate-700">
                    {c.open.map((a) => (
                      <li key={a.kind}>
                        <span className="font-medium">{alertKindLabel(a.kind)}:</span> {a.title}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="recent-alerts">
        <div className="flex items-center gap-1 mb-3">
          <h3 id="recent-alerts" className="text-sm font-semibold text-slate-700">
            Recent alerts
          </h3>
          <SectionInfo k="health_alerts" lang={lang} />
        </div>
        {alerts.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing has been flagged in the last {WINDOW_DAYS} days.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Club</th>
                  <th className="px-3 py-2">What</th>
                  <th className="px-3 py-2">Message</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {alerts.map((a) => {
                  const active = isActiveAlert(a);
                  const oneOff = !a.kind.startsWith("health:");
                  return (
                    <tr key={a.id} data-testid="alert-row" className="align-top">
                      <td className="px-3 py-2 whitespace-nowrap text-slate-600">
                        {when(a.firstSeenAt)}
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {a.orgId ? (nameOf.get(a.orgId) ?? "A deleted club") : "All clubs"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span
                          className={
                            a.severity === "critical" ? "text-red-700 font-medium" : "text-slate-700"
                          }
                        >
                          {alertKindLabel(a.kind)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-700 min-w-[16rem]">
                        <details>
                          <summary className="cursor-pointer">{a.title}</summary>
                          <p className="mt-1 whitespace-pre-line text-slate-500">{a.detail}</p>
                        </details>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {oneOff ? (
                          <span className="text-slate-500">One-off</span>
                        ) : active ? (
                          <span className="font-medium text-red-700">
                            Still happening
                            <span className="block text-xs font-normal text-slate-500">
                              checked {when(a.lastSeenAt)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-emerald-700">
                            Cleared
                            <span className="block text-xs text-slate-500">
                              {a.resolvedAt ? when(a.resolvedAt) : ""}
                            </span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
