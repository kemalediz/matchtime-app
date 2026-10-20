/**
 * The roster name behind a phone number, for this club only (quoted-reply
 * context, slice S4): who wrote a message somebody replied to, when the Pi
 * knew only their phone. Read-only, unlike `resolveSender`, which names
 * placeholders and restores memberships. Null when the phone is not a
 * current member's, or on any read error.
 */
import { db } from "./db";
import { normalisePhone } from "./phone";

export async function rosterNameByPhone(orgId: string, phone: string): Promise<string | null> {
  const norm = normalisePhone(phone.startsWith("+") ? phone : `+${phone}`);
  if (!norm) return null;
  try {
    const row = await db.membership.findFirst({
      where: { orgId, leftAt: null, user: { phoneNumber: norm } },
      select: { user: { select: { name: true } } },
    });
    return row?.user?.name ?? null;
  } catch {
    return null;
  }
}
