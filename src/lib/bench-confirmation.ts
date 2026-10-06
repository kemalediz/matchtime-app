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
import { recordAttendanceEvent } from "./attendance-events";
import { announceSquadFullIfJustFilled } from "./squad-announce";
import { resolveTeamLabels } from "./team-labels";
import { buildBenchClaimAnnouncement } from "./bench-offer-copy";
import { fillVacatedSlots, lockTeamSlots, type AppliedSlotMove } from "./team-slot-fill";

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
    select: {
      status: true,
      position: true,
      match: { select: { activity: { select: { orgId: true, org: { select: { squadMode: true } } } } } },
    },
  });
  if (!att || att.status !== "BENCH") {
    return { kind: "ignored", reason: "claimant-not-on-bench" };
  }

  // Oldest open offer first (FIFO if several slots are open), and on to
  // the next one if a near-simultaneous claim took it: two bench players
  // answering two open offers at the same moment must BOTH get in, not
  // one of them be told "just missed it" while an offer is still open.
  const open = await db.benchSlotOffer.findMany({
    where: { matchId, resolvedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (open.length === 0) return { kind: "ignored", reason: "no-open-offer" };

  // Atomic first-come claim: only the first writer flips resolvedAt.
  const now = new Date();
  let offer: (typeof open)[number] | null = null;
  for (const candidate of open) {
    const claim = await db.benchSlotOffer.updateMany({
      where: { id: candidate.id, resolvedAt: null },
      data: { resolvedAt: now, claimedByUserId: userId, outcome: "claimed" },
    });
    if (claim.count > 0) {
      offer = candidate;
      break;
    }
  }
  if (!offer) {
    // Someone beat them to every open offer.
    return { kind: "ignored", reason: "already-claimed" };
  }
  const claimed = offer;

  // Promote the claimant AND seat them, in ONE transaction with the
  // record of it.
  //
  // The seat is NOT the offer's `replacingUserId`. That is the slot that
  // was vacant when the offer was opened, and by the time somebody claims
  // it another path may have filled it: Sutton FC, 29 September 2026,
  // Ozgur claimed Elnur's offer at 08:05, but Hamzah had inherited
  // Elnur's slot at 07:57, so the old `findUnique` for Elnur's
  // `TeamAssignment` found nothing. Ozgur was seated nowhere, the group
  // was told he replaced Elnur, and ABID's slot, the one actually free,
  // kept Abid's name all day. `fillVacatedSlots` answers the question
  // from the sheet as it stands under the per-match lock, which is the
  // only answer that stays true. See `team-slot-fill.ts`.
  //
  // `sourceRef` is still the offer, and the note names the slot that was
  // really inherited, so the log can tell "claimed a vacated slot" from
  // "said they were coming" and knows whose slot it was.
  const { seat, sheetExists } = await db.$transaction(async (tx) => {
    await lockTeamSlots(tx, matchId);
    await tx.attendance.update({
      where: { matchId_userId: { matchId, userId } },
      data: { status: "CONFIRMED" },
    });
    const moves = await fillVacatedSlots(tx, matchId);
    const mine: AppliedSlotMove | null = moves.find((m) => m.toUserId === userId) ?? null;
    const hasSheet = moves.length > 0 || (await tx.teamAssignment.count({ where: { matchId } })) > 0;
    const vacatedBy = mine ? mine.fromUserId : hasSheet ? null : claimed.replacingUserId;
    await recordAttendanceEvent(
      tx,
      {
        matchId,
        userId,
        orgId: att.match.activity.orgId,
        fromStatus: "BENCH",
        toStatus: "CONFIRMED",
        fromPosition: att.position,
        toPosition: att.position,
      },
      {
        cause: "bench-claim",
        actorKind: "player",
        actorUserId: userId,
        sourceRef: claimed.id,
        note: vacatedBy
          ? `claimed the slot vacated by ${vacatedBy}`
          : "claimed an open slot offered to the bench",
      },
    );
    return { seat: mine, sheetExists: hasSheet };
  });

  // MONTHLY SQUAD (slice 5, 2026-10-06): on a monthly club the claimant
  // takes the vacated slot NUMBER on the month's list, and the credits
  // are brought in line. No query for a weekly club.
  if (att.match.activity.org?.squadMode === "monthly") {
    const { afterMonthlyAttendanceChange } = await import("./monthly-week");
    await afterMonthlyAttendanceChange(matchId, userId, true);
  }

  // If this claim completes the squad, fire the full-line-up
  // announcement (in addition to the "X grabbed the slot" line
  // below). Idempotent + atomic; only posts when count hits max.
  await announceSquadFullIfJustFilled(matchId).catch((err) =>
    console.error("[bench-claim] squad-full announce failed:", err),
  );

  // WHO THE GROUP IS TOLD THIS PLAYER REPLACED. With a sheet, only the
  // holder of the slot they actually inherited, or nobody ("grabbed the
  // open slot") when there was none to inherit: naming the offer's
  // player there is the 29 September lie. Without a sheet there are no
  // slots, and the offer's player is who they replaced in the squad.
  let teamLabel: string | null = null;
  let droppedUserName: string | null = null;
  const replacedId = seat ? seat.fromUserId : sheetExists ? null : claimed.replacingUserId;
  if (replacedId) {
    const dropped = await db.user.findUnique({ where: { id: replacedId }, select: { name: true } });
    droppedUserName = dropped?.name ?? null;
  }
  if (seat) {
    try {
      const mForLabels = await db.match.findUnique({
        where: { id: matchId },
        include: {
          activity: {
            include: { sport: true, org: { select: { teamLabels: true, language: true } } },
          },
        },
      });
      if (mForLabels) {
        const labels = resolveTeamLabels(
          mForLabels,
          mForLabels.activity.org,
          mForLabels.activity.sport,
          mForLabels.activity.org.language,
        );
        teamLabel = seat.team === "RED" ? labels[0] : labels[1];
      }
    } catch (err) {
      console.error("[bench-claim] team label lookup failed (non-fatal):", err);
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
    // The words live in `bench-offer-copy.ts` (pure, golden-pinned).
    const text = buildBenchClaimAnnouncement({
      claimerName: claimer.name,
      droppedName: droppedUserName,
      teamLabel,
      confirmedCount,
      maxPlayers,
      lang: ctx.activity.org.language,
    });
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
