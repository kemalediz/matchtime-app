/**
 * THE ROSTER @-MENTIONS ARE NAMED FROM (2026-11-16), shared by the players'
 * group (`api/whatsapp/analyze`) and HQ (`admin-group-squad-change.ts`).
 *
 * Every member with a name, plus every NAMELESS member the batch itself
 * can name (`namesForNamelessMembers`). The Vets, 16 Nov 2026: a player
 * added to the group at 18:05 had a User row with his phone and no name;
 * at 18:06 an organiser tagged him "@<lid> is IN" and the Pi sent his
 * phone with the tag, but the roster held only members with a name, so
 * the group was asked who he was. His own "In" in the same batch named
 * him a second later (`resolve-sender.ts`), too late for the mention.
 *
 * The name is written to his row only while it still has none (`name:
 * null` in the where, exactly as his first post would write it), so a
 * name an organiser typed always wins, and the rest of the request (the
 * engine's roster, the squad post) knows him by the same name the body
 * now carries. A failed write is logged: the mention is still named.
 */
import { db } from "./db";
import { namesForNamelessMembers, type MentionNameInput, type MentionRosterMember } from "./pipeline/mention-names";

export interface MentionBatchMessage {
  authorPhone?: string | null;
  authorName?: string | null;
  body?: string;
  mentions?: string[];
  mentionNames?: MentionNameInput[];
}

export async function loadMentionRoster(
  orgId: string,
  messages: MentionBatchMessage[],
): Promise<{ roster: MentionRosterMember[]; aliases: Array<{ alias: string; userId: string }> }> {
  const [members, aliases] = await Promise.all([
    db.membership.findMany({
      where: { orgId },
      select: { user: { select: { id: true, name: true, phoneNumber: true } } },
    }),
    db.userAlias.findMany({ where: { orgId }, select: { alias: true, userId: true } }),
  ]);
  // Soft-removed members are INCLUDED. Naming someone correctly is not a
  // write about them playing; whether they may play is decided later by
  // code that reads `leftAt` for itself.
  const users = members.map((m) => m.user).filter((u) => !!u);
  const roster: MentionRosterMember[] = users
    .filter((u) => !!u.name)
    .map((u) => ({ userId: u.id, name: u.name as string, phone: u.phoneNumber }));

  const nameless = users.filter((u) => !u.name).map((u) => ({ userId: u.id, phone: u.phoneNumber }));
  const names = nameless.length > 0 ? namesForNamelessMembers({ nameless, messages }) : new Map<string, string>();
  for (const u of nameless) {
    const picked = names.get(u.userId);
    if (!picked) continue;
    let name = picked;
    try {
      const res = await db.user.updateMany({ where: { id: u.userId, name: null }, data: { name: picked } });
      if (res.count > 0) {
        console.log(`[mentions] named placeholder ${u.userId} "${picked}" from the WhatsApp name its batch carried`);
      } else {
        // Named in the meantime (an organiser, or this request's sender
        // resolution): that name is the member's name.
        const now = await db.user.findUnique({ where: { id: u.userId }, select: { name: true } });
        if (now?.name) name = now.name;
      }
    } catch (err) {
      console.error(`[mentions] could not name placeholder ${u.userId}:`, err instanceof Error ? err.message : err);
    }
    roster.push({ userId: u.userId, name, phone: u.phone });
  }
  return { roster, aliases };
}
