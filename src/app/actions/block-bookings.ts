"use server";

/**
 * Block bookings + bulk cancel/restore — server actions (2026-07-20).
 *
 * The pure logic (occurrence generation, slot dedupe, bulk selection,
 * deletion partition) lives in src/lib/block-booking.ts and is unit-tested;
 * these actions only load rows, authorise, and persist.
 *
 * GROUP-MESSAGE GUARANTEE: creating a block queues NO BotJob and no other
 * group side-effect. Bulk cancel queues NO BotJob unless the admin
 * explicitly ticked "announce" — and then exactly ONE summary message
 * (buildBulkCancelAnnouncement is the only path that can produce it).
 * Bulk restore and block deletion are always silent. The bot's normal
 * scheduler will still announce the NEXT upcoming match through its
 * existing `isNextUpcomingForPosting` gate — that is the desired
 * behaviour, not a side-effect of these actions.
 */

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireOrgAdmin } from "@/lib/org";
import { revalidatePath } from "next/cache";
import {
  generateBlockOccurrences,
  planBlockGeneration,
  selectCancellable,
  selectRestorable,
  buildBulkCancelAnnouncement,
  partitionBlockMatchesForDeletion,
  type BlockOccurrence,
} from "@/lib/block-booking";
import { isSameSlot } from "@/lib/match-slot";
import { formatLondon } from "@/lib/london-time";

// Wide-open range used when the caller has already picked explicit match
// ids — selection is then by id, and the pure selectors only enforce
// status/historical rules.
const ALL_TIME = { from: new Date(0), to: new Date(8640000000000000) };

export interface BlockBookingInput {
  activityId: string;
  /** "YYYY-MM-DD" London calendar date. */
  startDate: string;
  /** Inclusive "YYYY-MM-DD". Exactly one of endDate / count. */
  endDate?: string;
  count?: number;
  /** London wall-clock "HH:mm". Defaults to the activity's configured time. */
  time?: string;
  costPerMatch?: number;
  notes?: string;
}

export interface BlockPreviewRow {
  /** London calendar date "YYYY-MM-DD". */
  date: string;
  /** Resolved UTC kickoff instant (ISO). The DST proof: compare across rows. */
  kickoffUtcIso: string;
  /** Human London rendering, e.g. "Tue 27 Oct 2026, 21:30". */
  kickoffLondon: string;
  attendanceDeadlineIso: string;
  /** True when a match already occupies this slot (cron-created or a
   *  previous block run) — creation will skip it, not duplicate it. */
  alreadyExists: boolean;
}

/**
 * Shared compute for preview + create: authorise, resolve the activity,
 * generate DST-correct occurrences, and dedupe against existing matches
 * in the window on the recurring slot.
 */
async function computeBlockPlan(input: BlockBookingInput) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  // Deliberately NO isActive check: the live use case (Sutton FC summer
  // break) has the Activity paused — the block IS the schedule. The
  // scheduler and match pages don't filter on activity.isActive.
  const activity = await db.activity.findUnique({
    where: { id: input.activityId },
    include: { sport: true },
  });
  if (!activity) throw new Error("Activity not found");
  await requireOrgAdmin(session.user.id, activity.orgId);

  const time = input.time?.trim() || activity.time;
  const occurrences = generateBlockOccurrences({
    startDate: input.startDate,
    endDate: input.endDate,
    count: input.count,
    dayOfWeek: activity.dayOfWeek,
    time,
    deadlineHours: activity.deadlineHours,
  });
  if (occurrences.length === 0) {
    throw new Error("No matches fall inside that date range");
  }

  // Existing matches anywhere near the block's span, org-wide (same query
  // shape as the weekly cron's dedupe, widened to the whole block).
  const windowStart = new Date(
    occurrences[0].kickoffUtc.getTime() - 12 * 60 * 60 * 1000,
  );
  const windowEnd = new Date(
    occurrences[occurrences.length - 1].kickoffUtc.getTime() +
      12 * 60 * 60 * 1000,
  );
  const existing = await db.match.findMany({
    where: {
      date: { gte: windowStart, lte: windowEnd },
      activity: { orgId: activity.orgId },
    },
    select: {
      id: true,
      date: true,
      blockBookingId: true,
      activity: { select: { orgId: true, venue: true, dayOfWeek: true } },
    },
  });

  const fixture = {
    orgId: activity.orgId,
    venue: activity.venue,
    dayOfWeek: activity.dayOfWeek,
  };
  const plan = planBlockGeneration(occurrences, fixture, existing);

  return { session, activity, time, occurrences, existing, fixture, plan };
}

