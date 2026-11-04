/**
 * THE NAME A PLAYER IS SHOWN UNDER TO THE ORGANISERS (2026-11-04).
 *
 * Moved out of `organiser-pick.ts` (#520, where it was `loadPickNames`)
 * so every organisers' surface prints a player the same way: the pick list
 * and its announcements, and the HQ count line (`squad-count.ts`, the
 * "Done" and pasted-list replies, the late drop-out notice). The sandbox
 * club replay showed both with a hard-coded "?" for a member imported with
 * no name: "3. ? (no position, new)" on the pick list, "2 on the bench
 * (? and Bilal) ... (for example ?)" in the HQ reply.
 *
 * The shared readers decide: the best name MatchTime holds
 * (`loadPlayerNames`: his name, an alias, the WhatsApp name he posts
 * under), and for the organisers only, his phone when there is no name
 * (the stored one, or the one a WhatsApp-imported placeholder email
 * carries; never a real email), as on the admin roster
 * (`adminPlayerLabel`). A guest's phone is never shown (D7). `plain` is the
 * label for the players' group: the name, else the word for "unnamed"; a
 * phone number is never a name there (`player-display-name.ts`).
 *
 * Never throws: a failed read leaves the plain `User.name` or the word for
 * "unnamed".
 */
import { db } from "./db";
import { GUEST_MEMBER_WHERE } from "./guest-membership";
import { t } from "./i18n/t";
import { loadPlayerNames, usableName } from "./player-display-name";
import { adminPlayerLabel } from "./admin-player-label";
import { isPlaceholderEmail } from "./cross-club-link-rules";

/** Both labels for a player. */
export interface OrganiserName {
  /** For the organisers (the admin group, their DMs): the name MatchTime
   *  knows him by, else his phone, else the club's word for "unnamed". */
  admin: string;
  /** For the players' group: the name, else the word for "unnamed". */
  plain: string;
}

export async function loadOrganiserNames(
  orgId: string,
  lang: string | null | undefined,
  userIds: readonly string[],
): Promise<Map<string, OrganiserName>> {
  const out = new Map<string, OrganiserName>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;
  const unnamed = t(lang).unnamed;
  const [users, guests, shown] = await Promise.all([
    Promise.resolve()
      .then(() => db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phoneNumber: true, email: true } }))
      .catch(() => [] as Array<{ id: string; name: string | null; phoneNumber: string | null; email: string | null }>),
    Promise.resolve()
      .then(() => db.membership.findMany({ where: { orgId, userId: { in: ids }, ...GUEST_MEMBER_WHERE }, select: { userId: true } }))
      .catch(() => [] as Array<{ userId: string }>),
    loadPlayerNames(orgId, ids, lang),
  ]);
  const guestIds = new Set((guests ?? []).map((g) => g.userId));
  for (const u of users ?? []) {
    const name = shown.get(u.id)?.name ?? usableName(u.name);
    const guest = guestIds.has(u.id);
    out.set(u.id, {
      admin: adminPlayerLabel(
        {
          name,
          // Only a placeholder email, for the phone it encodes: a real
          // address is never put in a WhatsApp message.
          email: !guest && isPlaceholderEmail(u.email) ? u.email : null,
          phoneNumber: guest ? null : u.phoneNumber,
        },
        lang,
      ),
      plain: name ?? unnamed,
    });
  }
  return out;
}
