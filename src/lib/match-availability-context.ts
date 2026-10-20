/**
 * The facts the match-availability classifier is given, loaded once for
 * every caller (the tentative follow-up, the cold DM IN/OUT, a guest's
 * DM OUT): where the player stands for the match, and the chat context
 * (`reply-context.ts`: the time now, and the message they swipe-replied to
 * or MatchTime's recent DMs to them). Kept out of the classifier so that
 * module stays DB-free for its live dry run.
 */
import { db } from "./db";
import { availabilityStatusLabel, type MatchAvailabilityContext } from "./match-availability-classifier";
import { loadDmReplyContext, type QuotedBotMessage } from "./reply-context";

export async function loadMatchAvailabilityFacts(input: {
  userId: string;
  matchId: string;
  /** Where DMs to this player are queued (digits, no "+"), or null. */
  phone: string | null;
  /** The MatchTime message this DM swipe-replies to, resolved once by the
   *  route, or null. */
  quoted: QuotedBotMessage | null;
}): Promise<Pick<MatchAvailabilityContext, "userId" | "matchId" | "currentStatus" | "replyContext">> {
  const { userId, matchId } = input;
  const [row, tentative, replyContext] = await Promise.all([
    db.attendance.findUnique({ where: { matchId_userId: { matchId, userId } }, select: { status: true } }),
    db.tentativeAvailability.findFirst({ where: { matchId, userId, resolvedAt: null }, select: { id: true } }),
    loadDmReplyContext(db, { userId, phone: input.phone, quoted: input.quoted }),
  ]);
  return {
    userId,
    matchId,
    currentStatus: availabilityStatusLabel({ status: row?.status ?? null, tentative: !!tentative }),
    replyContext,
  };
}
