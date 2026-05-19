/**
 * Bench redesign 2026-05-19 (Kemal): "offer to the whole bench,
 * first to confirm wins, nobody ever eliminated".
 *
 * Shared claim logic — used by:
 *   1. /api/whatsapp/reaction  — a 👍 on the group offer post.
 *   2. /api/whatsapp/dm-reply  — a "YES" DM to the offer.
 *   3. /api/whatsapp/analyze   — "IN"/"yes"/👍 in the group.
 *
 * A claim only does something when (a) the claimant is currently a
 * BENCH attendee for the match AND (b) there's an open BenchSlotOffer.
 * The first claim wins atomically (updateMany guarded on
 * resolvedAt:null); later claimants get `ignored` so callers can say
 * "just missed it — you're still on the bench". A decline is a pure
 * no-op: silence/"no" never removes anyone from the bench.
 */
import { db } from "./db";
import { announceSquadFullIfJustFilled } from "./squad-announce";

export type BenchConfirmationResult =
  | {
      kind: "confirmed";
      benchUserName: string | null;
      droppedUserName: string | null;
      teamLabel: string | null;
      confirmedCount: number;
      maxPlayers: number;
    }
  | { kind: "declined" }
  | { kind: "ignored"; reason: string };

export async function resolveBenchConfirmation(args: {
  matchId: string;
  userId: string;
  decision: boolean;
}): Promise<BenchConfirmationResult> {
  const { matchId, userId, decision } = args;

  // A "no" / 👎 is a no-op. We never drop or eliminate a bencher for
  // declining or staying silent — they simply stay on the bench.
  if (!decision) return { kind: "declined" };

  // Claimant must currently be ON the bench for this match.
  const att = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
    select: { status: true },
  });
  if (!att || att.status !== "BENCH") {
    return { kind: "ignored", reason: "claimant-not-on-bench" };
  }

  // Oldest open offer for this match (FIFO if several slots are open).
  const offer = await db.benchSlotOffer.findFirst({
    where: { matchId, resolvedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (!offer) return { kind: "ignored", reason: "no-open-offer" };

  // Atomic first-come claim: only the first writer flips resolvedAt.
  const now = new Date();
  const claim = await db.benchSlotOffer.updateMany({
    where: { id: offer.id, resolvedAt: null },
    data: { resolvedAt: now, claimedByUserId: userId, outcome: "claimed" },
  });
  if (claim.count === 0) {
    // Someone beat them to it in a near-simultaneous claim.
    return { kind: "ignored", reason: "already-claimed" };
  }

  // Promote the claimant.
  await db.attendance.update({
    where: { matchId_userId: { matchId, userId } },
    data: { status: "CONFIRMED" },
  });

  // If this claim completes the squad, fire the full-line-up
  // announcement (in addition to the "X grabbed the slot" line
  // below). Idempotent + atomic; only posts when count hits max.
  await announceSquadFullIfJustFilled(matchId).catch((err) =>
    console.error("[bench-claim] squad-full announce failed:", err),
  );

  // Transfer the dropped player's TeamAssignment (when teams exist).
  let teamLabel: string | null = null;
  let droppedUserName: string | null = null;
  if (offer.replacingUserId) {
    try {
      const droppedTA = await db.teamAssignment.findUnique({
        where: { matchId_userId: { matchId, userId: offer.replacingUserId } },
      });
      const dropped = await db.user.findUnique({
        where: { id: offer.replacingUserId },
        select: { name: true },
      });
      droppedUserName = dropped?.name ?? null;
      if (droppedTA) {
        await db.$transaction([
          db.teamAssignment.delete({
            where: { matchId_userId: { matchId, userId: offer.replacingUserId } },
          }),
          db.teamAssignment.upsert({
            where: { matchId_userId: { matchId, userId } },
            create: { matchId, userId, team: droppedTA.team },
            update: { team: droppedTA.team },
          }),
        ]);
        const mForLabels = await db.match.findUnique({
          where: { id: matchId },
          include: { activity: { include: { sport: true } } },
        });
        if (mForLabels) {
          const labels = mForLabels.activity.sport.teamLabels as [string, string];
          teamLabel = droppedTA.team === "RED" ? labels[0] : labels[1];
        }
      }
    } catch (err) {
      console.error("[bench-claim] team-swap failed (non-fatal):", err);
    }
  }

  // Announce in the group.
  const ctx = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: { include: { org: true } },
      attendances: { where: { status: "CONFIRMED" } },
    },
  });
  const claimer = await db.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });
  const confirmedCount = ctx?.attendances.length ?? 0;
  const maxPlayers = ctx?.maxPlayers ?? 0;
  if (ctx && claimer?.name) {
    let text: string;
    if (teamLabel && droppedUserName) {
      text =
        `🎟 *${claimer.name}* grabbed the slot — taking *${droppedUserName}*'s place on *${teamLabel}* 🙌\n\n` +
        `_Say "regenerate teams" if you want to rebalance with the new line-up._`;
    } else if (droppedUserName) {
      text = `✅ *${claimer.name}* is in, replacing *${droppedUserName}* — squad *${confirmedCount}/${maxPlayers}* 🙌`;
    } else {
      text = `✅ *${claimer.name}* grabbed the open slot — squad *${confirmedCount}/${maxPlayers}* 🙌`;
    }
    try {
      await db.botJob.create({
        data: { orgId: ctx.activity.org.id, kind: "group", text },
      });
    } catch (err) {
      console.error("[bench-claim] announcement queue failed:", err);
    }
  }

  return {
    kind: "confirmed",
    benchUserName: claimer?.name ?? null,
    droppedUserName,
    teamLabel,
    confirmedCount,
    maxPlayers,
  };
}
