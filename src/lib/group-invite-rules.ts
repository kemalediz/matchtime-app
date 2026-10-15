/**
 * MatchTime ACCEPTS A GROUP INVITE: the pure rule (2026-10-15).
 *
 * WhatsApp can refuse to let an organiser add MatchTime to a group: it says
 * "Can't add MatchTime" and offers "Invite to group" instead, which sends
 * MatchTime a private invite message. (Seen 2026-10-15 for an organiser not
 * in MatchTime's contacts while its groups privacy showed Everyone; WhatsApp's
 * reason is NOT confirmed.) An organiser
 * may also paste the group's invite link into the DM. Either way MatchTime
 * has to join by itself, because the product must work for a customer
 * setting up alone.
 *
 * It joins ONLY for the organiser of an open connect request: status
 * `dm_verified`, its 24-hour add window still open, on a club that is still
 * a draft. The organiser is proved exactly as for a group add
 * (`adderIsOrganiserByPhone` / `adderIsOrganiserByLid` in group-add-rules.ts):
 * the sender's phone is the verified sign-up phone, or the sender's LID is
 * the one the connect DM came from. Anybody else's invite is ignored.
 *
 * Joining is not linking. Once MatchTime is in the group, the ordinary
 * bot-added flow runs and `decideGroupAddLink` decides which request the
 * group belongs to, as for any add.
 *
 * No database, no clock but the one passed in, NO MODEL.
 */
import { effectiveConnectStatus, lidDigits } from "./connect-dm-rules";
import { adderIsOrganiserByLid, adderIsOrganiserByPhone, type AddEvidence } from "./group-add-rules";
import { e164Digits } from "./phone";

/** Who sent the invite, off the DM's envelope. */
export interface InviteSender {
  /** Phone digits: the JID's, the alternate address's. Empty when hidden. */
  phones: string[];
  /** Bare LID digits, when the envelope carried one. */
  lid: string | null;
}

/** The columns of a connect request (and its club) the rule reads. */
export interface InviteCandidate {
  id: string;
  status: string;
  /** The organiser's verified sign-up phone, digits. */
  phone: string;
  /** The LID the connect DM came from, bare digits. */
  dmLid: string | null;
  issuedAt: Date;
  expiresAt: Date;
  addWindowEndsAt: Date | null;
  orgApprovalStatus: string;
}

export type InviteRefusal = "no-identity" | "no-open-request" | "not-organiser";

export type InviteDecision =
  | { accept: true; connectId: string; match: "phone" | "lid" }
  | { accept: false; reason: InviteRefusal };

/** The Pi's body, read defensively. */
export function inviteSenderFrom(body: { phone?: unknown; senderAltPhone?: unknown; senderLid?: unknown }): InviteSender {
  const phones: string[] = [];
  for (const raw of [body.phone, body.senderAltPhone]) {
    const d = typeof raw === "string" && raw.trim() ? e164Digits(raw) : null;
    if (d && !phones.includes(d)) phones.push(d);
  }
  return { phones, lid: lidDigits(typeof body.senderLid === "string" ? body.senderLid : null) };
}

function evidenceFor(phone: string | null, lid: string | null): AddEvidence {
  return { addedByPhone: phone, addedByLid: lid, participants: [], discovered: false };
}

export function decideInviteAccept(sender: InviteSender, candidates: InviteCandidate[], now: Date): InviteDecision {
  if (sender.phones.length === 0 && !sender.lid) return { accept: false, reason: "no-identity" };
  const open = candidates
    .filter(
      (c) =>
        c.status === "dm_verified" &&
        c.orgApprovalStatus === "draft" &&
        effectiveConnectStatus(c, now) === "dm_verified",
    )
    .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
  if (open.length === 0) return { accept: false, reason: "no-open-request" };

  const byPhone = open.find((c) => sender.phones.some((p) => adderIsOrganiserByPhone(evidenceFor(p, null), c)));
  if (byPhone) return { accept: true, connectId: byPhone.id, match: "phone" };
  const byLid = open.find((c) => adderIsOrganiserByLid(evidenceFor(null, sender.lid), c));
  if (byLid) return { accept: true, connectId: byLid.id, match: "lid" };
  return { accept: false, reason: "not-organiser" };
}
