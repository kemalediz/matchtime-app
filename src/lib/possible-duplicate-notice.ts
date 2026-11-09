/**
 * A POSSIBLE DUPLICATE, TOLD TO THE CLUB'S ADMINS ONCE (review of #574,
 * round 3).
 *
 * The participant sweep makes a new member for every WhatsApp number
 * MatchTime has never seen. It never gives that number to a phoneless
 * placeholder ("Hamzah's in", before Hamzah joined) by a match of names:
 * a new "Dav" must not take over Davide. So the same person can end up
 * twice, the placeholder and the newcomer.
 *
 * Here who-is-who reads each newcomer's WhatsApp name against the club's
 * PHONELESS PROVISIONAL members only (they are the only ones a newcomer
 * can duplicate), in one call for the sweep, strict as it is with any
 * WhatsApp name. Sure ("member") or possible ("ambiguous", each
 * candidate) is a possible duplicate, and the club's admins are told
 * through the club's admin channel (`sendAdminNotice`), with a link to
 * the players page where they merge the two. Nothing is merged by code.
 *
 * ONCE PER PAIR: a `SentNotification` claim keyed by club, placeholder
 * and newcomer, released if queueing fails. A muted club is not told (a
 * queued notice would go out on unmute, stale). The call runs under the
 * club's daily AI cap; refused, nobody is told and nothing is claimed.
 */
import { db } from "./db";
import { sendAdminNotice } from "./admin-channel";
import { withOrgAiBudget } from "./ai-budget";
import { t } from "./i18n/t";
import { personPickerFor } from "./pipeline/identify-batch";
import { refKey } from "./person-ref-key";
import type { PersonPicker, WhoRequest } from "./pipeline/who-is-who";

export const POSSIBLE_DUPLICATE_KIND = "possible-duplicate";

export function possibleDuplicateKey(orgId: string, placeholderId: string, newcomerId: string): string {
  return `${orgId}:${POSSIBLE_DUPLICATE_KIND}:${placeholderId}:${newcomerId}`;
}

/** Tell the admins about each newcomer who may be a phoneless placeholder.
 *  The number of notices queued. Never throws. */
export async function notifyPossibleDuplicates(
  orgId: string,
  newcomers: ReadonlyArray<{ userId: string; name: string | null }>,
  opts: { identify?: PersonPicker; now?: Date } = {},
): Promise<number> {
  try {
    const named = newcomers.filter((n): n is { userId: string; name: string } => !!n.name && n.name.trim().length >= 2);
    if (named.length === 0) return 0;
    const org = await db.organisation.findUnique({ where: { id: orgId }, select: { language: true, whatsappBotEnabled: true } });
    if (!org?.whatsappBotEnabled) return 0;

    const newIds = new Set(named.map((n) => n.userId));
    const [rows, aliases] = await Promise.all([
      db.membership.findMany({
        where: { orgId, leftAt: null, provisionallyAddedAt: { not: null }, user: { phoneNumber: null } },
        select: { user: { select: { id: true, name: true } } },
      }),
      db.userAlias.findMany({ where: { orgId }, select: { userId: true, alias: true } }),
    ]);
    const placeholders = (rows ?? []).filter((r) => r.user && !newIds.has(r.user.id)).map((r) => r.user);
    if (placeholders.length === 0) return 0;
    const nameOf = new Map(placeholders.map((p) => [p.id, p.name]));

    const request: WhoRequest = {
      roster: placeholders.map((p) => ({
        userId: p.id,
        name: p.name,
        aliases: (aliases ?? []).filter((a) => a.userId === p.id).map((a) => a.alias),
      })),
      where: "the club's players' group, where these people were just found with a WhatsApp number the club did not have; MEMBERS are the members the club added by name only, with no number",
      messages: named.map((n) => ({ id: n.userId, body: "", author: null, refs: [n.name], waNames: true as const })),
    };
    const picker = personPickerFor({ identify: opts.identify });
    const res = await withOrgAiBudget(orgId, () => picker(request));
    for (const d of res.degradations) console.warn(`[possible-duplicate] ${d}`);

    const s = t(org.language);
    let sent = 0;
    for (const n of named) {
      const pick = res.picks.get(n.userId)?.get(refKey(n.name));
      const ids = pick?.kind === "member" ? [pick.userId] : pick?.kind === "ambiguous" ? pick.userIds : [];
      for (const placeholderId of ids) {
        if (!nameOf.has(placeholderId)) continue; // never a ref we did not show
        const key = possibleDuplicateKey(orgId, placeholderId, n.userId);
        if (await db.sentNotification.findUnique({ where: { key }, select: { id: true } })) continue;
        try {
          await db.sentNotification.create({ data: { key, kind: POSSIBLE_DUPLICATE_KIND } });
        } catch {
          continue; // another sweep won the claim
        }
        try {
          const oldName = nameOf.get(placeholderId) ?? "?";
          await sendAdminNotice({
            orgId,
            now: opts.now,
            nextPath: "/admin/players",
            text: (link) => s.possible_duplicate_notice({ newName: n.name, oldName, link }),
          });
          sent += 1;
          console.log(`[possible-duplicate] org ${orgId}: ${n.userId} may be placeholder ${placeholderId}; admins told`);
        } catch (err) {
          console.error(`[possible-duplicate] org ${orgId}: notice not queued, claim released:`, err);
          await db.sentNotification.deleteMany({ where: { key } }).catch(() => {});
        }
      }
    }
    return sent;
  } catch (err) {
    console.error(`[possible-duplicate] org ${orgId}: could not check for duplicates:`, err);
    return 0;
  }
}
