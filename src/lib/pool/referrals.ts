/**
 * REFERRAL BADGES AND "BROUGHT BY", the thin I/O half of
 * `referral-rules.ts` (growth slice G4, 2026-10-24).
 *
 *   stampPlayedReferrals   the complete-matches cron: a referred friend
 *                          seen to have played for the first time gets
 *                          `referralCountedAt`, once (G1.3). Writes nothing
 *                          else and sends nothing.
 *   loadClubReferralAwards the club's badges post (badge-announcement-
 *                          scheduler.ts): the referral badges it names,
 *                          and the lower ones it records silently
 *   loadReferralSummary    his stats page: "Players brought to the game: N"
 *                          and his referral badges. His own page only, so
 *                          a private referrer still sees them.
 *   broughtByForFirstGame  the referrer's name for the organisers' notice
 *                          when a pool guest takes a place for his FIRST
 *                          game (accept.ts)
 *
 * A friend is a pool profile whose `referrerUserId` G1 kept. Reads only the
 * pool's own rows, the friend's guest places and attendances, the
 * referrer's memberships, and the badge ledger. No model, no messages.
 */
import { db } from "../db";
import { ORDINARY_MEMBER_WHERE } from "../guest-membership";
import { REFERRAL_BADGES, REFERRAL_BADGE_KEYS, isReferralBadgeKey, referralBadgesEarned, type ReferralBadgeKey } from "../badge-rules";
import { referralCountsForReward } from "./growth-rules";
import {
  broughtByName,
  chooseHomeClub,
  countReferrals,
  friendHasPlayed,
  pickReferralAwards,
  recognitionShown,
  referralAnnouncedKey,
  type HomeClubCandidate,
  type ReferralAward,
  type ReferralLink,
} from "./referral-rules";

/** At most this many waiting referrals are checked per cron tick. */
const STAMP_BATCH = 500;

const PLAYED_MATCH = { status: "COMPLETED", isHistorical: false } as const;

// ── The cron: a friend has played ──────────────────────────────────────

export async function stampPlayedReferrals(now: Date = new Date()): Promise<{ counted: number }> {
  const waiting = await db.poolProfile.findMany({
    where: { referrerUserId: { not: null }, referralCountedAt: null, userId: { not: null }, status: { not: "pending-verify" } },
    select: { id: true, userId: true, referrerUserId: true },
    orderBy: { createdAt: "asc" },
    take: STAMP_BATCH,
  });
  if (waiting.length === 0) return { counted: 0 };
  const userIds = waiting.map((w) => w.userId!);
  const [places, games] = await Promise.all([
    db.guestPlace.findMany({ where: { userId: { in: userIds } }, select: { userId: true, matchId: true, result: true, settledAt: true } }),
    db.attendance.findMany({ where: { userId: { in: userIds }, status: "CONFIRMED", match: PLAYED_MATCH }, select: { userId: true, matchId: true } }),
  ]);

  let counted = 0;
  for (const w of waiting) {
    const played = friendHasPlayed({
      guestPlaces: places.filter((p) => p.userId === w.userId),
      memberGames: games.filter((g) => g.userId === w.userId),
    });
    if (!referralCountsForReward({ referrerUserId: w.referrerUserId, referralCountedAt: null, friendHasPlayed: played })) continue;
    // Compare-and-set: two ticks at once stamp it once.
    const r = await db.poolProfile.updateMany({ where: { id: w.id, referralCountedAt: null, referrerUserId: { not: null } }, data: { referralCountedAt: now } });
    if (r.count > 0) {
      counted++;
      console.log(`[pool-referral] counted profile=${w.id}`);
    }
  }
  return { counted };
}

// ── Counting for a set of referrers ────────────────────────────────────

async function friendsPlayedBy(referrerIds: readonly string[]): Promise<{ counts: Map<string, number>; profiles: Map<string, { status: string; showRecognition: boolean }> }> {
  const [friends, referrers] = await Promise.all([
    db.poolProfile.findMany({
      where: { referrerUserId: { in: [...referrerIds] }, referralCountedAt: { not: null }, userId: { not: null } },
      select: { userId: true, referrerUserId: true, referralCountedAt: true },
    }),
    db.poolProfile.findMany({ where: { userId: { in: [...referrerIds] } }, select: { userId: true, status: true, showRecognition: true, referrerUserId: true } }),
  ]);
  const ownReferrer = new Map(referrers.map((r) => [r.userId!, r.referrerUserId]));
  const links: ReferralLink[] = friends.map((f) => ({
    friendUserId: f.userId!,
    referrerUserId: f.referrerUserId,
    referralCountedAt: f.referralCountedAt,
    referrersOwnReferrerId: ownReferrer.get(f.referrerUserId!) ?? null,
  }));
  return { counts: countReferrals(links), profiles: new Map(referrers.map((r) => [r.userId!, { status: r.status, showRecognition: r.showRecognition }])) };
}

