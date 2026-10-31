/**
 * AN ORGANISER TOOK A POOL GUEST OFF THE GAME (slice L7, 2026-10-24).
 *
 * Called by `partner-guest.ts` `tellGuestTakenOffByAdmin`, the one hook
 * every admin removal goes through (the match page's Remove, a group or HQ
 * message, a pasted list), AFTER the write and only for a row that was live.
 * For a CURRENT pool guest of that match: his guest place is marked pulled
 * out in time ("withdrawn": not his doing, never a miss on his record), he
 * becomes a past guest, and he gets ONE short neutral DM on the platform
 * channel in his own language ("plans changed, they don't need a player
 * any more"). It never says he was removed, and never why. A service
 * message about a booking he made, so it goes whatever his offer settings
 * (he could arrive for a game he no longer has). Never throws.
 *
 * A MEMBER'S FRIEND (friend link, 2026-10-31) gets Kemal's own words
 * instead: the organisers took him out of this game, he stays in the pool
 * and will keep hearing about games near him ("friend-removed").
 */
import { db } from "../db";
import { dayCommaTimeLabel } from "../i18n/dates";
import { normaliseLang } from "../i18n/lang";
import { poolSafetyCopy } from "../i18n/pool-safety";
import { queuePlatformDm } from "../platform-jobs";
import { friendRemovedDm } from "../friend-link/copy";

export async function tellPoolGuestRemoved(args: { userId: string; matchId: string; orgId: string; now?: Date }): Promise<boolean> {
  const now = args.now ?? new Date();
  try {
    const mem = await db.membership.findUnique({
      where: { userId_orgId: { userId: args.userId, orgId: args.orgId } },
      select: { guestVia: true, guestMatchId: true, leftAt: true },
    });
    if (!mem || mem.guestVia !== "pool" || mem.leftAt || mem.guestMatchId !== args.matchId) return false;
    const match = await db.match.findUnique({ where: { id: args.matchId }, select: { date: true } });
    // After kickoff (review of #404, 6): nothing is marked and nothing sent;
    // he stays on the no-show panel for the organisers to mark.
    if (!match || now.getTime() >= match.date.getTime()) return false;
    // A member's friend (friend link, 2026-10-31) is told plainly, as Kemal
    // asked: the organisers took him out, he stays in the pool.
    const place = await db.guestPlace.findUnique({ where: { matchId_userId: { matchId: args.matchId, userId: args.userId } }, select: { friendLinkId: true } });
    const friend = !!place?.friendLinkId;
    await db.guestPlace.updateMany({ where: { matchId: args.matchId, userId: args.userId, result: "booked" }, data: { result: "withdrawn", resultAt: now } });
    // Only the call that made him a past guest tells him (review 5).
    const left = await db.membership.updateMany({ where: { userId: args.userId, orgId: args.orgId, guestMatchId: args.matchId, leftAt: null }, data: { leftAt: now } });
    if (left.count !== 1) return false;
    const [club, profile, user] = await Promise.all([
      db.organisation.findUnique({ where: { id: args.orgId }, select: { name: true, language: true } }),
      db.poolProfile.findUnique({ where: { userId: args.userId }, select: { language: true } }),
      db.user.findUnique({ where: { id: args.userId }, select: { phoneNumber: true } }),
    ]);
    const phone = user?.phoneNumber;
    if (club && phone) {
      const lang = normaliseLang(profile?.language ?? club.language);
      await queuePlatformDm({
        phone,
        purpose: friend ? "friend-removed" : "pool-removed",
        refId: `removed:${args.matchId}:${args.userId}`,
        text: friend
          ? friendRemovedDm(lang, { club: club.name, kickoff: match.date })
          : poolSafetyCopy(lang).dm_removed({ club: club.name, day: dayCommaTimeLabel(lang, match.date) }),
        sendAfter: null,
      });
    }
    console.log(`[pool] ${args.userId}: taken off match ${args.matchId} by its organisers${phone ? "" : " (no number to tell)"}`);
    return true;
  } catch (err) {
    console.error(`[pool] ${args.userId}: taken off match ${args.matchId}, not told:`, err instanceof Error ? err.message : "failed");
    return false;
  }
}
