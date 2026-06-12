"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { ratingSchema, momVoteSchema } from "@/lib/validations";
import { revalidatePath } from "next/cache";

export async function submitRatings(matchId: string, formData: { ratings: { playerId: string; score: number }[] }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = ratingSchema.parse(formData);

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: true },
  });
  if (!match) throw new Error("Match not found");
  if (match.status !== "COMPLETED") throw new Error("Match not completed yet");

  // Check rating window
  const windowEnd = new Date(match.date.getTime() + match.activity.ratingWindowHours * 60 * 60 * 1000);
  if (new Date() > windowEnd) throw new Error("Rating window has closed");

  // Check voter attended
  const attendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId: session.user.id } },
  });
  if (!attendance || attendance.status === "DROPPED") {
    throw new Error("Only match participants can rate");
  }

  // The set of player ids it's valid to rate for THIS match = its
  // non-dropped attendees. A stale rate-page tab can carry a playerId
  // that's since been merged-away + the underlying User row deleted
  // (merge-players-core deletes the dropped User with no id→survivor
  // mapping). Rating that id would throw P2003 Rating_playerId_fkey and,
  // in the old row-by-row no-transaction loop, abort the whole submission
  // — saving rows before it, dropping rows after it and the MoM vote.
  // Build a valid-id allow-list up front and skip anything not in it.
  const validPlayerIds = new Set(
    (
      await db.attendance.findMany({
        where: { matchId, status: { not: "DROPPED" } },
        select: { userId: true },
      })
    ).map((a) => a.userId),
  );

  // Upsert all ratings. Never let one bad row abort the rest: we skip
  // ids that aren't valid participants, and we still wrap each write so
  // a residual FK/constraint error (P2003 / P2002 / P2025) on one row is
  // caught and that row skipped rather than throwing out the submission.
  let saved = 0;
  let skipped = 0;
  // Track which survivors this rater already has a row for in THIS match,
  // so a remap onto an already-rated survivor merges (skip) rather than
  // double-writing. Seed lazily on first remap to avoid an extra query
  // for the common no-merge path.
  let ratedSurvivors: Set<string> | null = null;
  for (const { playerId, score } of parsed.ratings) {
    if (playerId === session.user.id) continue; // Can't rate yourself
    let targetId = playerId;
    if (!validPlayerIds.has(targetId)) {
      // Stale id — may be a player merged away since the rate page loaded.
      // Follow the merge tombstone chain to the survivor and, if THEY are
      // a valid attendee, remap the score to them rather than losing it.
      const survivor = await resolveMergeSurvivor(playerId, validPlayerIds);
      if (!survivor || survivor === session.user.id) {
        skipped++;
        continue;
      }
      if (ratedSurvivors === null) {
        ratedSurvivors = new Set(
          (
            await db.rating.findMany({
              where: { matchId, raterId: session.user.id },
              select: { playerId: true },
            })
          ).map((r) => r.playerId),
        );
      }
      // Already rated the survivor directly (or via an earlier remap this
      // submission) → merging two scores into one; keep the existing, skip.
      if (ratedSurvivors.has(survivor)) {
        skipped++;
        continue;
      }
      ratedSurvivors.add(survivor);
      targetId = survivor;
    }
    try {
      await db.rating.upsert({
        where: {
          matchId_raterId_playerId: { matchId, raterId: session.user.id, playerId: targetId },
        },
        create: { matchId, raterId: session.user.id, playerId: targetId, score },
        update: { score },
      });
      saved++;
    } catch (err) {
      // Swallow per-row FK/constraint/not-found errors so one stale id
      // can't take down the whole submission; surface anything else.
      if (isSkippableWriteError(err)) {
        skipped++;
        continue;
      }
      throw err;
    }
  }

  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/matches/${matchId}/rate`);

  return { saved, skipped };
}

/**
 * True for Prisma write errors caused by a row referencing a player who
 * no longer exists (or a transient unique-key race), which we want to
 * skip rather than fail the whole submission:
 *   P2003 — FK constraint failed (playerId → deleted User)
 *   P2002 — unique constraint (idempotent re-submit race)
 *   P2025 — record required but not found
 * Anything else (auth, validation, connection) re-throws.
 */
function isSkippableWriteError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "P2003" || code === "P2002" || code === "P2025";
}

/**
 * Resolve a (possibly merged-away) playerId to a survivor who is a valid
 * attendee, by following UserMerge tombstones.
 *
 * `mergePlayers` deletes the dropped User with no FK linkage, so an id
 * captured before the merge (e.g. baked into an open rate-page tab) is
 * dangling. The UserMerge row records old→new; we follow the chain (a
 * survivor may itself have been merged later) with a small hop cap to
 * break any accidental cycle, and return the first survivor that is in
 * `validAttendees`. Returns null when the chain dead-ends or never lands
 * on a current attendee — the caller then falls back to skip-and-lose.
 */
async function resolveMergeSurvivor(
  oldUserId: string,
  validAttendees: Set<string>,
): Promise<string | null> {
  let current = oldUserId;
  const seen = new Set<string>([current]);
  for (let hop = 0; hop < 5; hop++) {
    const merge = await db.userMerge.findFirst({
      where: { oldUserId: current },
      orderBy: { createdAt: "desc" },
      select: { survivorUserId: true },
    });
    if (!merge) return null;
    const survivor = merge.survivorUserId;
    if (validAttendees.has(survivor)) return survivor;
    if (seen.has(survivor)) return null; // cycle guard
    seen.add(survivor);
    current = survivor;
  }
  return null;
}

export async function submitMoMVote(matchId: string, formData: { playerId: string }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const parsed = momVoteSchema.parse(formData);

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: true },
  });
  if (!match) throw new Error("Match not found");
  if (match.status !== "COMPLETED") throw new Error("Match not completed yet");

  const windowEnd = new Date(match.date.getTime() + match.activity.ratingWindowHours * 60 * 60 * 1000);
  if (new Date() > windowEnd) throw new Error("Rating window has closed");

  // Check voter attended
  const attendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId: session.user.id } },
  });
  if (!attendance || attendance.status === "DROPPED") {
    throw new Error("Only match participants can vote");
  }

  // Same stale-snapshot guard as ratings: a voted player who's been
  // merged-away + deleted would throw P2003 MoMVote_playerId_fkey. Now,
  // before skipping, follow the merge tombstone chain — if the voted id
  // was merged into a survivor who IS a current attendee, REMAP the vote
  // to the survivor instead of losing it. Otherwise skip (return
  // saved:false) rather than 500 the submission — the ratings that came
  // before it have already been saved by submitRatings.
  let targetId = parsed.playerId;
  const validPlayer = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId: targetId } },
    select: { status: true },
  });
  if (!validPlayer || validPlayer.status === "DROPPED") {
    const validAttendees = new Set(
      (
        await db.attendance.findMany({
          where: { matchId, status: { not: "DROPPED" } },
          select: { userId: true },
        })
      ).map((a) => a.userId),
    );
    const survivor = await resolveMergeSurvivor(parsed.playerId, validAttendees);
    if (!survivor) return { saved: false as const };
    targetId = survivor;
  }

  try {
    await db.moMVote.upsert({
      where: { matchId_voterId: { matchId, voterId: session.user.id } },
      create: { matchId, voterId: session.user.id, playerId: targetId },
      update: { playerId: targetId },
    });
  } catch (err) {
    if (isSkippableWriteError(err)) return { saved: false as const };
    throw err;
  }

  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/matches/${matchId}/rate`);

  return { saved: true as const };
}