function toPreviewRow(occ: BlockOccurrence, alreadyExists: boolean): BlockPreviewRow {
  return {
    date: occ.date,
    kickoffUtcIso: occ.kickoffUtc.toISOString(),
    kickoffLondon: formatLondon(occ.kickoffUtc, "EEE d MMM yyyy, HH:mm"),
    attendanceDeadlineIso: occ.attendanceDeadline.toISOString(),
    alreadyExists,
  };
}

/**
 * Dry-run: the exact dates + RESOLVED kickoff instants the block would
 * create, so an admin can eyeball the DST boundary before confirming.
 * No writes.
 */
export async function previewBlockBooking(input: BlockBookingInput): Promise<{
  activityName: string;
  venue: string;
  time: string;
  maxPlayers: number;
  rows: BlockPreviewRow[];
}> {
  const { activity, time, occurrences, plan } = await computeBlockPlan(input);
  const dupDates = new Set(plan.duplicates.map((o) => o.date));
  return {
    activityName: activity.name,
    venue: activity.venue,
    time,
    maxPlayers: activity.sport.playersPerTeam * 2,
    rows: occurrences.map((o) => toPreviewRow(o, dupDates.has(o.date))),
  };
}

/**
 * Create the BlockBooking row + all its Match rows up-front. Idempotent on
 * the recurring slot: occurrences already covered by an existing match are
 * NOT duplicated — instead, existing block-less matches in those slots are
 * ADOPTED into the block so the set is complete. Queues NO group post.
 */
export async function createBlockBooking(input: BlockBookingInput): Promise<{
  blockBookingId: string;
  created: number;
  adopted: number;
}> {
  const { activity, time, occurrences, existing, fixture, plan } =
    await computeBlockPlan(input);

  if (
    input.costPerMatch !== undefined &&
    (!Number.isFinite(input.costPerMatch) || input.costPerMatch < 0)
  ) {
    throw new Error("costPerMatch must be a non-negative number");
  }

  // Existing block-less matches sitting in duplicate slots get adopted so
  // the block lists/manages the full run (e.g. the one match the weekly
  // cron already made).
  const adoptIds = plan.duplicates.flatMap((occ) =>
    existing
      .filter(
        (m) =>
          m.blockBookingId === null &&
          isSameSlot(
            { ...fixture, instant: occ.kickoffUtc },
            {
              orgId: m.activity.orgId,
              venue: m.activity.venue,
              dayOfWeek: m.activity.dayOfWeek,
              instant: m.date,
            },
          ),
      )
      .map((m) => m.id),
  );

  const maxPlayers = activity.sport.playersPerTeam * 2;
  const first = occurrences[0];
  const last = occurrences[occurrences.length - 1];

  const block = await db.$transaction(async (tx) => {
    const created = await tx.blockBooking.create({
      data: {
        orgId: activity.orgId,
        activityId: activity.id,
        // "YYYY-MM-DD" parses as UTC midnight — correct for a DATE column.
        startDate: new Date(first.date),
        endDate: new Date(last.date),
        time,
        costPerMatch: input.costPerMatch ?? null,
        notes: input.notes?.trim() || null,
      },
    });
    if (plan.toCreate.length > 0) {
      await tx.match.createMany({
        data: plan.toCreate.map((occ) => ({
          activityId: activity.id,
          date: occ.kickoffUtc,
          maxPlayers,
          attendanceDeadline: occ.attendanceDeadline,
          blockBookingId: created.id,
        })),
      });
    }
    if (adoptIds.length > 0) {
      await tx.match.updateMany({
        where: { id: { in: adoptIds }, blockBookingId: null },
        data: { blockBookingId: created.id },
      });
    }
    return created;
  });

  revalidatePath("/admin/block-bookings");
  revalidatePath("/matches");
  return {
    blockBookingId: block.id,
    created: plan.toCreate.length,
    adopted: adoptIds.length,
  };
}

/**
 * Bulk-cancel matches by explicit ids (the holiday case). SILENT BY
 * DEFAULT: no BotJob, no group message, nothing — unless `announce` is
 * explicitly true, in which case exactly ONE summary message is queued
 * for the whole batch. COMPLETED / historical / already-cancelled matches
 * are skipped, never touched.
 */
