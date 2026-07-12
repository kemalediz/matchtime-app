"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { registerAttendance, cancelAttendance } from "@/lib/attendance";
import { canSelfMarkIn } from "@/lib/group-membership-gate";
import { revalidatePath } from "next/cache";

export async function attendMatch(matchId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  // Loophole gate (app self-IN only): only a real member of the org's
  // WhatsApp group may mark THEMSELVES in from the web app. The bot
  // path, in-group guest-adds, and admin add-player all call
  // registerAttendance directly and stay ungated — this check lives
  // here in the server action, not in registerAttendance.
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: { select: { orgId: true, org: { select: { name: true } } } } },
  });
  if (!match) throw new Error("Match not found");

  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId: session.user.id, orgId: match.activity.orgId } },
    select: { leftAt: true, lastSeenInGroupAt: true, role: true },
  });

  if (!canSelfMarkIn(membership)) {
    const club = match.activity.org.name;
    throw new Error(
      `You need to be in the ${club} WhatsApp group to mark yourself in. Ask a member to add you in the group.`,
    );
  }

  await registerAttendance(session.user.id, matchId);

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
  revalidatePath("/");
}

export async function dropFromMatch(matchId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  await cancelAttendance(session.user.id, matchId);

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
  revalidatePath("/");
}
