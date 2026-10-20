/**
 * The facts the match-availability classifier is given, loaded once for
 * every caller (the tentative follow-up, the cold DM IN/OUT, a guest's
 * DM OUT): where the player stands for the match, and MatchTime's last DM
 * to them (2026-10-18). Kept out of the classifier so that module stays
 * DB-free for its live dry run.
 */
import { db } from "./db";
import { loadLastBotDm } from "./last-bot-dm";
import { availabilityStatusLabel, type MatchAvailabilityContext } from "./match-availability-classifier";

export async function loadMatchAvailabilityFacts(input: {
  userId: string;
  matchId: string;
  /** Where DMs to this player are queued (digits, no "+"), or null. */
  phone: string | null;
}): Promise<Pick<MatchAvailabilityContext, "userId" | "matchId" | "currentStatus" | "lastBotDm">> {
  const { userId, matchId } = input;
  const [row, tentative, lastBotDm] = await Promise.all([
    db.attendance.findUnique({ where: { matchId_userId: { matchId, userId } }, select: { status: true } }),
    db.tentativeAvailability.findFirst({ where: { matchId, userId, resolvedAt: null }, select: { id: true } }),
    loadLastBotDm(db, { phone: input.phone, userId }),
  ]);
  return {
    userId,
    matchId,
    currentStatus: availabilityStatusLabel({ status: row?.status ?? null, tentative: !!tentative }),
    lastBotDm,
  };
}
