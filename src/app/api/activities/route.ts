import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { seesAdminFields } from "@/lib/admin-view";
import { venueLocationView } from "@/lib/venue-location-rules";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const membership = await getUserOrg(session.user.id);
  if (!membership) return NextResponse.json({ error: "No organisation" }, { status: 404 });

  // The caller's OWN club only: `orgId` comes from their membership.
  const activities = await db.activity.findMany({
    where: { orgId: membership.orgId },
    orderBy: { dayOfWeek: "asc" },
    include: {
      sport: {
        select: {
          id: true,
          name: true,
          positions: true,
          teamLabels: true,
          mvpLabel: true,
          playersPerTeam: true,
          balancingStrategy: true,
        },
      },
      venueRef: { select: { placeId: true, formattedAddress: true, lat: true, lng: true } },
    },
  });

  // Venue location (2026-10-12) goes to the club's OWNER and ADMINs (and
  // the platform superadmin) only: the confirm line is theirs. A plain
  // member gets the activity exactly as before, with no location and
  // none of the bookkeeping columns.
  const isAdmin = await seesAdminFields(session.user.id, membership.role);
  const now = new Date();

  return NextResponse.json(
    activities.map((a) => {
      const {
        venueRef,
        venueId,
        venueConfidence,
        venueMatchSource,
        venueLookupStatus,
        venueResolvedAt,
        venueConfirmedAt,
        venueConfirmedById,
        ...rest
      } = a;
      void venueMatchSource;
      void venueConfirmedById;
      if (!isAdmin) return rest;
      return {
        ...rest,
        venueLocation: venueLocationView(
          { venue: a.venue, venueId, venueConfidence, venueLookupStatus, venueResolvedAt, venueConfirmedAt, venueRef },
          now,
        ),
      };
    }),
  );
}