async function homeClubsOf(userIds: readonly string[]): Promise<Map<string, string | null>> {
  const [memberships, games] = await Promise.all([
    db.membership.findMany({ where: { userId: { in: [...userIds] }, leftAt: null, ...ORDINARY_MEMBER_WHERE }, select: { userId: true, orgId: true } }),
    db.attendance.findMany({
      where: { userId: { in: [...userIds] }, status: "CONFIRMED", match: PLAYED_MATCH },
      select: { userId: true, match: { select: { date: true, activity: { select: { orgId: true } } } } },
    }),
  ]);
  const out = new Map<string, string | null>();
  for (const u of userIds) {
    const clubs: HomeClubCandidate[] = memberships
      .filter((m) => m.userId === u)
      .map((m) => {
        const here = games.filter((g) => g.userId === u && g.match.activity.orgId === m.orgId);
        const last = here.reduce<Date | null>((acc, g) => (!acc || g.match.date > acc ? g.match.date : acc), null);
        return { orgId: m.orgId, gamesPlayed: here.length, lastPlayedAt: last };
      });
    out.set(u, chooseHomeClub(clubs));
  }
  return out;
}

// ── The club's badges post ─────────────────────────────────────────────

/**
 * The referral badges this club's post names (`awards`) and records
 * silently (`silent`), for its current ordinary members. One query and an
 * empty answer for a club none of whose members has a friend who played.
 */
export async function loadClubReferralAwards(orgId: string, eligibleUserIds: ReadonlySet<string>): Promise<{ awards: ReferralAward[]; silent: ReferralAward[] }> {
  if (eligibleUserIds.size === 0) return { awards: [], silent: [] };
  const withFriends = await db.poolProfile.findMany({
    where: { referrerUserId: { in: [...eligibleUserIds] }, referralCountedAt: { not: null } },
    select: { referrerUserId: true },
    distinct: ["referrerUserId"],
  });
  const referrerIds = withFriends.map((r) => r.referrerUserId!).filter(Boolean);
  if (referrerIds.length === 0) return { awards: [], silent: [] };

  const [{ counts, profiles }, homes, ledger] = await Promise.all([
    friendsPlayedBy(referrerIds),
    homeClubsOf(referrerIds),
    // Every club's rows: a referral badge is announced once per person, ever.
    db.badgeAnnouncement.findMany({ where: { userId: { in: referrerIds }, badgeKey: { in: [...REFERRAL_BADGE_KEYS] } }, select: { userId: true, badgeKey: true } }),
  ]);
  const announced = new Set(ledger.filter((r) => isReferralBadgeKey(r.badgeKey)).map((r) => referralAnnouncedKey(r.userId, r.badgeKey as ReferralBadgeKey)));
  return pickReferralAwards({
    orgId,
    referrers: referrerIds.map((userId) => ({
      userId,
      friendsPlayed: counts.get(userId) ?? 0,
      homeOrgId: homes.get(userId) ?? null,
      shown: recognitionShown(profiles.get(userId) ?? null),
    })),
    announced,
    eligibleUserIds,
  });
}

// ── His stats page ─────────────────────────────────────────────────────

export interface ReferralSummary {
  friendsPlayed: number;
  /** Earned ones only, lowest first. */
  badges: Array<{ key: ReferralBadgeKey; emoji: string; label: string; minFriends: number }>;
  /** False: he keeps them private (the group is not told). */
  shown: boolean;
}

/** Null until a friend of his has played: a player with none sees nothing new. */
export async function loadReferralSummary(userId: string): Promise<ReferralSummary | null> {
  const { counts, profiles } = await friendsPlayedBy([userId]);
  const n = counts.get(userId) ?? 0;
  if (n === 0) return null;
  const earned = referralBadgesEarned(n);
  return {
    friendsPlayed: n,
    badges: REFERRAL_BADGES.filter((b) => earned[b.key]).map(({ key, emoji, label, minFriends }) => ({ key, emoji, label, minFriends })),
    shown: recognitionShown(profiles.get(userId) ?? null),
  };
}

// ── "Brought by" on the friend's first game ────────────────────────────

/**
 * The referrer's name when this pool guest has never played a game (no
 * CONFIRMED place on any completed match), the referral was kept and the
 * referrer lets himself be named. Otherwise null.
 */
export async function broughtByForFirstGame(userId: string): Promise<string | null> {
  const me = await db.poolProfile.findUnique({ where: { userId }, select: { referrerUserId: true } });
  if (!me?.referrerUserId || me.referrerUserId === userId) return null;
  const [gamesBefore, referrer] = await Promise.all([
    db.attendance.count({ where: { userId, status: "CONFIRMED", match: { status: "COMPLETED" } } }),
    db.poolProfile.findUnique({ where: { userId: me.referrerUserId }, select: { displayName: true, status: true, showRecognition: true } }),
  ]);
  return broughtByName({ firstGame: gamesBefore === 0, referrer });
}
