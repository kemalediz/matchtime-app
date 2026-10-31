/**
 * THE FRIEND LINK, SENT TO THE MEMBER (2026-10-31). Thin I/O around
 * `rules.ts` and `copy.ts`.
 *
 * WHO GETS IT. The only person-shaped input is `senderUserId`, the resolved
 * author of the group message (`MessageOutcome.friendLinks` carries no
 * recipient), so no words in a message can send a link to anyone else. The
 * friend is sent nothing at all: he hears from MatchTime only after his own
 * code message (consent, PECR).
 *
 * ONCE PER MESSAGE. The rows are keyed (message id, claim index), and the
 * whole decision runs under a per-member, per-match lock: the same group
 * message delivered twice writes nothing more and DMs nothing more. Up to
 * `FRIEND_LINK.openLinksPerMemberPerMatch` unused links per member per
 * match (D3); past it, the DM lists his unused links again instead.
 *
 * No number to DM (D7): nothing is written, and the caller says one line
 * in the group. Never throws for a refusal; a database error propagates to
 * the batch, which reports it and sends nothing.
 */
import { db } from "../db";
import { appUrl } from "../app-url";
import { REPLY_PRIORITY } from "../dm-reply-priority";
import { normaliseLang } from "../i18n/lang";
import { memberLinkDm, memberNoPhoneLine } from "./copy";
import { loadFriendMatchFacts } from "./facts";
import { friendLinkState, newLinksAllowed } from "./rules";
import { friendLinkPath } from "./token";

export interface IssueFriendLinksArgs {
  orgId: string;
  matchId: string;
  /** The group message's WhatsApp id. */
  messageId: string;
  senderUserId: string;
  friends: Array<{ claimIndex: number; friendName: string | null }>;
  now?: Date;
}

export interface IssueFriendLinksResult {
  queued: boolean;
  reason: string;
  groupLine: string | null;
}

export async function issueFriendLinks(a: IssueFriendLinksArgs): Promise<IssueFriendLinksResult> {
  const now = a.now ?? new Date();
  const no = (reason: string, groupLine: string | null = null): IssueFriendLinksResult => {
    console.log(`[friend-link] message ${a.messageId}: not sent (${reason})`);
    return { queued: false, reason, groupLine };
  };
  if (a.friends.length === 0) return no("no friends");
  const facts = await loadFriendMatchFacts(a.matchId);
  if (!facts || facts.orgId !== a.orgId) return no("match not found for this club");
  const state = friendLinkState({ used: false, matchStatus: facts.status, isHistorical: facts.isHistorical, kickoff: facts.kickoff, now });
  if (state !== "open") return no(`match ${state}`);
  const lang = normaliseLang(facts.language);
  const sender = await db.user.findUnique({ where: { id: a.senderUserId }, select: { name: true, phoneNumber: true } });
  if (!sender) return no("sender not found");
  const phone = (sender.phoneNumber ?? "").replace(/^\+/, "");
  if (!phone) return no("the sender has no phone on record", memberNoPhoneLine(lang, { member: sender.name ?? "" }));

  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`friend-link:${a.matchId}:${a.senderUserId}`}))`;
      const already = await tx.friendLink.count({ where: { sourceMessageId: a.messageId } });
      if (already > 0) return { queued: true, reason: "already sent for this message", groupLine: null };

      const unused = await tx.friendLink.findMany({
        where: { matchId: a.matchId, issuedByUserId: a.senderUserId, usedAt: null },
        orderBy: { createdAt: "asc" },
        select: { id: true, friendName: true },
      });
      const allowed = newLinksAllowed({ unusedOpen: unused.length, wanted: a.friends.length });
      const created = [];
      for (const f of a.friends.slice(0, allowed)) {
        created.push(
          await tx.friendLink.create({
            data: { orgId: a.orgId, matchId: a.matchId, issuedByUserId: a.senderUserId, friendName: f.friendName, sourceMessageId: a.messageId, claimIndex: f.claimIndex },
            select: { id: true, friendName: true },
          }),
        );
      }
      const capped = created.length === 0;
      const shown = capped ? unused : created;
      const text = memberLinkDm(lang, {
        club: facts.club,
        kickoff: facts.kickoff,
        venue: facts.venue,
        links: shown.map((l) => ({ friend: l.friendName, url: appUrl(friendLinkPath(l.id)) })),
        capped,
      });
      const job = await tx.botJob.create({ data: { orgId: a.orgId, kind: "dm", phone, text, ...REPLY_PRIORITY }, select: { id: true } });
      if (created.length > 0) await tx.friendLink.updateMany({ where: { id: { in: created.map((l) => l.id) } }, data: { botJobId: job.id } });
      console.log(`[friend-link] message ${a.messageId}: ${created.length} link(s) DMed to ${a.senderUserId}${capped ? " (cap reached: unused links resent)" : ""}`);
      return { queued: true, reason: capped ? "cap reached: unused links resent" : `${created.length} link(s) sent`, groupLine: null };
    },
    { maxWait: 20_000, timeout: 20_000 },
  );
}
