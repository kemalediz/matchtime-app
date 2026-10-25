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
 * Cap (rules.ts POOL_SIGNUP): sign-up ATTEMPTS per requesting address per
 * hour, whatever their result, counted before the area is placed, because
 * placing a district may cost a paid geocoding call. Old waiting sign-ups
 * and attempts are deleted by the daily housekeeping (`housekeeping.ts`).
 *
 * STARTED BY A SIGNED-IN MEMBER (slice L3, `member-optin.ts`): a member
 * whose account has no phone number takes this same step from his profile.
 * The waiting row then carries his user id and the source "profile"; a
 * number no account holds that sends the code is only recorded as a claim
 * he answers on his page (`confirm.ts`, `member-claim.ts`); `ip` is then
 * his key (`member:<id>`), not an address.
 */
import { db } from "../db";
import { generatePoolConfirmCode, poolCodeExpiry } from "./confirm-rules";
import type { PoolFields } from "./profile-fields";
import { availabilityRows, resolveArea, sportRows } from "./profile-store";
import { POOL_SIGNUP } from "./rules";
import type { PoolProfileSource, PoolSignupAttemptResult } from "./vocab";

export type PoolSignupResult =
  | { ok: true; code: string; earlyList: boolean }
  | { ok: false; reason: "busy" | "area-not-found" };

export async function createPoolSignup(args: {
  fields: PoolFields;
  ip: string | null;
  source: { campaignCode: string | null; referralCode: string | null };
  earlyList: boolean;
  /** Slice L3: the signed-in member (with no phone) who started it. */
  startedByUserId?: string;
  now?: Date;
}): Promise<PoolSignupResult> {
  const now = args.now ?? new Date();
  const ip = args.ip;

  if (ip) {
    const fromIp = await db.poolAttempt.count({
      where: { kind: "signup", key: ip, createdAt: { gte: new Date(now.getTime() - 3600_000) } },
    });
    if (fromIp >= POOL_SIGNUP.perIpPerHour) return { ok: false, reason: "busy" };
  }
  const attempt = (result: PoolSignupAttemptResult) => (ip ? db.poolAttempt.create({ data: { kind: "signup", key: ip, result } }) : null);

  const area = await resolveArea(args.fields);
  if (!area.ok) {
    await attempt(area.reason);
    return { ok: false, reason: area.reason };
  }
  await attempt("created");

  const source = args.startedByUserId
    ? { source: "profile" as const, sourceCode: null, referrerUserId: null }
    : await resolveSource(args.source);
  const f = args.fields;

  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generatePoolConfirmCode();
    try {
      await db.poolProfile.create({
        data: {
          status: "pending-verify",
          userId: args.startedByUserId ?? null,
          confirmCode: code,
          confirmCodeExpiresAt: poolCodeExpiry(now),
          signupIp: args.ip,
          adultConfirmedAt: now,
          language: f.language,
          displayName: f.displayName,
          areaDistrict: area.areaDistrict,
          areaLat: area.areaLat,
          areaLng: area.areaLng,
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
      // Another waiting sign-up holds this code: draw again. (His user id
      // taken meanwhile, by a second tap, is not a code clash.)
      const target = (err as { meta?: { target?: unknown } })?.meta?.target;
      if ((err as { code?: string })?.code === "P2002" && args.startedByUserId && String(target ?? "").includes("userId")) return { ok: false, reason: "busy" };
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
