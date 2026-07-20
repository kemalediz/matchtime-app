import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { getUserOrg, requireOrgAdmin } from "@/lib/org";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { NewBlockForm } from "./new-block-form";

/**
 * Create a block booking. Server shell loads the org's activities
 * (INCLUDING inactive ones — a paused Activity with a block is the live
 * Sutton FC use case: the club is on summer break, the block IS the
 * schedule) and hands them to the client form, which previews the exact
 * resolved kickoff instants (the DST proof) before anything is created.
 */
export default async function NewBlockBookingPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await getUserOrg(session.user.id);
  if (!membership) redirect("/create-org");
  const orgId = membership.orgId;
  await requireOrgAdmin(session.user.id, orgId);

  const activities = await db.activity.findMany({
    where: { orgId },
    orderBy: { createdAt: "asc" },
    include: { sport: { select: { playersPerTeam: true, name: true } } },
  });

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
        <h2 className="text-lg font-semibold text-slate-800">New block booking</h2>
        <p className="text-sm text-slate-500 mt-1">
          All matches are created up front. Nothing is posted to the group —
          the bot keeps announcing only the next match that&apos;s on.
        </p>
      </div>

      <NewBlockForm
        activities={activities.map((a) => ({
          id: a.id,
          name: a.name,
          venue: a.venue,
          dayOfWeek: a.dayOfWeek,
          time: a.time,
          isActive: a.isActive,
          sportName: a.sport.name,
          playersPerTeam: a.sport.playersPerTeam,
        }))}
      />
    </div>
  );
}
