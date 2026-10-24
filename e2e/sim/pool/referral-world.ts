/**
 * THE POOL SCENARIO DSL FOR REFERRAL BADGES AND "BROUGHT BY" (growth slice
 * G4, 2026-10-24). Helpers on top of `offers-world.ts` and
 * `safety-world.ts`, in their own file so no other slice's lines change.
 *
 *   await referrerProfile(pool, fnf.member("pete"));              // Pete is in the pool
 *   const bea = await referredFriend(pool, "bea", pete, { at: near(sutton) });
 *   const sent = await friendTakesPlace(pool, page, sutton, bea);  // the organisers' notice
 *   await clubPlayedDaysAgo(pool, fnf, 3);                          // fnf has a post due
 *   await runCompleteMatches(pool, { now: new Date() });            // the friend's game counts
 *   const post = await badgesPost(pool, fnf);                       // the club's badges post
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { badgesPostAt, badgesPostKey } from "@/lib/badge-announcements";
import { nextMsgId } from "../group";
import { organiserAsks, poolPlayer, pollPlatform, tapLinkIn, tapOffer, at, type Spot } from "./offers-world";
import type { SentMessage } from "./transcript";
import type { PoolClub, PoolPerson, PoolWorld } from "./world";

type Club = PoolClub & { kickoff: Date; spot: Spot };

/** A club member's pool profile, as L3's opt-in leaves it (his privacy switch as given). */
export async function referrerProfile(world: PoolWorld, who: PoolPerson, opts: { showRecognition?: boolean; status?: "active" | "stopped"; displayName?: string } = {}): Promise<{ userId: string }> {
  const user = await world.userOf(who);
  if (!user) throw new Error(`no user for ${who.key}`);
  const id = `sim-ref-p-${who.key}-${nextMsgId()}`;
  const status = opts.status ?? "active";
  await world.db.run(
    `INSERT INTO "PoolProfile" (id, "userId", status, "stoppedAt", "consentAt", "consentVersion", "consentChannel", "consentEvidence", "adultConfirmedAt", language,
       "displayName", "areaDistrict", "areaLat", "areaLng", "maxMiles", source, "showRecognition", "updatedAt")
     VALUES ($1, $2, $3, $4, now(), 1, 'web', 'profile', now(), 'en', $5, 'SM3', 51.36, -0.19, 3, 'profile', $6, now())`,
    [id, user.id, status, status === "stopped" ? new Date() : null, opts.displayName ?? who.name ?? who.key, opts.showRecognition !== false],
  );
  return { userId: user.id };
}

/** Someone in the pool who signed up through `referrer`'s share link (G1 kept the referral). */
export async function referredFriend(world: PoolWorld, key: string, referrer: { userId: string }, opts: { at: Spot; name?: string; lang?: "en" | "tr" }) {
  const p = await poolPlayer(world, key, { at: opts.at, name: opts.name, lang: opts.lang });
  await world.db.run(`UPDATE "PoolProfile" SET source = 'referral', "sourceCode" = 'SIMREF', "referrerUserId" = $2 WHERE "userId" = $1`, [p.userId, referrer.userId]);
  world.note(`(${key} signed up through a friend's link)`);
  return p;
}

/** The organisers ask the pool for one place and the friend says yes: everything MatchTime sent meanwhile. */
export async function friendTakesPlace(world: PoolWorld, page: Page, club: Club, friend: PoolPerson & { userId: string }): Promise<SentMessage[]> {
  const now = at(club.kickoff, -8);
  const ex = await organiserAsks(world, page, club, { places: 1, now });
  await pollPlatform(world, { now });
  const offer = ex.sent.find((m) => m.to === friend.key && m.purpose === "pool-offer");
  if (!offer) throw new Error(`no offer to ${friend.key}: ${ex.sent.map((m) => `${m.to}:${m.purpose}`).join(", ")}`);
  expect(await tapOffer(world, page, tapLinkIn(offer), "yes")).toBe("in");
  return world.collect();
}

/** The club's match kicked off `days` days ago (real clock), with `confirmed` on it. Returns the kickoff. */
export async function clubPlayedDaysAgo(world: PoolWorld, club: PoolClub, days: number, confirmed: PoolPerson[] = []): Promise<Date> {
  const kickoff = new Date(Date.now() - days * 24 * 3600_000);
  await world.db.run(`UPDATE "Match" SET date = $2, "attendanceDeadline" = $2 WHERE id = $1`, [club.group.matchId, kickoff]);
  for (const p of confirmed) {
    const u = await world.userOf(p);
    await world.db.run(
      `INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, 'CONFIRMED', 1, now())
       ON CONFLICT ("matchId", "userId") DO UPDATE SET status = 'CONFIRMED'`,
      [`sim-ref-att-${nextMsgId()}`, club.group.matchId, u!.id],
    );
  }
  world.note(`(${club.key}'s game kicked off ${days} days ago)`);
  return kickoff;
}

/** Make `who` an ordinary member of `club` too. */
export async function alsoMemberOf(world: PoolWorld, club: PoolClub, who: PoolPerson): Promise<void> {
  const u = await world.userOf(who);
  await world.db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, 'PLAYER')`, [`sim-ref-m-${nextMsgId()}`, u!.id, club.group.orgId]);
}

/** The Pi's scheduler poll for the club in its badges window (claimed, as the Pi does). The badges post, if any. */
export async function badgesPost(world: PoolWorld, club: PoolClub, opts: { evening?: number; minute?: number } = {}): Promise<{ text: string } | undefined> {
  const m = await world.db.one<{ date: Date }>(`SELECT date FROM "Match" WHERE id = $1`, [club.group.matchId]);
  const now = new Date(badgesPostAt(m!.date).getTime() + (opts.evening ?? 0) * 24 * 3600_000 + (30 + (opts.minute ?? 0)) * 60_000);
  world.note(`(the scheduler polls ${club.key} at ${now.toISOString()})`);
  const ins = await club.group.duePosts(now, { claim: true });
  const post = ins.find((i) => i.key === badgesPostKey(club.group.matchId!));
  if (post?.text) world.note(`MatchTime -> ${club.key}.group (group, badges): ${post.text}`);
  return post?.text ? { text: post.text } : undefined;
}

export function referralLedger(world: PoolWorld, userId: string): Promise<Array<{ orgId: string; badgeKey: string }>> {
  return world.db.all(`SELECT "orgId", "badgeKey" FROM "BadgeAnnouncement" WHERE "userId" = $1 AND "badgeKey" IN ('recruiter', 'scout', 'talent-spotter') ORDER BY "badgeKey"`, [userId]);
}
