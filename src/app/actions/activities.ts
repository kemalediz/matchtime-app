"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { activitySchema } from "@/lib/validations";
import { requireOrgAdmin } from "@/lib/org";
import { revalidatePath } from "next/cache";
import { londonWallClockToUtc, nextLondonKickoff } from "@/lib/london-time";
import { activityUpdateData, activityVenueReset } from "@/lib/activity-update";
import { dropOrphanPin } from "@/lib/venue-location";
import { scheduleVenuePickResolve, scheduleVenueResolve } from "@/lib/venue-location-schedule";
import { CLEARED_VENUE_LINK } from "@/lib/venue-location-rules";
import { parseVenuePick } from "@/lib/venue-suggest-rules";
import { assertSportOfferedForGame } from "@/lib/club-sport-offer";

/** What a form sends for a picked place. Anything else on it is dropped. */
type VenuePickInput = { placeId: string; sessionToken?: string | null };

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
  /** A place picked from the suggestions under the venue box: Google's
   *  place id and the suggestions' session token, nothing else. The
   *  server asks Google what the place is; see `parseVenuePick`. */
  venuePick?: VenuePickInput | null;
}) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  await requireOrgAdmin(session.user.id, formData.orgId);

  const { orgId, venuePick, ...rest } = formData;
  const pick = parseVenuePick(venuePick);
  const parsed = activitySchema.parse(rest);

  // The sport is this org's (stops cross-org writes) and offered: live
  // (`LIVE_SPORTS`), or one the club already plays.
  await assertSportOfferedForGame(orgId, parsed.sportId);

  const created = await db.activity.create({ data: { ...parsed, orgId }, select: { id: true } });
  // Venue location: looked up after the response, never part of the save.
  // A picked place is looked up by its id (and, if Google does not resolve
  // it, the text is looked up after all); free text is looked up as text.
  if (pick) await scheduleVenuePickResolve(created.id, session.user.id, pick);
  else await scheduleVenueResolve(created.id);

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
    /** A place picked from the suggestions for the `venue` sent with it.
     *  Ignored unless `venue` is sent in the same request. */
    venuePick?: VenuePickInput | null;
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

  if (data.sportId) await assertSportOfferedForGame(activity.orgId, data.sportId);

  // New venue words: the place linked to the old words is cleared in the
  // SAME write, so a stale location never stays attached to new text, and
  // the new words are looked up after the response. A change of case or
  // punctuation only is not a new venue. The venue-location columns are
  // written from here only: none is ever accepted from the request.
  //
  // A PICK (a place chosen from the suggestions for the venue sent with
  // it) always resets, even for the same words: the organiser chose this
  // exact place, so whatever was linked gives way to it. Only Google's
  // place id and the session token are kept from the request; the server
  // asks Google what the place is after the response.
  const pick = typeof data.venue === "string" ? parseVenuePick(formData?.venuePick) : null;
  const reset = pick ? CLEARED_VENUE_LINK : activityVenueReset(data, { venue: activity.venue });

  await db.activity.update({ where: { id: activityId }, data: reset ? { ...data, ...reset } : data });
  if (reset) {
    await dropOrphanPin(activity.venueId);
    if (pick) await scheduleVenuePickResolve(activityId, session.user.id, pick);
    else await scheduleVenueResolve(activityId);
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
