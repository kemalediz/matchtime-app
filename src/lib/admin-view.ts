/**
 * Who may see a club's admin-only fields through the member-facing API
 * (phone numbers, emails, seed and club ratings, aliases, invite code,
 * payment and Stripe data).
 *
 * OWNER and ADMIN of the club, plus the platform superadmin. The
 * superadmin check is separate because `getUserOrg` returns a
 * superadmin's REAL membership when they have one, and that membership
 * may be a plain PLAYER.
 */
import { isSuperadmin } from "@/lib/org";

export function isAdminRole(role: string | null | undefined): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export async function seesAdminFields(userId: string, role: string | null | undefined): Promise<boolean> {
  if (isAdminRole(role)) return true;
  return isSuperadmin(userId);
}
