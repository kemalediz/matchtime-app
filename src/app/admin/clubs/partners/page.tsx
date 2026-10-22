import { auth } from "@/lib/auth";
import { isSuperadmin } from "@/lib/org";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { formatLondon } from "@/lib/london-time";
import { loadAllPartnerships } from "@/lib/club-partnership";
import { PLATFORM_PAUSE } from "@/lib/club-partnership-rules";
import { PartnerOverrideButtons } from "../partner-controls";

/**
 * /admin/clubs/partners: every pairing on the platform, for the platform
 * owner (cross-club ask, slice S1, 2026-10-16).
 *
 * PARTNER DISCOVERY, slice P5 (2026-10-22; plan
 * MDs/partner-discovery-plan-2026-10-21.md, section 3.5, D-6): the create
 * form is gone. Clubs find each other and send requests themselves, and a
 * club's request is its consent; pairing two clubs here would skip that.
 * What stays is the list, with pause, resume (of the platform's own
 * pause) and end as an override for abuse or support.
 *
 * Its own page, not a section of /admin/clubs: that page lists only clubs
 * that came in through self-join.
 *
 * OWNER ONLY. 404 to anybody who is not `User.isSuperadmin`, like
 * /admin/clubs: it names every club.
 */
export const dynamic = "force-dynamic";

const when = (d: Date) => formatLondon(d, "EEE d MMM, HH:mm");

export default async function PartnerClubsOwnerPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isSuperadmin(session.user.id))) notFound();

  // Empty, not an error, before the 20261016180000 migration.
  const partnerships = await loadAllPartnerships().catch((err: unknown) => {
    console.error(`[partner-clubs] /admin/clubs/partners read failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`);
    return [];
  });

  return (
    <div className="space-y-6" data-testid="partner-clubs-page">
      <div>
        <Link href="/admin/clubs" className="text-sm text-slate-500">
          Clubs
        </Link>
        <h2 className="mt-1 text-lg font-semibold text-slate-800">Partner clubs</h2>
        <p className="text-sm text-slate-500 mt-1">
          Every pairing between two clubs, one direction each. Clubs pair themselves: one sends a request and the other
          accepts. You can pause or end any pairing here; a pairing you paused can only be resumed here.
        </p>
      </div>
      {partnerships.length === 0 ? (
        <p className="text-sm text-slate-500">No clubs are paired.</p>
      ) : (
        <ul className="space-y-2 text-sm text-slate-700">
          {partnerships.map((p) => {
            const label = `${p.askerOrg.name} may ask ${p.partnerOrg.name}`;
            const pausedByPlatform = p.status === "paused" && p.pausedByOrgId === PLATFORM_PAUSE;
            return (
              <li key={p.id} data-testid="partnership" data-status={p.status} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {label}{" "}
                  <span className="text-slate-500">
                    {p.status}
                    {pausedByPlatform ? " by MatchTime" : ""}
                    {p.status === "proposed"
                      ? `, accepted by ${[p.askerAcceptedAt ? p.askerOrg.name : null, p.partnerAcceptedAt ? p.partnerOrg.name : null].filter(Boolean).join(" and ") || "neither yet"}`
                      : ""}
                    {p.partnerApproval === "standing" ? ", posts without asking" : ""}, since {when(p.createdAt)}
                  </span>
                </span>
                <PartnerOverrideButtons id={p.id} status={p.status} pausedByPlatform={pausedByPlatform} label={label} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
