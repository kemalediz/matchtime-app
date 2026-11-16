/**
 * THE FRIEND, BOOKED (2026-10-31). Thin I/O around `rules.ts` and
 * `copy.ts`, called by the /play confirm handler (`pool/confirm.ts`) once
 * his own WhatsApp code made him a pool member, or proved the number of a
 * pool member he already was.
 *
 *   1. the refusals first (`friendBookingRefusal`): the link used or the
 *      game started or called off, the member's own number, a player
 *      already on the list, blocked by the club or paused for reports,
 *      removed from this club by an organiser (`guest-door-rules.ts`), a
 *      guest of this club for another game. Told in one DM; the link is
 *      not spent.
 *   2. the link is claimed once (compare-and-set on `usedAt`, his message
 *      id unique), so a second person with the same link, or the same
 *      message again, books nothing.
 *   3. he is placed by the one guest writer (`partner-guest.ts`
 *      `placeFriendGuest`: the club's rule, the per-match lock, in or the
 *      bench). Nothing written: the claim is given back.
 *   4. the players' group hears it once (D8, quiet hours as every
 *      unprompted post there); he gets one DM.
 *
 * Never throws: a failure is logged and he hears the neutral line.
 */
import { db } from "../db";
import { normaliseLang } from "../i18n/lang";
import { GUEST_DOOR_SELECT, guestDoorShut } from "../guest-door-rules";
import { tellClubAboutGuest } from "../guest-notice";
import { placeFriendGuest } from "../partner-guest";
import { buildPoolManageLink, buildSignedPoolLink } from "../pool/links";
import { friendLinkPath } from "./token";
import { queueOnce } from "../pool/queue-once";
import { friendPoolFacts, markPoolActive } from "../pool/friend-profile";
import { normaliseBenchPickMode } from "../squad-capacity";
import { friendBookedDm, friendGroupLine, friendNotBookedDm } from "./copy";
import { loadFriendMatchFacts } from "./facts";
import { friendBookingRefusal, friendLinkState, type FriendNotBooked } from "./rules";

export const FRIEND_GUEST_NOTICE_KIND = "friend-guest" as const;

export interface BookFriendArgs {
  linkId: string;
  /** His account: the number that sent the code. */
  userId: string;
  /** That number, digits, for his DM. */
  phone: string;
  /** The WhatsApp id of his code message. */
  waMessageId: string;
  /** His profile was made by this code (the DM says he joined the pool). */
  newToPool: boolean;
  /** MatchTime paused him for reports or by hand (D6): not booked. */
  blockedProfile?: boolean;
  now?: Date;
}

export type BookFriendResult = { booked: "in" | "bench" } | { booked: false; reason: FriendNotBooked };

