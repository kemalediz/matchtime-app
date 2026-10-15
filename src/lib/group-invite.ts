/**
 * MatchTime ACCEPTS A GROUP INVITE: the database half (2026-10-15). The
 * rule, and why it exists, is in group-invite-rules.ts.
 *
 * Reads only. Joining is the Pi's job; linking the group to the club is
 * the bot-added flow's, after MatchTime is in.
 */
import { db } from "./db";
import { DRAFT_CLUB_WHERE } from "./club-approval-state";
import { decideInviteAccept, inviteSenderFrom, type InviteDecision } from "./group-invite-rules";

export async function checkGroupInviteSender(
  body: { phone?: unknown; senderAltPhone?: unknown; senderLid?: unknown },
  now: Date = new Date(),
): Promise<InviteDecision> {
  const sender = inviteSenderFrom(body);
  if (sender.phones.length === 0 && !sender.lid) return { accept: false, reason: "no-identity" };
  const rows = await db.clubConnect.findMany({
    where: { status: "dm_verified", addWindowEndsAt: { gt: now }, org: DRAFT_CLUB_WHERE },
    select: {
      id: true,
      status: true,
      phone: true,
      dmLid: true,
      issuedAt: true,
      expiresAt: true,
      addWindowEndsAt: true,
      org: { select: { approvalStatus: true } },
    },
  });
  return decideInviteAccept(
    sender,
    rows.map((r) => ({
      id: r.id,
      status: r.status,
      phone: r.phone,
      dmLid: r.dmLid,
      issuedAt: r.issuedAt,
      expiresAt: r.expiresAt,
      addWindowEndsAt: r.addWindowEndsAt,
      orgApprovalStatus: r.org.approvalStatus,
    })),
    now,
  );
}
