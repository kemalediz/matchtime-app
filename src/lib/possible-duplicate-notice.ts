/**
 * WHO-IS-WHO'S PERMANENT CALLS ABOUT A PERSON, TOLD TO THE CLUB'S ADMINS
 * (review of #574, round 3 and its final review).
 *
 * 1. A POSSIBLE DUPLICATE. The participant sweep makes a new member for
 *    every WhatsApp number MatchTime has never seen. It never gives that
 *    number to a phoneless placeholder ("Hamzah's in", before Hamzah
 *    joined) by a match of names: a new "Dav" must not take over Davide.
 *    So the same person can end up twice. Who-is-who reads each
 *    newcomer's WhatsApp name against the club's PHONELESS PROVISIONAL
 *    members only (the only ones a newcomer can duplicate), in one call
 *    for the sweep, strict as with any WhatsApp name. Sure ("member") or
 *    possible ("ambiguous", each candidate) is a possible duplicate. Every
 *    pair of the sweep goes in ONE notice (a bulk import cannot post a
 *    burst), with a link to the players page where they merge them.
 *    Nothing is merged by code.
 *
 * 2. A PHONE ADOPTED. A sender with a number nobody has, whom who-is-who
 *    placed surely on a phoneless provisional member, gives that member
 *    his number (`resolve-sender.ts`). That is permanent, so the admins
 *    are told once, and can undo a wrong one on the players page.
 *
 * ONCE: a `SentNotification` claim per pair, or per adopted member,
 * released when nothing was queued (an error, or a channel that reaches
 * nobody). A muted club is not told (a queued notice would go out on
 * unmute, stale). The model call runs under the club's daily AI cap;
 * refused, nobody is told and nothing is claimed. Never throws.
 */
import { db } from "./db";
import { sendAdminNotice } from "./admin-channel";
import { withOrgAiBudget } from "./ai-budget";
import { t } from "./i18n/t";
import { personPickerFor } from "./pipeline/identify-batch";
import { refKey } from "./person-ref-key";
import type { PersonPicker, WhoRequest } from "./pipeline/who-is-who";

export const POSSIBLE_DUPLICATE_KIND = "possible-duplicate";
export const PHONE_ADOPTED_KIND = "phone-adopted";

export function possibleDuplicateKey(orgId: string, placeholderId: string, newcomerId: string): string {
  return `${orgId}:${POSSIBLE_DUPLICATE_KIND}:${placeholderId}:${newcomerId}`;
}

export function phoneAdoptedKey(orgId: string, userId: string): string {
  return `${orgId}:${PHONE_ADOPTED_KIND}:${userId}`;
}

/** Claim a once-only key. False: already claimed (or claimed by a racer). */
async function claim(key: string, kind: string): Promise<boolean> {
  if (await db.sentNotification.findUnique({ where: { key }, select: { id: true } })) return false;
  try {
    await db.sentNotification.create({ data: { key, kind } });
    return true;
  } catch {
    return false;
  }
}

async function release(keys: string[]): Promise<void> {
  if (keys.length > 0) await db.sentNotification.deleteMany({ where: { key: { in: keys } } }).catch(() => {});
}

/** Queue the notice; true only when it reached somebody. Releases the
 *  claims otherwise. */
async function tellAdmins(orgId: string, keys: string[], text: (link: string) => string, now?: Date): Promise<boolean> {
  try {
    const res = await sendAdminNotice({ orgId, now, nextPath: "/admin/players", text: (link) => text(link) });
    if (res.channel !== "none" && res.queued > 0) return true;
    console.warn(`[identity-notice] org ${orgId}: the admin channel reaches nobody; claims released`);
  } catch (err) {
    console.error(`[identity-notice] org ${orgId}: notice not queued, claims released:`, err);
  }
  await release(keys);
  return false;
}

async function clubLanguage(orgId: string): Promise<string | null | undefined> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { language: true, whatsappBotEnabled: true } });
  return org?.whatsappBotEnabled ? org.language : undefined;
}

/** Tell the admins about each newcomer who may be a phoneless placeholder,
 *  in one notice. The number of pairs told. Never throws. */
export async function notifyPossibleDuplicates(
  orgId: string,
  newcomers: ReadonlyArray<{ userId: string; name: string | null }>,
  opts: { identify?: PersonPicker; now?: Date } = {},
): Promise<number> {
  try {
    const named = newcomers.filter((n): n is { userId: string; name: string } => !!n.name && n.name.trim().length >= 2);
    if (named.length === 0) return 0;
    const lang = await clubLanguage(orgId);
    if (lang === undefined) return 0; // unknown or muted club

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

    const s = t(lang);
    const pairs: string[] = [];
    const keys: string[] = [];
    for (const n of named) {
      const pick = res.picks.get(n.userId)?.get(refKey(n.name));
      const ids = pick?.kind === "member" ? [pick.userId] : pick?.kind === "ambiguous" ? pick.userIds : [];
      for (const placeholderId of ids) {
        if (!nameOf.has(placeholderId)) continue; // never a ref we did not show
        const key = possibleDuplicateKey(orgId, placeholderId, n.userId);
        if (!(await claim(key, POSSIBLE_DUPLICATE_KIND))) continue;
        keys.push(key);
        pairs.push(s.possible_duplicate_pair({ newName: n.name, oldName: nameOf.get(placeholderId) ?? "?" }));
      }
    }
    if (pairs.length === 0) return 0;
    const told = await tellAdmins(orgId, keys, (link) => s.possible_duplicate_notice({ pairs: pairs.map((p) => `• ${p}`).join("\n"), link }), opts.now);
    if (told) console.log(`[possible-duplicate] org ${orgId}: ${pairs.length} possible duplicate(s) told to the admins`);
    return told ? pairs.length : 0;
  } catch (err) {
    console.error(`[possible-duplicate] org ${orgId}: could not check for duplicates:`, err);
    return 0;
  }
}

/** A phoneless placeholder took a sender's number (who-is-who was sure):
 *  the admins are told once. True when told. Never throws. */
export async function notifyPhoneAdopted(
  orgId: string,
  who: { userId: string; name: string | null; whatsAppName: string },
  opts: { now?: Date } = {},
): Promise<boolean> {
  try {
    const lang = await clubLanguage(orgId);
    if (lang === undefined) return false;
    const key = phoneAdoptedKey(orgId, who.userId);
    if (!(await claim(key, PHONE_ADOPTED_KIND))) return false;
    const s = t(lang);
    return await tellAdmins(
      orgId,
      [key],
      (link) => s.phone_adopted_notice({ name: who.name ?? who.whatsAppName, whatsAppName: who.whatsAppName, link }),
      opts.now,
    );
  } catch (err) {
    console.error(`[phone-adopted] org ${orgId}: could not tell the admins:`, err);
    return false;
  }
}
