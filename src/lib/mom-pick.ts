/**
 * MAN OF THE MATCH PICKED BY THE ORGANISERS (2026-10-18, mom-chooser.ts).
 *
 * HOW IT IS STORED, AND WHY THAT WAY. A voted Man of the Match is the
 * player with the most MoMVote rows for the match (`momWinners`,
 * badge-rules.ts). Everything that shows or counts one reads those rows:
 * the 👑 on the stats timeline and the MoM tile (player-stats.ts), the
 * "MoM Machine" badge and the badge announcement (badge-announcements.ts),
 * the "who got MoM" answers (match-history.ts), the match page and the
 * dashboard (mom.ts). There is no MoM bonus in the club rating: Elo moves
 * on the score alone (match-elo.ts), so nothing else needs feeding.
 *
 * So an organiser's pick is written as exactly ONE MoMVote for the match,
 * cast by the organiser for the player, after clearing the match's other
 * rows. The single row makes that player the sole winner on every reader
 * above, with no reader changed: the crown, the badge and the counts are
 * identical to a voted Man of the Match. Changing the pick replaces the
 * row. Nothing else writes MoMVote rows for an organisers' club: the vote
 * paths refuse (actions/ratings.ts, api/whatsapp/poll-vote).
 *
 * The players a pick can name are the match's own: CONFIRMED attendance
 * and the team sheet. The name is resolved with the pipeline's shared
 * `resolvePerson` (an ambiguity is a question, never a coin flip).
 */
import { db } from "./db";
import { momWinners } from "./badge-rules";
import { resolvePerson } from "./pipeline/identity";
import { withAliases } from "./member-aliases";
import type { Member } from "./pipeline/types";

/** What an organiser's name for Man of the Match comes to, for one match. */
export type MomRefResult =
  | { kind: "resolved"; userId: string; name: string }
  | { kind: "ambiguous"; ref: string; names: string[] }
  | { kind: "not-in-match"; ref: string };

/** The people who played the match: CONFIRMED attendance and the team sheet. */
export async function matchPlayers(matchId: string): Promise<Member[]> {
  const [att, teams] = await Promise.all([
    db.attendance.findMany({
      where: { matchId, status: "CONFIRMED" },
      select: { userId: true, user: { select: { name: true } } },
    }),
    db.teamAssignment.findMany({
      where: { matchId },
      select: { userId: true, user: { select: { name: true } } },
    }),
  ]);
  const byId = new Map<string, Member>();
  for (const r of [...att, ...teams]) {
    if (!byId.has(r.userId)) byId.set(r.userId, { userId: r.userId, name: r.user?.name ?? "", isAdmin: false, hasPhone: false });
  }
  const players = [...byId.values()].filter((m) => m.name.trim());
  // The club's aliases ("AH" is Abdul-Hafeez), for the one resolver.
  const orgId = players.length
    ? (await db.match.findUnique({ where: { id: matchId }, select: { activity: { select: { orgId: true } } } }))?.activity.orgId
    : undefined;
  return orgId ? withAliases(orgId, players) : players;
}

/** Resolve the organiser's words against the match's players. Pure. */
export function resolveMomRef(ref: string, players: Member[]): MomRefResult {
  const shown = ref.replace(/^@/, "").trim();
  const r = resolvePerson(ref, players);
  if (r.kind === "resolved") return { kind: "resolved", userId: r.member.userId, name: r.member.name };
  if (r.kind === "ambiguous") return { kind: "ambiguous", ref: shown, names: r.candidates.map((c) => c.name) };
  return { kind: "not-in-match", ref: shown };
}

/** What the club calls Man of the Match for this match's sport ("Man of the Match", "MVP"). */
export async function matchMvpLabel(matchId: string): Promise<string> {
  const m = await db.match.findUnique({ where: { id: matchId }, select: { activity: { select: { sport: { select: { mvpLabel: true } } } } } });
  return m?.activity.sport.mvpLabel || "Man of the Match";
}

/** The Man of the Match the match's rows name today (ties co-win). */
export async function currentMom(matchId: string): Promise<Array<{ userId: string; name: string }>> {
  const votes = await db.moMVote.findMany({ where: { matchId }, select: { playerId: true } });
  const ids = [...momWinners(votes)];
  if (ids.length === 0) return [];
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return users.map((u) => ({ userId: u.id, name: u.name ?? "?" }));
}

/**
 * THE WRITER. Make `playerId` the match's one Man of the Match, picked by
 * `byUserId`. Returns who it was before (empty when nobody), so the
 * caller can say "changed". One transaction: the match never has no rows
 * halfway through a change.
 */
export async function setMatchMom(args: {
  matchId: string;
  playerId: string;
  byUserId: string;
}): Promise<{ previous: string[] }> {
  const { matchId, playerId, byUserId } = args;
  return db.$transaction(async (tx) => {
    const before = await tx.moMVote.findMany({ where: { matchId }, select: { playerId: true } });
    await tx.moMVote.deleteMany({ where: { matchId } });
    await tx.moMVote.create({ data: { matchId, voterId: byUserId, playerId } });
    return { previous: [...momWinners(before)] };
  });
}

/** The reads and the writer above, as one injectable set (tests swap it). */
export interface MomPickDeps {
  players: (matchId: string) => Promise<Member[]>;
  mvpLabel: (matchId: string) => Promise<string>;
  current: (matchId: string) => Promise<Array<{ userId: string; name: string }>>;
  set: (args: { matchId: string; playerId: string; byUserId: string }) => Promise<{ previous: string[] }>;
}

export const momPickDeps: MomPickDeps = {
  players: matchPlayers,
  mvpLabel: matchMvpLabel,
  current: currentMom,
  set: setMatchMom,
};

/** What `recordMatchTimeQuestion` files a Man of the Match question under. */
export const momAskRef = (matchId: string) => `mom:${matchId}`;
