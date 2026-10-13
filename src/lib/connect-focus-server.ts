/**
 * "Finish connecting" mode, read for a request. The rule itself is
 * `isConnectFocus` (connect-focus.ts); this file only gathers its inputs.
 */
import { isSuperadmin } from "./org";
import { selfJoinEnabledForRequest } from "./self-join-flag";
import { isConnectFocus } from "./connect-focus";

/**
 * Is this signed-in person in the mode for the club they have selected?
 * `membership` is what `getUserOrg(userId)` returned (null: no club).
 */
export async function connectFocusFor(
  userId: string,
  membership: { role: string; org: { approvalStatus: string | null } } | null,
): Promise<boolean> {
  if (!membership) return false;
  // The cheap, pure half first: an approved club never reads the flag.
  const { role, org } = membership;
  if (!isConnectFocus({ selfJoinOn: true, isSuperadmin: false, role, org })) return false;
  const [selfJoinOn, superadmin] = await Promise.all([selfJoinEnabledForRequest(), isSuperadmin(userId)]);
  return isConnectFocus({ selfJoinOn, isSuperadmin: superadmin, role, org });
}
