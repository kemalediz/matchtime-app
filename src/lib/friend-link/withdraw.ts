/**
 * THE FRIEND GIVES HIS PLACE BACK (Kemal, 2026-11-01): the button on his
 * link's page (`app/play/f`, signed in as him) or his own words by DM (the
 * pool reply reader, `pool/reply.ts`, reads his booked place as a taken
 * offer). Mirrors the pool offer's pull-out (`pool/accept.ts`
 * `pullOutOfOffer`): only his own place, only before kick-off; in time or
 * late by the club's cut-off (`pullOutResult`, a late cancel counts on his
 * record as for any pool guest); the normal drop flow (`cancelAttendance`
 * through `withdrawFriendGuest`, the bench offer included); the players'
 * group told once, like any OUT; and one DM to him. Never throws.
 */
import { db } from "../db";
import { tellClubAboutGuest } from "../guest-notice";
import { normaliseLang } from "../i18n/lang";
import { loadPartnerAskSettings } from "../club-partnership";
import { PARTNER_ASK_CUTOFF_DEFAULT_HOURS } from "../club-partnership-rules";
import { askWindows } from "../partner-ask-rules";
import { withdrawFriendGuest } from "../partner-guest";
import { friendPoolFacts, markPoolActive } from "../pool/friend-profile";
import { buildPoolManageLink } from "../pool/links";
import { queueOnce } from "../pool/queue-once";
import { pullOutResult } from "../pool/round-rules";
import { FRIEND_GUEST_NOTICE_KIND } from "./book";
import { friendGroupOutLine, friendOutDm } from "./copy";
import { loadFriendMatchFacts } from "./facts";

export type FriendPullOut = "out" | "not-held" | "started";

export async function pullOutOfFriendPlace(a: { linkId: string; userId: string; now?: Date }): Promise<FriendPullOut> {
  const now = a.now ?? new Date();
  try {
    const link = await db.friendLink.findUnique({ where: { id: a.linkId }, select: { id: true, orgId: true, matchId: true, issuedByUserId: true, usedByUserId: true } });
    if (!link || link.usedByUserId !== a.userId) return "not-held";
    const facts = await loadFriendMatchFacts(link.matchId);
    if (!facts) return "not-held";
    const live = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"].includes(facts.status) && !facts.isHistorical;
    if (!live || now.getTime() >= facts.kickoff.getTime()) return "started";
    const cutoff = askWindows(facts.kickoff, (await loadPartnerAskSettings(link.orgId))?.cutoffHours ?? PARTNER_ASK_CUTOFF_DEFAULT_HOURS).postBy;
    const done = await withdrawFriendGuest({ userId: a.userId, matchId: link.matchId, orgId: link.orgId, linkId: link.id, result: pullOutResult({ now, cutoff }), now });
    if (!done) return "not-held";
    await markPoolActive(a.userId, now);

    const [profile, issuer, user] = await Promise.all([
      friendPoolFacts(a.userId, link.orgId),
      db.user.findUnique({ where: { id: link.issuedByUserId }, select: { name: true } }),
      db.user.findUnique({ where: { id: a.userId }, select: { phoneNumber: true } }),
    ]);
    const line = friendGroupOutLine(normaliseLang(facts.language), { displayName: profile.displayName ?? "", member: issuer?.name ?? "", kickoff: facts.kickoff });
    try {
      await tellClubAboutGuest({ orgId: link.orgId, matchId: link.matchId, key: `friend-link:${link.id}:out`, kind: FRIEND_GUEST_NOTICE_KIND, now, hqText: line, groupText: line, prefer: "players-group-first" });
    } catch (err) {
      console.error(`[friend-link] link ${link.id}: the group was not told of the pull-out:`, err instanceof Error ? err.message : "failed");
    }
    const phone = user?.phoneNumber?.replace(/^\+/, "");
    if (phone) {
      const lang = normaliseLang(profile.language ?? facts.language);
      await queueOnce(phone, friendOutDm(lang, { club: facts.club, kickoff: facts.kickoff, manageLink: await buildPoolManageLink(a.userId) }), "friend-out", `friend-out:${link.id}`);
    }
    console.log(`[friend-link] link ${link.id}: ${a.userId} gave the place back`);
    return "out";
  } catch (err) {
    console.error(`[friend-link] link ${a.linkId}: pull-out by ${a.userId} failed:`, err instanceof Error ? err.message : "failed");
    return "not-held";
  }
}
