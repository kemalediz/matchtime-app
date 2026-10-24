/**
 * REFERRAL BADGES AND "BROUGHT BY" (growth slice G4, 2026-10-24). PURE: no
 * database, no clock, NO MODEL. The thin I/O half is `referrals.ts`.
 *
 * Spec "Referrals": count only once the friend has played; Recruiter (1),
 * Scout (3), Talent Spotter (10), announced in the referrer's club group;
 * "Brought by X" on the friend's first game; "Players brought to the game:
 * N" on his stats page; the manage page's switch keeps badges and "Brought
 * by" private. Decisions G4.x in the decisions log.
 *
 *   friendHasPlayed     a SETTLED played guest game (L7), or a completed
 *                       match he was CONFIRMED on as a member
 *   isCountableReferral the referral was kept (G1 settles self, loop,
 *                       stopped referrer, existing user), the friend has
 *                       played (`referralCountedAt`, stamped once), and it
 *                       is not himself or a two-person loop
 *   chooseHomeClub      the ONE club his badges are announced in: the one
 *                       he plays most, so several groups never hear it
 *   pickReferralAwards  what one club's badges post names: the highest new
 *                       badge only, lower ones recorded silently
 *   broughtByName       the referrer's name on the friend's first game
 *
 * The badges' thresholds and names live with every other badge, in
 * `badge-rules.ts` (REFERRAL_BADGES); the ledger is `BadgeAnnouncement`.
 */
import { REFERRAL_BADGES, referralBadgesEarned, type ReferralBadgeKey } from "../badge-rules";
import { referrerShownName } from "./growth-rules";

// ── Has the friend played? ─────────────────────────────────────────────

export interface FriendGames {
  /** Every guest place of his (pool and partner), any club. */
  guestPlaces: ReadonlyArray<{ matchId: string; result: string; settledAt: Date | null }>;
  /** Completed (non-historical) matches with his CONFIRMED attendance. */
  memberGames: ReadonlyArray<{ matchId: string }>;
}

/**
 * "Actually played a game". A guest game counts only once its result is
 * FINAL and "played" (L7.16: a no-show still undo-able never counts, and
 * nor does a played result still inside its window). A confirmed place on a
 * completed match counts as a member game only when he was not a guest
 * there: a guest's place is judged by its guest record alone.
 */
export function friendHasPlayed(g: FriendGames): boolean {
  if (g.guestPlaces.some((p) => p.result === "played" && p.settledAt !== null)) return true;
  const guestMatches = new Set(g.guestPlaces.map((p) => p.matchId));
  return g.memberGames.some((m) => !guestMatches.has(m.matchId));
}

// ── Counting ───────────────────────────────────────────────────────────

export interface ReferralLink {
  friendUserId: string;
  referrerUserId: string | null;
  /** Stamped once, the first time he is seen to have played (G1.3). */
  referralCountedAt: Date | null;
  /** Who brought the REFERRER, if anyone. */
  referrersOwnReferrerId: string | null;
}

export function isCountableReferral(l: ReferralLink): boolean {
  if (!l.referrerUserId || !l.referralCountedAt) return false;
  if (l.referrerUserId === l.friendUserId) return false; // himself
  if (l.referrersOwnReferrerId === l.friendUserId) return false; // a loop: they brought each other
  return true;
}

/** Friends who have played, per referrer. */
export function countReferrals(links: readonly ReferralLink[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of links) {
    if (!isCountableReferral(l)) continue;
    out.set(l.referrerUserId!, (out.get(l.referrerUserId!) ?? 0) + 1);
  }
  return out;
}

// ── Where his badges are announced ─────────────────────────────────────

export interface HomeClubCandidate {
  orgId: string;
  /** Completed matches he was CONFIRMED on at this club. */
  gamesPlayed: number;
  lastPlayedAt: Date | null;
}

/**
 * The club he plays most (a current, ordinary membership): most games,
 * then the latest game, then the club's id (memberships carry no join
 * date), so the answer is stable and exactly one club is ever told.
 */
export function chooseHomeClub(clubs: readonly HomeClubCandidate[]): string | null {
  const sorted = [...clubs].sort(
    (a, b) =>
      b.gamesPlayed - a.gamesPlayed ||
      (b.lastPlayedAt?.getTime() ?? 0) - (a.lastPlayedAt?.getTime() ?? 0) ||
      a.orgId.localeCompare(b.orgId),
  );
  return sorted[0]?.orgId ?? null;
}

// ── His privacy switch ─────────────────────────────────────────────────

/**
 * Is he named for his referrals (a badge in a group, "Brought by")? Only a
 * live profile (active or paused) with the manage page's switch showing. A
 * stopped profile has withdrawn consent, and no profile has no switch: both
 * are the private side.
 */
export function recognitionShown(p: { status: string; showRecognition: boolean } | null): boolean {
  return !!p && p.showRecognition && (p.status === "active" || p.status === "paused");
}

// ── What a club's badges post names ────────────────────────────────────

export function referralAnnouncedKey(userId: string, badgeKey: ReferralBadgeKey): string {
  return `${userId}:${badgeKey}`;
}

export interface ReferrerFacts {
  userId: string;
  friendsPlayed: number;
  /** `chooseHomeClub` for him. */
  homeOrgId: string | null;
  /** `recognitionShown` for him. */
  shown: boolean;
}

export interface ReferralAward {
  userId: string;
  badgeKey: ReferralBadgeKey;
}

/**
 * The referral badges this club's post announces, and the ledger rows that
 * ride with it silently. Only his home club; only a current member; only
 * while he lets himself be named (a private referrer gets no row at all, so
 * turning the switch back on later lets the badge be announced then). Each
 * badge is announced once per person EVER, in any club (`announced` holds
 * his rows from every club). Of several new badges at once, only the
 * highest is announced ("Scout", not "Recruiter and Scout").
 */
export function pickReferralAwards(a: {
  orgId: string;
  referrers: readonly ReferrerFacts[];
  /** `referralAnnouncedKey` for each of these referrers' rows, every club. */
  announced: ReadonlySet<string>;
  eligibleUserIds: ReadonlySet<string>;
}): { awards: ReferralAward[]; silent: ReferralAward[] } {
  const awards: ReferralAward[] = [];
  const silent: ReferralAward[] = [];
  for (const r of a.referrers) {
    if (r.homeOrgId !== a.orgId || !r.shown || !a.eligibleUserIds.has(r.userId)) continue;
    const earned = referralBadgesEarned(r.friendsPlayed);
    const fresh = REFERRAL_BADGES.filter((b) => earned[b.key] && !a.announced.has(referralAnnouncedKey(r.userId, b.key))).map((b) => b.key);
    if (fresh.length === 0) continue;
    awards.push({ userId: r.userId, badgeKey: fresh[fresh.length - 1] });
    for (const k of fresh.slice(0, -1)) silent.push({ userId: r.userId, badgeKey: k });
  }
  return { awards, silent };
}

// ── "Brought by" ───────────────────────────────────────────────────────

/** The referrer's name on the friend's FIRST game (first name and last
 *  initial), or null: not his first game, no kept referral, or private. */
export function broughtByName(a: {
  firstGame: boolean;
  referrer: { displayName: string; status: string; showRecognition: boolean } | null;
}): string | null {
  if (!a.firstGame || !a.referrer || !recognitionShown(a.referrer)) return null;
  return referrerShownName(a.referrer);
}
