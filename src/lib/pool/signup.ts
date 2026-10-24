/**
 * THE /play SIGN-UP, server side (slice L2, 2026-10-24). The thin I/O half
 * of `profile-fields.ts` (validation) and `confirm-rules.ts` (the code).
 *
 * Writes ONE waiting profile ("pending-verify", no user, no consent yet),
 * its sports and its days and hours, with a fresh code. Nothing is live and
 * nobody is messaged: the person's own WhatsApp message carrying the code
 * (`confirm.ts`) is what makes it live, finds or creates his User by the
 * number that sent it, and records his consent. The page never asks for a
 * phone number, so there is nothing to mistype and nothing to cold-message.
 *
 * Caps (rules.ts POOL_SIGNUP): sign-ups per requesting address per hour.
 * Housekeeping on the way: waiting sign-ups whose code expired long ago,
 * and old failed confirm attempts, are deleted.
 */
import { db } from "../db";
import { attemptPurgeBefore, generatePoolConfirmCode, poolCodeExpiry } from "./confirm-rules";
import type { PoolFields } from "./profile-fields";
import { availabilityRows, resolveArea, sportRows } from "./profile-store";
import { POOL_SIGNUP } from "./rules";
import type { PoolProfileSource } from "./vocab";

const DAY_MS = 24 * 60 * 60 * 1000;

export type PoolSignupResult =
  | { ok: true; code: string; earlyList: boolean }
  | { ok: false; reason: "busy" | "area-not-found" | "venues-unknown" };

export async function createPoolSignup(args: {
  fields: PoolFields;
  ip: string | null;
  source: { campaignCode: string | null; referralCode: string | null };
  earlyList: boolean;
  now?: Date;
}): Promise<PoolSignupResult> {
  const now = args.now ?? new Date();
  await housekeeping(now);

  if (args.ip) {
    const fromIp = await db.poolProfile.count({
      where: { signupIp: args.ip, status: "pending-verify", createdAt: { gte: new Date(now.getTime() - 3600_000) } },
    });
    if (fromIp >= POOL_SIGNUP.perIpPerHour) return { ok: false, reason: "busy" };
  }

  const area = await resolveArea(args.fields);
  if (!area.ok) return { ok: false, reason: area.reason };

  const source = await resolveSource(args.source);
  const f = args.fields;

  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generatePoolConfirmCode();
    try {
      await db.poolProfile.create({
        data: {
          status: "pending-verify",
          confirmCode: code,
          confirmCodeExpiresAt: poolCodeExpiry(now),
          signupIp: args.ip,
          adultConfirmedAt: now,
          language: f.language,
          displayName: f.displayName,
          areaDistrict: area.areaDistrict,
          areaLat: area.areaLat,
          areaLng: area.areaLng,
          venueIds: area.venueIds,
          maxMiles: f.maxMiles,
          earlyList: args.earlyList,
          ...source,
          sports: { create: sportRows(f) },
          availability: { create: availabilityRows(f) },
        },
        select: { id: true },
      });
      console.log(`[pool-signup] waiting sign-up created early=${args.earlyList} source=${source.source}`);
      return { ok: true, code, earlyList: args.earlyList };
    } catch (err) {
      // Another waiting sign-up holds this code: draw again.
      if ((err as { code?: string })?.code === "P2002") continue;
      throw err;
    }
  }
  return { ok: false, reason: "busy" };
}

/** Where he came from: a live campaign, a friend's share code, or the web. */
async function resolveSource(s: { campaignCode: string | null; referralCode: string | null }): Promise<{
  source: PoolProfileSource;
  sourceCode: string | null;
  referrerUserId: string | null;
}> {
  if (s.referralCode) {
    const friend = await db.poolProfile.findUnique({ where: { shareCode: s.referralCode }, select: { userId: true } });
    if (friend?.userId) return { source: "referral", sourceCode: s.referralCode, referrerUserId: friend.userId };
  }
  if (s.campaignCode) {
    const campaign = await db.poolCampaign.findFirst({ where: { code: s.campaignCode, active: true }, select: { code: true } });
    if (campaign) return { source: "campaign", sourceCode: campaign.code, referrerUserId: null };
  }
  return { source: "web", sourceCode: null, referrerUserId: null };
}

/** Waiting sign-ups whose code expired long ago go, and so do old failed
 *  confirm attempts. Until then a late message still hears "expired". */
async function housekeeping(now: Date): Promise<void> {
  await db.poolProfile.deleteMany({
    where: { status: "pending-verify", confirmCodeExpiresAt: { lt: new Date(now.getTime() - POOL_SIGNUP.purgePendingAfterDays * DAY_MS) } },
  });
  await db.poolConfirmAttempt.deleteMany({ where: { createdAt: { lt: attemptPurgeBefore(now) } } });
}
