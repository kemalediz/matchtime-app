/**
 * Shared logic for resolving a PendingBenchConfirmation — used by:
 *   1. /api/whatsapp/reaction — bench player reacts 👍/👎 on the
 *      bot's bench-prompt DM (the "official" path).
 *   2. /api/whatsapp/analyze — bench player replies in the GROUP
 *      with a 👍/👎/yes/no message instead of reacting to the DM.
 *      Surfaces the same confirmation flow for the 80% of users who
 *      don't realise WhatsApp's reaction is what we're waiting for.
 *
 * Returns "confirmed" | "declined" | "ignored" so callers can craft
 * an appropriate reply or no-op.
 */
import { db } from "./db";
import { requestBenchConfirmationOnDrop } from "./bot-scheduler";

export type BenchConfirmationResult =
  | { kind: "confirmed"; benchUserName: string | null; droppedUserName: string | null; teamLabel: string | null; confirmedCount: number; maxPlayers: number }
  | { kind: "declined" }
  | { kind: "ignored"; reason: string };

/**
 * Resolve an open PendingBenchConfirmation for a given user + match.
 * `decision` = true → 👍 (confirm). false → 👎 (decline).
 * Performs the same DB mutations + group announcement that
 * /api/whatsapp/reaction does. Idempotent: a no-op if no open PBC.
 */
export async function resolveBenchConfirmation(args: {
  matchId: string;
  userId: string;
  decision: boolean;
}): Promise<BenchConfirmationResult> {
  const { matchId, userId, decision } = args;

  const bc = await db.pendingBenchConfirmation.findFirst({
    where: { matchId, userId, resolvedAt: null },
  });
  if (!bc) return { kind: "ignored", reason: "no-open-pbc" };

  if (decision) {
    // Step 1: mark PBC confirmed and promote attendance.
    await db.$transaction([
      db.pendingBenchConfirmation.update({
        where: { id: bc.id },
        data: { resolvedAt: new Date(), outcome: "confirmed" },
      }),
      db.attendance.update({
        where: { matchId_userId: { matchId, userId } },
        data: { status: "CONFIRMED" },
      }),
    ]);

    // Step 2: try team-swap (only when teams already exist).
    let teamSwap: { teamLabel: string } | null = null;
    if (bc.replacingUserId) {
      try {
        const droppedTA = await db.teamAssignment.findUnique({
          where: { matchId_userId: { matchId, userId: bc.replacingUserId } },
        });
        if (droppedTA) {
          await db.$transaction([
            db.teamAssignment.delete({
              where: { matchId_userId: { matchId, userId: bc.replacingUserId } },
            }),
            db.teamAssignment.upsert({
              where: { matchId_userId: { matchId, userId } },
              create: { matchId, userId, team: droppedTA.team },
              update: { team: droppedTA.team },
            }),
          ]);
          const matchForLabels = await db.match.findUnique({
            where: { id: matchId },
            include: { activity: { include: { sport: true } } },
          });
          if (matchForLabels) {
            const teamLabels = matchForLabels.activity.sport.teamLabels as [string, string];
            teamSwap = {
              teamLabel: droppedTA.team === "RED" ? teamLabels[0] : teamLabels[1],
            };
          }
        }
      } catch (err) {
        console.error("[bench-confirmation] team-swap failed:", err);
      }
    }

    // Step 3: queue the group announcement.
    const matchWithCtx = await db.match.findUnique({
      where: { id: matchId },
      include: {
        activity: { include: { org: true } },
        attendances: { where: { status: "CONFIRMED" } },
      },
    });
    const [benchUser, droppedUser] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { name: true } }),
      bc.replacingUserId
        ? db.user.findUnique({ where: { id: bc.replacingUserId }, select: { name: true } })
        : null,
    ]);

    if (matchWithCtx && benchUser?.name) {
      const confirmedCount = matchWithCtx.attendances.length;
      const maxPlayers = matchWithCtx.maxPlayers;
      let text: string;
      if (teamSwap && droppedUser?.name) {
        text =
          `🎟 *Slot filled* — *${benchUser.name}* takes *${droppedUser.name}*'s place on *${teamSwap.teamLabel}* 🙌\n\n` +
          `_If anyone wants to rebalance with the new line-up, just say "regenerate teams"._`;
      } else if (droppedUser?.name) {
        text = `✅ *${benchUser.name}* confirmed for tonight, replacing *${droppedUser.name}* — squad is *${confirmedCount}/${maxPlayers}* 🙌`;
      } else {
        text = `✅ *${benchUser.name}* confirmed from the bench — squad is *${confirmedCount}/${maxPlayers}* 🙌`;
      }
      try {
        await db.botJob.create({
          data: {
            orgId: matchWithCtx.activity.org.id,
            kind: "group",
            text,
          },
        });
      } catch (err) {
        console.error("[bench-confirmation] announcement queue failed:", err);
      }

      return {
        kind: "confirmed",
        benchUserName: benchUser.name,
        droppedUserName: droppedUser?.name ?? null,
        teamLabel: teamSwap?.teamLabel ?? null,
        confirmedCount,
        maxPlayers,
      };
    }
    return { kind: "confirmed", benchUserName: null, droppedUserName: null, teamLabel: null, confirmedCount: 0, maxPlayers: 0 };
  }

  // 👎 — they pass. Drop them, chain to next bench player with the
  // same replacingUserId so the next prompt offers the same slot.
  await db.$transaction([
    db.pendingBenchConfirmation.update({
      where: { id: bc.id },
      data: { resolvedAt: new Date(), outcome: "declined" },
    }),
    db.attendance.update({
      where: { matchId_userId: { matchId, userId } },
      data: { status: "DROPPED" },
    }),
  ]);
  await requestBenchConfirmationOnDrop(matchId, bc.replacingUserId);
  return { kind: "declined" };
}
