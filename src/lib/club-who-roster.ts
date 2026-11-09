/**
 * THE WHOLE CLUB, AS WHO-IS-WHO IS SHOWN IT (2026-11-09, review of #574).
 *
 * Where a name is to be placed among a FEW people (the match's players
 * for Man of the Match, the squad for a free place, the players on the
 * teams for a team command), who-is-who is still shown everybody in the
 * club, with those few marked: a namesake who is not playing then makes
 * the name ambiguous, and the organiser is asked, instead of the one
 * player of that name being taken because he was the only one shown.
 * Members with no name are shown by their aliases; a marked player who is
 * no current member (a guest on the teams) is shown too.
 */
import { db } from "./db";
import type { WhoRosterMember } from "./pipeline/who-is-who";

export async function loadClubWhoRoster(
  orgId: string,
  players: ReadonlyArray<{ userId: string; name: string | null; aliases?: readonly string[] }>,
  note: string,
): Promise<WhoRosterMember[]> {
  const [memberships, aliases] = await Promise.all([
    db.membership.findMany({ where: { orgId, leftAt: null }, select: { user: { select: { id: true, name: true } } } }),
    db.userAlias.findMany({ where: { orgId }, select: { userId: true, alias: true } }),
  ]);
  const marked = new Set(players.map((p) => p.userId));
  const seen = new Set<string>();
  const out: WhoRosterMember[] = [];
  for (const m of memberships ?? []) {
    if (!m.user || seen.has(m.user.id)) continue;
    seen.add(m.user.id);
    out.push({
      userId: m.user.id,
      name: m.user.name,
      aliases: (aliases ?? []).filter((a) => a.userId === m.user.id).map((a) => a.alias),
      ...(marked.has(m.user.id) ? { note } : {}),
    });
  }
  for (const p of players) {
    if (seen.has(p.userId)) continue;
    seen.add(p.userId);
    out.push({ userId: p.userId, name: p.name, aliases: p.aliases ?? [], note });
  }
  return out;
}
