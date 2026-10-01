/**
 * The badge share card's guard (Kemal, 2026-10-01).
 *
 * `/api/badge-card/[playerId]/[badgeKey]` is public by cuid, like the
 * Wrapped card, so it can be shared straight into WhatsApp. That makes
 * this guard the feature's safety:
 *
 *   - the card renders only for a badge the player has EARNED, at a club
 *     they are a CURRENT member of. Anything else is null (a 404), never
 *     a greyed-out card: a public URL that rendered "not earned" would
 *     let anyone probe a player's progress;
 *   - the result carries only what the group can already see: the
 *     badge's name and meaning, the player's name, the club's name. No
 *     rating and never a seed (see overall-rating-visibility.test.ts).
 *     The route reads this projection and nothing else, so it cannot
 *     render a number by accident.
 */
import { db } from "@/lib/db";
import { loadPlayerSeasonStats, type Badge } from "@/lib/player-stats";

export interface BadgeCard {
  playerName: string;
  orgName: string;
  badge: Pick<Badge, "key" | "emoji" | "label" | "hint">;
}

/** The badge with this key, if and only if the player has earned it. */
export function findEarnedBadge(badges: Badge[], key: string): Badge | null {
  return badges.find((b) => b.key === key && b.earned) ?? null;
}

export async function loadEarnedBadgeCard(
  orgId: string,
  playerId: string,
  badgeKey: string,
): Promise<BadgeCard | null> {
  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId: playerId, orgId } },
    select: { leftAt: true },
  });
  if (!membership || membership.leftAt !== null) return null;

  const stats = await loadPlayerSeasonStats(orgId, playerId);
  if (!stats) return null;

  const badge = findEarnedBadge(stats.badges, badgeKey);
  if (!badge) return null;

  return {
    playerName: stats.player.name?.trim() || "Player",
    orgName: stats.orgName,
    badge: { key: badge.key, emoji: badge.emoji, label: badge.label, hint: badge.hint },
  };
}
