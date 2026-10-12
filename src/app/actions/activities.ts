"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { activitySchema } from "@/lib/validations";
import { requireOrgAdmin } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { londonWallClockToUtc, nextLondonKickoff } from "@/lib/london-time";
import { activityUpdateData, activityVenueReset } from "@/lib/activity-update";
import { dropOrphanPin } from "@/lib/venue-location";
import { scheduleVenueResolve } from "@/lib/venue-location-schedule";

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

  const created = await db.activity.create({ data: { ...parsed, orgId }, select: { id: true } });
  // Venue location: looked up after the response, never part of the save.
  await scheduleVenueResolve(created.id);

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
    /** The fee per player in pounds as typed ("6", "6.50"), "" or null for
     *  none. Left out, or undefined: the fee is not touched. */
    feePerPlayer?: string | number | null;
  }
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const activity = await db.activity.findUnique({ where: { id: activityId } });
  if (!activity) throw new Error("Activity not found");

  await requireOrgAdmin(session.user.id, activity.orgId);

  // Only named, checked fields are written, whatever the request carried
  // (src/lib/activity-update.ts). A field left out is left alone.
  const update = activityUpdateData(formData, { feeSplitTotal: activity.feeSplitTotal, venue: activity.venue });
  if (!update.ok) throw new Error(update.error);
  const data = update.data;

  if (data.sportId) {
    const sport = await db.sport.findFirst({
      where: { id: data.sportId, orgId: activity.orgId },
    });
    if (!sport) throw new Error("Sport not found in this organisation");
  }

  // New venue words: the place linked to the old words is cleared in the
  // SAME write, so a stale location never stays attached to new text, and
  // the new words are looked up after the response. A change of case or
  // punctuation only is not a new venue. The venue-location columns are
  // written from here only: none is ever accepted from the request.
  const reset = activityVenueReset(data, { venue: activity.venue });

  await db.activity.update({ where: { id: activityId }, data: reset ? { ...data, ...reset } : data });
  if (reset) {
    await dropOrphanPin(activity.venueId);
    await scheduleVenueResolve(activityId);
  }

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
