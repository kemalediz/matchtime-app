import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { getUserOrg, requireOrgAdmin } from "@/lib/org";
import Link from "next/link";
import { ArrowLeft, ListChecks } from "lucide-react";
import { londonDateTimeToUtc } from "@/lib/london-time";
import { selectCancellable, selectRestorable } from "@/lib/block-booking";
import { BulkConfirmForm } from "./bulk-confirm-form";

/**
 * Bulk cancel / restore future matches — the summer-holiday use case.
 * Pick a London date range and a mode; the page lists exactly the matches
 * the pure selectors (unit-tested) would touch; the client form requires
 * an explicit confirm. Cancelling is SILENT unless the admin ticks the
 * announce option; restoring is always silent.
 */
export default async function BulkMatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; mode?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");
  const orgId = membership.orgId;
  await requireOrgAdmin(session.user.id, orgId);

  const params = await searchParams;
  const mode = params.mode === "restore" ? "restore" : "cancel";
  const from = params.from ?? "";
  const to = params.to ?? "";

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const haveRange = DATE_RE.test(from) && DATE_RE.test(to) && from <= to;

  let candidates: Array<{
    id: string;
    date: Date;
    status: string;
    activityName: string;
    venue: string;
    confirmedCount: number;
  }> = [];

  if (haveRange) {
    // London calendar range → UTC instants, inclusive of the whole `to` day.
    const rangeStart = londonDateTimeToUtc(from, "00:00");
    const rangeEnd = new Date(
      londonDateTimeToUtc(to, "23:59").getTime() + 59_000,
    );
    const rows = await db.match.findMany({
      where: {
        activity: { orgId },
        date: { gte: rangeStart, lte: rangeEnd },
        isHistorical: false,
      },
      orderBy: { date: "asc" },
      include: {
        activity: { select: { name: true, venue: true } },
        attendances: { where: { status: "CONFIRMED" }, select: { id: true } },
      },
    });
    const range = { from: rangeStart, to: rangeEnd };
    const selected =
      mode === "cancel"
        ? selectCancellable(rows, range)
        : selectRestorable(rows, range);
    candidates = selected.map((m) => ({
      id: m.id,
      date: m.date,
      status: m.status,
      activityName: m.activity.name,
      venue: m.activity.venue,
      confirmedCount: m.attendances.length,
    }));
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/block-bookings"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </Link>
        <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
          <ListChecks className="w-5 h-5 text-blue-500" />
          Bulk cancel / restore matches
        </h2>
        <p className="text-sm text-slate-500 mt-1">
          For holidays and mistakes: pick a date range, review the exact list,
          confirm. Cancelling sends <b>no group message</b> unless you
          explicitly tick the announce option.
        </p>
      </div>

      <form
        method="GET"
        className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 flex items-end gap-3 flex-wrap"
      >
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            From
          </label>
          <input
            type="date"
            name="from"
            defaultValue={from}
            required
            className="h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            To (inclusive)
          </label>
          <input
            type="date"
            name="to"
            defaultValue={to}
            required
            className="h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Action
          </label>
          <select
            name="mode"
            defaultValue={mode}
            className="h-11 px-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="cancel">Cancel matches</option>
            <option value="restore">Restore cancelled matches</option>
          </select>
        </div>
        <button
          type="submit"
          className="h-11 px-5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
        >
          Find matches
        </button>
      </form>

      {haveRange && (
        <BulkConfirmForm
          mode={mode}
          matches={candidates.map((c) => ({
            id: c.id,
            dateIso: c.date.toISOString(),
            status: c.status,
            activityName: c.activityName,
            venue: c.venue,
            confirmedCount: c.confirmedCount,
          }))}
        />
      )}
    </div>
  );
}
