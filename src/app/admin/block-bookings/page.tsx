import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { getUserOrg, requireOrgAdmin } from "@/lib/org";
import Link from "next/link";
import { CalendarRange, Plus, ListChecks } from "lucide-react";
import { formatLondon } from "@/lib/london-time";
import { BlockActions } from "./block-actions";

/**
 * Block bookings — the club's real venue booking shape: N consecutive
 * weekly matches paid up-front. Lists each block with its matches and
 * statuses; create/new lives at /admin/block-bookings/new; bulk
 * cancel/restore by date range at /admin/matches/bulk.
 */
export default async function BlockBookingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");
  const orgId = membership.orgId;
  await requireOrgAdmin(session.user.id, orgId);

  const blocks = await db.blockBooking.findMany({
    where: { orgId },
    orderBy: { startDate: "desc" },
    include: {
      activity: { include: { sport: true } },
      matches: {
        orderBy: { date: "asc" },
        select: { id: true, date: true, status: true },
      },
    },
  });

  const now = new Date();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Block bookings</h2>
          <p className="text-sm text-slate-500 mt-1">
            A block creates every match of the venue booking up front. The bot
            still only ever posts about the next match that&apos;s on.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/matches/bulk"
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium"
          >
            <ListChecks className="w-4 h-4" />
            Bulk cancel / restore
          </Link>
          <Link
            href="/admin/block-bookings/new"
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
          >
            <Plus className="w-4 h-4" />
            New block booking
          </Link>
        </div>
      </div>

      {blocks.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
          <CalendarRange className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500">
            No block bookings yet. Create one to lay out a whole run of matches
            (e.g. 10 Tuesdays) in one go.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {blocks.map((b) => {
            const counts = {
              upcoming: b.matches.filter(
                (m) =>
                  m.status !== "COMPLETED" &&
                  m.status !== "CANCELLED" &&
                  m.date > now,
              ).length,
              completed: b.matches.filter((m) => m.status === "COMPLETED").length,
              cancelled: b.matches.filter((m) => m.status === "CANCELLED").length,
            };
            return (
              <div
                key={b.id}
                className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 sm:p-6 space-y-4"
              >
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800">
                      {b.activity.name}
                      <span className="text-slate-400 font-normal">
                        {" "}· {b.activity.venue}
                      </span>
                    </p>
                    <p className="text-sm text-slate-500 mt-1">
                      {b.startDate.toISOString().slice(0, 10)} →{" "}
                      {b.endDate.toISOString().slice(0, 10)} · kick-off {b.time} ·{" "}
                      {b.matches.length} matches
                      {b.costPerMatch != null && (
                        <> · £{b.costPerMatch.toFixed(2)}/match</>
                      )}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {counts.upcoming} upcoming · {counts.completed} played ·{" "}
                      {counts.cancelled} cancelled
                      {b.notes && <> · {b.notes}</>}
                    </p>
                  </div>
                  <BlockActions
                    blockId={b.id}
                    matches={b.matches.map((m) => ({
                      id: m.id,
                      dateIso: m.date.toISOString(),
                      status: m.status,
                    }))}
                  />
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {b.matches.map((m) => {
                    const style =
                      m.status === "CANCELLED"
                        ? "bg-red-50 text-red-500 border-red-200 line-through"
                        : m.status === "COMPLETED"
                          ? "bg-slate-100 text-slate-500 border-slate-200"
                          : "bg-green-50 text-green-700 border-green-200";
                    return (
                      <Link
                        key={m.id}
                        href={`/matches/${m.id}`}
                        title={`${formatLondon(m.date, "EEEE d MMMM yyyy, HH:mm")} — ${m.status}`}
                        className={`px-2 py-1 rounded-md border text-xs font-medium ${style}`}
                      >
                        {formatLondon(m.date, "d MMM")}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
