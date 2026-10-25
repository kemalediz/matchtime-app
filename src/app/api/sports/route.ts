import { auth } from "@/lib/auth";
import { getUserOrg } from "@/lib/org";
import { offeredClubSports } from "@/lib/club-sport-offer";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const membership = await getUserOrg(session.user.id);
  if (!membership) return NextResponse.json({ error: "No organisation" }, { status: 404 });

  // Feeds the admin activities picker: only the sports a new weekly game
  // may use (live, or already played by the club; club-sport-offer.ts).
  return NextResponse.json(await offeredClubSports(membership.orgId));
}
