/**
 * The club member behind a phone number, for this club only (quoted-reply
 * context, slice S4): who wrote a message somebody replied to, when the Pi
 * knew only their phone. Their user id and ROSTER name; never a WhatsApp
 * profile name. Read-only, unlike `resolveSender`, which names
 * placeholders and restores memberships. Null when the phone is not a
 * current member's, or on any read error.
 */
import { db } from "./db";
import { normalisePhone } from "./phone";

export async function rosterMemberByPhone(orgId: string, phone: string): Promise<{ userId: string; name: string | null } | null> {
  const norm = normalisePhone(phone.startsWith("+") ? phone : `+${phone}`);
  if (!norm) return null;
  try {
    const row = await db.membership.findFirst({
      where: { orgId, leftAt: null, user: { phoneNumber: norm } },
      select: { userId: true, user: { select: { name: true } } },
    });
    return row ? { userId: row.userId, name: row.user?.name ?? null } : null;
  } catch {
    return null;
  }
}
