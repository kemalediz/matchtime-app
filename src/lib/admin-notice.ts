/**
 * THE ONE WAY A CLUB'S ORGANISERS ARE TOLD SOMETHING (2026-09-30).
 *
 * Slice 1 of MDs/friday-group-features-plan-2026-09-30.md sends its one
 * admin notice (a late drop-out, R4) through here, and so must every
 * later "tell the organisers" message. Today it DMs the club's OWNER
 * (every OWNER membership with a phone). Slice 2 adds the club setting
 * "Admin messages go to" and changes ONLY this function to route by it;
 * no caller should ever pick recipients itself.
 *
 * Not `owner-dm.ts`: that module DMs the PLATFORM owner (Kemal) about
 * club approvals, and its import allowlist forbids anything else. This
 * is the club's own organiser.
 *
 * The DM is a `BotJob`, so it goes out through the club's own bot poll:
 * a muted club (`whatsappBotEnabled` false) sends nothing until unmuted,
 * like every other post. A notice queued between 22:00 and 07:59 London
 * waits for 08:00 (`sendAfter`).
 */
import { db } from "./db";
import { adminNoticeSendAfter } from "./rolling-squad-rules";

export async function sendClubAdminNotice(args: {
  orgId: string;
  /** Already in the club's language. */
  text: string;
  now?: Date;
}): Promise<{ queued: number }> {
  const now = args.now ?? new Date();
  const owners = await db.membership.findMany({
    where: { orgId: args.orgId, role: "OWNER", leftAt: null, user: { phoneNumber: { not: null } } },
    select: { user: { select: { phoneNumber: true } } },
  });
  const sendAfter = adminNoticeSendAfter(now);
  let queued = 0;
  for (const o of owners) {
    const phone = o.user.phoneNumber?.replace(/^\+/, "");
    if (!phone) continue;
    await db.botJob.create({
      data: { orgId: args.orgId, kind: "dm", phone, text: args.text, sendAfter },
    });
    queued++;
  }
  if (queued === 0) {
    console.warn(`[admin-notice] org ${args.orgId} has no owner with a phone; notice not sent`);
  }
  return { queued };
}