export async function bulkCancelMatches(input: {
  matchIds: string[];
  announce?: boolean;
}): Promise<{ cancelled: number; skipped: number; announced: boolean }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const ids = [...new Set(input.matchIds)];
  if (ids.length === 0) throw new Error("No matches selected");

  const matches = await db.match.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      date: true,
      status: true,
      isHistorical: true,
      activity: { select: { orgId: true, name: true } },
    },
  });
  if (matches.length === 0) throw new Error("Matches not found");

  const orgIds = [...new Set(matches.map((m) => m.activity.orgId))];
  if (orgIds.length !== 1) {
    throw new Error("Matches span multiple organisations");
  }
  await requireOrgAdmin(session.user.id, orgIds[0]);

  const cancellable = selectCancellable(matches, ALL_TIME);
  if (cancellable.length > 0) {
    await db.match.updateMany({
      where: { id: { in: cancellable.map((m) => m.id) } },
      data: { status: "CANCELLED" },
    });
  }

  // The ONLY group-message path — pure, unit-tested, null unless the
  // admin explicitly opted in AND something was cancelled.
  const announcement = buildBulkCancelAnnouncement({
    activityName: cancellable[0]?.activity.name ?? "",
    dates: cancellable.map((m) => m.date),
    announce: input.announce === true,
  });
  if (announcement !== null) {
    await db.botJob.create({
      data: { orgId: orgIds[0], kind: "group", text: announcement },
    });
  }

  revalidatePath("/admin/block-bookings");
  revalidatePath("/matches");
  return {
    cancelled: cancellable.length,
    skipped: matches.length - cancellable.length,
    announced: announcement !== null,
  };
}

/**
 * Bulk-restore (un-cancel) matches by explicit ids. Always silent.
 * Only future CANCELLED matches flip back to UPCOMING — restoring a
 * past match would confuse the scheduler's post-match flows.
 */
export async function bulkRestoreMatches(input: {
  matchIds: string[];
}): Promise<{ restored: number; skipped: number }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const ids = [...new Set(input.matchIds)];
  if (ids.length === 0) throw new Error("No matches selected");

  const matches = await db.match.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      date: true,
      status: true,
      isHistorical: true,
      activity: { select: { orgId: true } },
    },
  });
  if (matches.length === 0) throw new Error("Matches not found");

  const orgIds = [...new Set(matches.map((m) => m.activity.orgId))];
  if (orgIds.length !== 1) {
    throw new Error("Matches span multiple organisations");
  }
  await requireOrgAdmin(session.user.id, orgIds[0]);

  const restorable = selectRestorable(matches, {
    from: new Date(),
    to: ALL_TIME.to,
  });
  if (restorable.length > 0) {
    await db.match.updateMany({
      where: { id: { in: restorable.map((m) => m.id) } },
      data: { status: "UPCOMING" },
    });
  }

  revalidatePath("/admin/block-bookings");
  revalidatePath("/matches");
  return {
    restored: restorable.length,
    skipped: matches.length - restorable.length,
  };
}

/**
 * Delete a block. NEVER destroys history: matches that were played or
 * carry any attendances/ratings/MoM votes/team assignments are DETACHED
 * (blockBookingId → null) and survive; only empty unplayed shells are
 * deleted with the block. Always silent.
 */
export async function deleteBlockBooking(blockBookingId: string): Promise<{
  deletedMatches: number;
  detachedMatches: number;
}> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const block = await db.blockBooking.findUnique({
    where: { id: blockBookingId },
    include: {
      matches: {
        select: {
          id: true,
          status: true,
          isHistorical: true,
          _count: {
            select: {
              attendances: true,
              ratings: true,
              momVotes: true,
              teamAssignments: true,
            },
          },
        },
      },
    },
  });
  if (!block) throw new Error("Block booking not found");
  await requireOrgAdmin(session.user.id, block.orgId);

  const { deleteIds, detachIds } = partitionBlockMatchesForDeletion(
    block.matches.map((m) => ({
      id: m.id,
      status: m.status,
      isHistorical: m.isHistorical,
      attendanceCount: m._count.attendances,
      ratingCount: m._count.ratings,
      momVoteCount: m._count.momVotes,
      teamAssignmentCount: m._count.teamAssignments,
    })),
  );

  await db.$transaction(async (tx) => {
    if (detachIds.length > 0) {
      await tx.match.updateMany({
        where: { id: { in: detachIds } },
        data: { blockBookingId: null },
      });
    }
    if (deleteIds.length > 0) {
      await tx.match.deleteMany({ where: { id: { in: deleteIds } } });
    }
    await tx.blockBooking.delete({ where: { id: blockBookingId } });
  });

  revalidatePath("/admin/block-bookings");
  revalidatePath("/matches");
  return { deletedMatches: deleteIds.length, detachedMatches: detachIds.length };
}
