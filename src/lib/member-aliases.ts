/**
 * THE CLUB'S ALIASES ON ITS MEMBERS (2026-10-24).
 *
 * An organiser sets an alias in the admin portal ("AH" for Abdul-Hafeez,
 * `UserAlias`, per club). The one name resolver (`pipeline/identity.ts`)
 * reads it off `Member.aliases`, so every roster the resolver is handed
 * carries them: the squad state the engine decides on, the match's players
 * for Man of the Match, the squad a fee waiver names.
 */
import { db } from "./db";

export async function withAliases<T extends { userId: string }>(
  orgId: string,
  members: T[],
): Promise<Array<T & { aliases?: string[] }>> {
  if (members.length === 0) return members;
  const rows = await db.userAlias.findMany({
    where: { orgId, userId: { in: members.map((m) => m.userId) } },
    select: { userId: true, alias: true },
  });
  if (rows.length === 0) return members;
  const byUser = new Map<string, string[]>();
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.alias]);
  return members.map((m) => (byUser.has(m.userId) ? { ...m, aliases: byUser.get(m.userId)! } : m));
}
