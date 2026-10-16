import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isSuperadmin } from "@/lib/org";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { formatLondon } from "@/lib/london-time";
import { APPROVED_CLUB_WHERE } from "@/lib/club-approval";
import { loadAllPartnerships } from "@/lib/club-partnership";
import { PartnerPairingForm } from "../partner-controls";

/**
 * /admin/clubs/partners: the platform owner pairs two clubs so one may ask
 * the other for a player (cross-club ask, slice S1, 2026-10-16; plan 3.1,
 * D1 and D2). One direction per pairing. Each club's owner then accepts on
 * its own settings page; nothing is asked until both have.
 *
 * Its own page, not a section of /admin/clubs: that page lists only clubs
 * that came in through self-join, and no button there can reach a club
 * that predates it. Pairing needs every approved, live club, Sutton FC
 * included, so it lives here. Pairing changes nothing for a club until
 * both owners accept.
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
  const [partnerships, clubs] = await Promise.all([
    loadAllPartnerships().catch((err: unknown) => {
      console.error(`[partner-clubs] /admin/clubs/partners read failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`);
      return [];
    }),
    db.organisation.findMany({
      where: { ...APPROVED_CLUB_WHERE, dormantAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return (
    <div className="space-y-6" data-testid="partner-clubs-page">
      <div>
        <Link href="/admin/clubs" className="text-sm text-slate-500">
          Clubs
        </Link>
        <h2 className="mt-1 text-lg font-semibold text-slate-800">Partner clubs</h2>
        <p className="text-sm text-slate-500 mt-1">
          Let one club ask another for a player when it is short. One direction per pairing: pair both ways for both. Each
          club&apos;s owner then accepts on its settings page; nothing is asked until both have.
        </p>
      </div>
      <PartnerPairingForm clubs={clubs} />
      {partnerships.length === 0 ? (
        <p className="text-sm text-slate-500">No clubs are paired.</p>
      ) : (
        <ul className="space-y-1 text-sm text-slate-700">
          {partnerships.map((p) => (
            <li key={p.id} data-testid="partnership" data-status={p.status}>
              {p.askerOrg.name} may ask {p.partnerOrg.name}{" "}
              <span className="text-slate-500">
                {p.status}
                {p.status === "proposed"
                  ? `, accepted by ${[p.askerAcceptedAt ? p.askerOrg.name : null, p.partnerAcceptedAt ? p.partnerOrg.name : null].filter(Boolean).join(" and ") || "neither yet"}`
                  : ""}
                {p.partnerApproval === "standing" ? ", posts without asking" : ""}, since {when(p.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
