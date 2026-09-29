import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getUserOrg } from "@/lib/org";
import { loadClubDisplayRatings } from "@/lib/player-stats";
import { seesAdminFields } from "@/lib/admin-view";
import { findDuplicateSuggestions } from "@/lib/placeholder-link-rules";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const membership = await getUserOrg(session.user.id);
  if (!membership) return NextResponse.json({ error: "No organisation" }, { status: 404 });

  // Phone numbers, emails, seeds, club ratings and aliases are for the
  // club's OWNER/ADMIN (and the platform superadmin) only. A plain member
  // who calls this directly gets names, ids and positions, current
  // members only (PR #148 review: it used to hand every member the whole
  // roster's phone numbers).
  const isAdmin = await seesAdminFields(session.user.id, membership.role);

  const { searchParams } = new URL(request.url);
  const activityIdParam = searchParams.get("activityId");
  const includeFormer = isAdmin && searchParams.get("includeFormer") === "1";

  // If admin passed a specific activityId, scope positions to THAT activity.
  // Otherwise fall back to the org's primary active activity.
  let targetActivityId: string | null = activityIdParam;
  if (!targetActivityId) {
    const primaryActivity = await db.activity.findFirst({
      where: { orgId: membership.orgId, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    targetActivityId = primaryActivity?.id ?? null;
  } else {
    // Validate the requested activity belongs to the user's org (prevents
    // cross-org sniffing).
    const activity = await db.activity.findFirst({
      where: { id: targetActivityId, orgId: membership.orgId },
      select: { id: true },
    });
    if (!activity) targetActivityId = null;
  }

  const memberships = await db.membership.findMany({
    where: {
      orgId: membership.orgId,
      ...(includeFormer ? {} : { leftAt: null }),
    },
    include: {
      user: {
        include: {
          _count: {
            select: {
              attendances: { where: { status: "CONFIRMED" } },
              // Every club's, for the duplicate suggestions below: a
              // placeholder that also belongs to another club is never
              // offered for a merge.
              memberships: true,
            },
          },
          activityPositions: targetActivityId
            ? { where: { activityId: targetActivityId } }
            : false,
        },
      },
    },
    orderBy: { user: { name: "asc" } },
  });

  // A plain member stops here: names, ids and positions only.
  if (!isAdmin) {
    return NextResponse.json({
      players: memberships.map((m) => ({
        id: m.user.id,
        name: m.user.name,
        image: m.user.image,
        role: m.role,
        positions: m.user.activityPositions?.[0]?.positions ?? [],
        isActive: m.user.isActive,
        leftAt: m.leftAt ? m.leftAt.toISOString() : null,
      })),
      activityId: targetActivityId,
    });
  }

  // Aliases — per-org UserAlias rows for these users. Surfaced on the
  // admin player list so admins can see (and edit) the nickname/short
  // pushname mappings the analyzer uses to resolve ambiguous senders.
  // Populated automatically by mergePlayers but until now was invisible
  // (Kemal flagged 2026-05-15 — couldn't see "ba" → Baki or "Nunu" →
  // Elnur). One findMany + in-memory group-by, cheap.
  const aliasRows = await db.userAlias.findMany({
    where: {
      orgId: membership.orgId,
      userId: { in: memberships.map((m) => m.user.id) },
    },
    select: { userId: true, alias: true, source: true },
    orderBy: { createdAt: "asc" },
  });
  const aliasesByUser = new Map<string, Array<{ alias: string; source: string }>>();
  for (const a of aliasRows) {
    const arr = aliasesByUser.get(a.userId) ?? [];
    arr.push({ alias: a.alias, source: a.source });
    aliasesByUser.set(a.userId, arr);
  }

  // THIS club's rating of each member, the same number the player sees
  // on their own page (raw mean of this club's ratings, null until a
  // team-mate has rated them). Owners and admins only: it is the admin
  // roster's column, and a plain member has no business reading a
  // team-mate's number here. Filtered by this club inside the loader.
  const clubRatings = await loadClubDisplayRatings(
    membership.orgId,
    memberships.map((m) => m.user.id),
  );

  const players = memberships.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    email: m.user.email,
    image: m.user.image,
    phoneNumber: m.user.phoneNumber,
    role: m.role,
    positions: m.user.activityPositions?.[0]?.positions ?? [],
    // THIS club's seed, off the membership we are already iterating.
    // It used to be `m.user.seedRating`, the global column, so the admin
    // seed editor this endpoint feeds could show a number another club
    // had typed (MDs/club-scoped-ratings-design-2026-09-18.md, 8.3).
    // Null means this club has no opinion of them yet, which is the
    // correct state for a new member and must not borrow one.
    seedRating: m.seedRating,
    clubRating: clubRatings[m.user.id] ?? { rating: null, ratedGames: 0 },
    isActive: m.user.isActive,
    leftAt: m.leftAt ? m.leftAt.toISOString() : null,
    provisionallyAddedAt: m.provisionallyAddedAt ? m.provisionallyAddedAt.toISOString() : null,
    aliases: aliasesByUser.get(m.user.id) ?? [],
    _count: { attendances: m.user._count.attendances },
  }));

  // Possible duplicates (2026-09-29): a phoneless placeholder made by a
  // third party's "X in" next to a member with a phone and a matching
  // name. group-join merges the unambiguous case by itself; everything
  // else is offered here for a one-tap merge. Rules:
  // src/lib/placeholder-link-rules.ts.
  const duplicateSuggestions = findDuplicateSuggestions(
    memberships.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      phoneNumber: m.user.phoneNumber,
      email: m.user.email,
      provisionallyAddedAt: m.provisionallyAddedAt,
      leftAt: m.leftAt,
      createdAt: m.user.createdAt,
      clubCount: m.user._count.memberships,
      aliases: (aliasesByUser.get(m.user.id) ?? []).map((a) => a.alias),
    })),
  );

  // Participant-sweep freshness (2026-08-31; re-based 2026-09-09). When
  // the sweep stops, the app's self-IN gate quietly starts turning real
  // players away. Surface its age here so the admin player list can say
  // so out loud.
  //
  // This reads the SWEEP's own clock, `Organisation.lastParticipantSweepAt`.
  // It used to read `MAX(Membership.lastSeenInGroupAt)`, which was the same
  // fact while the sweep was that column's only writer. It no longer is:
  // since 2026-09-09 an inbound group message refreshes the sender's
  // sighting (src/lib/group-sighting.ts), so that MAX would be refreshed by
  // any one chatty player and this banner would disappear while the sweep
  // was still dead — the exact opposite of what it is for.
  const org = await db.organisation.findUnique({
    where: { id: membership.orgId },
    select: { lastParticipantSweepAt: true },
  });
  const lastSyncAt = org?.lastParticipantSweepAt ?? null;

  return NextResponse.json({
    players,
    activityId: targetActivityId,
    groupSync: { lastSyncAt: lastSyncAt ? lastSyncAt.toISOString() : null },
    duplicateSuggestions,
  });
}
