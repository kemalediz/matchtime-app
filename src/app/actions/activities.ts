"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { activitySchema } from "@/lib/validations";
import { requireOrgAdmin } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { londonWallClockToUtc, nextLondonKickoff } from "@/lib/london-time";

export async function createActivity(formData: {
  orgId: string;
  sportId: string;
  name: string;
  dayOfWeek: number;
  time: string;
  venue: string;
  deadlineHours?: number;
  matchDurationMins?: number;
  ratingWindowHours?: number;
}) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  await requireOrgAdmin(session.user.id, formData.orgId);

  const { orgId, ...rest } = formData;
  const parsed = activitySchema.parse(rest);

  // Verify the sport belongs to this org (stops cross-org writes).
  const sport = await db.sport.findFirst({
    where: { id: parsed.sportId, orgId },
  });
  if (!sport) throw new Error("Sport not found in this organisation");

  await db.activity.create({ data: { ...parsed, orgId } });

  revalidatePath("/admin/activities");
}

export async function updateActivity(
  activityId: string,
  formData: {
    name?: string;
    sportId?: string;
    dayOfWeek?: number;
    time?: string;
    venue?: string;
    deadlineHours?: number;
    ratingWindowHours?: number;
    matchDurationMins?: number;
    isActive?: boolean;
  }
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const activity = await db.activity.findUnique({ where: { id: activityId } });
  if (!activity) throw new Error("Activity not found");

  await requireOrgAdmin(session.user.id, activity.orgId);

  if (formData.sportId) {
    const sport = await db.sport.findFirst({
      where: { id: formData.sportId, orgId: activity.orgId },
    });
    if (!sport) throw new Error("Sport not found in this organisation");
  }

  await db.activity.update({ where: { id: activityId }, data: formData });

  revalidatePath("/admin/activities");
}

export async function deleteActivity(activityId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const activity = await db.activity.findUnique({ where: { id: activityId } });
  if (!activity) throw new Error("Activity not found");

  await requireOrgAdmin(session.user.id, activity.orgId);

  await db.activity.update({
    where: { id: activityId },
    data: { isActive: false },
  });

  revalidatePath("/admin/activities");
}

export async function generateMatchesForActivity(activityId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const activity = await db.activity.findUnique({
    where: { id: activityId },
    include: { sport: true },
  });
  if (!activity) throw new Error("Activity not found");

  await requireOrgAdmin(session.user.id, activity.orgId);

  // `activity.time` is a London wall clock. The same helper as the
  // nightly cron: `setHours()` on the server clock (UTC on Vercel) put
  // every British Summer Time match an hour late.
  const matchDate = nextLondonKickoff(new Date(), activity.dayOfWeek, activity.time);

  // One match per activity per London day.
  const startOfDay = londonWallClockToUtc(matchDate, "00:00");
  const endOfDay = londonWallClockToUtc(new Date(matchDate.getTime() + 24 * 60 * 60 * 1000), "00:00");

  const existing = await db.match.findFirst({
    where: { activityId, date: { gte: startOfDay, lt: endOfDay } },
  });
  if (existing) throw new Error("Match already exists for this date");

  const deadline = new Date(matchDate.getTime() - activity.deadlineHours * 60 * 60 * 1000);

  await db.match.create({
    data: {
      activityId,
      date: matchDate,
      maxPlayers: activity.sport.playersPerTeam * 2,
      attendanceDeadline: deadline,
    },
  });

  revalidatePath("/matches");
  revalidatePath("/admin/activities");
  revalidatePath("/");
}