export async function bookFriend(a: BookFriendArgs): Promise<BookFriendResult> {
  const now = a.now ?? new Date();
  try {
    const link0 = await db.friendLink.findUnique({ where: { id: a.linkId }, select: { matchId: true } });
    if (!link0) return await bookUnlocked(a, now);
    // One booking at a time per (match, person): the same code twice at
    // once books him once and tells him once (review of #488, 3). The lock
    // is held by this transaction while the writes run on their own.
    return await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`friend-book:${link0.matchId}:${a.userId}`}))`;
        return bookUnlocked(a, now);
      },
      { maxWait: 20_000, timeout: 45_000 },
    );
  } catch (err) {
    console.error(`[friend-link] link ${a.linkId}: booking ${a.userId} failed:`, err instanceof Error ? err.message : "failed");
    return { booked: false, reason: "failed" };
  }
}

async function bookUnlocked(a: BookFriendArgs, now: Date): Promise<BookFriendResult> {
  const link = await db.friendLink.findUnique({ where: { id: a.linkId }, select: { id: true, orgId: true, matchId: true, issuedByUserId: true, usedAt: true, usedByUserId: true, outcome: true } });
  // HIS link already: booked by an earlier message of his. Nothing more.
  if (link?.usedAt && link.usedByUserId === a.userId && (link.outcome === "in" || link.outcome === "bench")) return { booked: link.outcome };
  const facts = link ? await loadFriendMatchFacts(link.matchId) : null;
  const profile = link ? await friendPoolFacts(a.userId, link.orgId) : { language: null, displayName: null, blockedByClub: false };
  const lang = normaliseLang(profile.language ?? facts?.language);
  const manageLink = await buildPoolManageLink(a.userId);
  const refuse = async (reason: FriendNotBooked): Promise<BookFriendResult> => {
    console.log(`[friend-link] link ${a.linkId}: ${a.userId} not booked (${reason})`);
    await queueOnce(a.phone, friendNotBookedDm(lang, { reason, newToPool: a.newToPool, manageLink }), "friend-not-booked", `friend-not-booked:${a.linkId}:${a.userId}`);
    return { booked: false, reason };
  };
  if (!link || !facts) return refuse("failed");

  const [row, mem] = await Promise.all([
    db.attendance.findUnique({ where: { matchId_userId: { matchId: link.matchId, userId: a.userId } }, select: { status: true } }),
    db.membership.findUnique({ where: { userId_orgId: { userId: a.userId, orgId: link.orgId } }, select: GUEST_DOOR_SELECT }),
  ]);
  const refusal = friendBookingRefusal({
    linkState: friendLinkState({ used: !!link.usedAt, matchStatus: facts.status, isHistorical: facts.isHistorical, kickoff: facts.kickoff, now }),
    isIssuer: a.userId === link.issuedByUserId,
    alreadyOnMatch: row?.status === "CONFIRMED" || row?.status === "BENCH",
    // The club blocked him or MatchTime paused him, or an organiser removed
    // him from this club (guest-door-rules.ts). He stays a pool member.
    blocked: guestDoorShut({ blocked: profile.blockedByClub || a.blockedProfile === true, membership: mem }),
    guestElsewhere: !!mem && !mem.leftAt && !!mem.guestMatchId && mem.guestMatchId !== link.matchId,
  });
  if (refusal) return refuse(refusal);

  // Claimed once: a second person with this link, or this message again.
  const claimed = await db.friendLink.updateMany({
    where: { id: link.id, usedAt: null },
    data: { usedAt: now, usedByUserId: a.userId, usedMessageId: a.waMessageId, outcome: "in" },
  });
  if (claimed.count === 0) return refuse("used");

  const placed = await placeFriendGuest({ linkId: link.id, userId: a.userId, orgId: link.orgId, matchId: link.matchId, benchPickMode: facts.benchPickMode, issuedByUserId: link.issuedByUserId });
  if (placed.kind !== "in" && placed.kind !== "bench") {
    await db.friendLink.updateMany({ where: { id: link.id, usedMessageId: a.waMessageId }, data: { usedAt: null, usedByUserId: null, usedMessageId: null, outcome: null } });
    return refuse(placed.kind === "elsewhere" ? "elsewhere" : "failed");
  }
  await db.friendLink.update({ where: { id: link.id }, data: { outcome: placed.kind } });
  await markPoolActive(a.userId, now);

  const issuer = await db.user.findUnique({ where: { id: link.issuedByUserId }, select: { name: true } });
  const member = issuer?.name ?? "";
  const organiserPicks = normaliseBenchPickMode(facts.benchPickMode) === "organiser";
  const clubLang = normaliseLang(facts.language);
  const line = friendGroupLine(clubLang, { displayName: profile.displayName ?? "", member, kickoff: facts.kickoff, status: placed.kind, organiserPicks });
  // The group and he are told independently, each once (review of #488, 7).
  await safely(`group notice for link ${link.id}`, () =>
    tellClubAboutGuest({ orgId: link.orgId, matchId: link.matchId, key: `friend-link:${link.id}:placed`, kind: FRIEND_GUEST_NOTICE_KIND, now, hqText: line, groupText: line, prefer: "players-group-first" }),
  );
  await safely(`his DM for link ${link.id}`, async () =>
    queueOnce(
      a.phone,
      friendBookedDm(lang, {
        club: facts.club,
        kickoff: facts.kickoff,
        venue: facts.venue,
        member,
        status: placed.kind as "in" | "bench",
        organiserPicks,
        fee: facts.fee,
        monthly: facts.monthly,
        newToPool: a.newToPool,
        manageLink,
        pullOutLink: await buildSignedPoolLink(a.userId, friendLinkPath(link.id)),
      }),
      "friend-booked",
      `friend-booked:${link.id}`,
    ),
  );
  console.log(`[friend-link] link ${link.id}: ${a.userId} booked ${placed.kind} on match ${link.matchId}`);
  return { booked: placed.kind };
}

async function safely(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[friend-link] ${what} not queued:`, err instanceof Error ? err.message : "failed");
  }
}
