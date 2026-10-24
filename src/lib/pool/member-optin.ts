/**
 * "PLAY ELSEWHERE" ON A MEMBER'S PROFILE, server side (slice L3,
 * 2026-10-24): the thin I/O half of `member-prefill.ts`. Every call is for
 * the SIGNED-IN person (the caller passes the session's user id).
 *
 *   loadPlayElsewhere       what the card shows: his way in
 *                           (`memberOptInPath`) and the form's starting
 *                           values from his clubs (`memberPrefill`)
 *   joinPoolAsMember        a member WITH a number on his account: the
 *                           profile is written active at once, with the
 *                           consent he ticked (channel "web") and a row in
 *                           the append-only consent record, in one
 *                           transaction
 *   startMemberWhatsAppStep a member with NO number: the /play sign-up
 *                           itself (`createPoolSignup`), marked as started
 *                           by him. A number no account holds that sends the
 *                           code attaches NOTHING: he is asked on this card
 *                           whether it is his (`member-claim.ts`)
 *
 * His clubs: live memberships that are not a guest place (`guestMatchId`
 * set), their active weekly games with sport and venue, and the club's home
 * venue. Members are never offered their own club's games: that is the
 * matcher's rule (L4 `candidates.ts`), not this card's.
 */
import { db } from "../db";
import { recordPoolConsent } from "./consent-record";
import { memberJoinConsent, memberOptInPath, memberPrefill, type MemberClubFacts, type MemberOptInPath, type MemberPrefill } from "./member-prefill";
import type { PoolFields } from "./profile-fields";
import { availabilityRows, resolveArea, sportRows } from "./profile-store";
import { POOL_SIGNUP } from "./rules";
import { createPoolSignup } from "./signup";
import type { PoolProfileStatus } from "./vocab";

export interface PlayElsewhereView {
  path: MemberOptInPath;
  prefill: MemberPrefill;
  /** While he is waiting to send the WhatsApp message: his code. */
  pendingCode: string | null;
  earlyList: boolean;
}

const VENUE = { select: { id: true, name: true, formattedAddress: true, lat: true, lng: true } } as const;
const venueFact = (v: { id: string; name: string; formattedAddress: string | null; lat: number | null; lng: number | null } | null) =>
  v ? { id: v.id, name: v.name, address: v.formattedAddress, lat: v.lat, lng: v.lng } : null;

async function memberClubs(userId: string): Promise<MemberClubFacts[]> {
  const rows = await db.membership.findMany({
    where: { userId, leftAt: null, guestMatchId: null },
    orderBy: { createdAt: "asc" },
    select: {
      org: {
        select: {
          language: true,
          homeVenue: VENUE,
          activities: {
            where: { isActive: true },
            orderBy: [{ dayOfWeek: "asc" }, { time: "asc" }],
            select: {
              dayOfWeek: true,
              time: true,
              matchDurationMins: true,
              sport: { select: { preset: true, name: true, playersPerTeam: true } },
              venueRef: VENUE,
            },
          },
        },
      },
    },
  });
  return rows.map(({ org }) => ({
    language: org.language,
    homeVenue: venueFact(org.homeVenue),
    activities: org.activities.map((a) => ({
      dayOfWeek: a.dayOfWeek,
      time: a.time,
      matchDurationMins: a.matchDurationMins,
      sport: a.sport,
      venue: venueFact(a.venueRef),
    })),
  }));
}

export async function loadPlayElsewhere(userId: string, opts: { earlyList: boolean; now?: Date }): Promise<PlayElsewhereView | null> {
  const now = opts.now ?? new Date();
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { name: true, phoneNumber: true, poolProfile: { select: { status: true, confirmCode: true, confirmCodeExpiresAt: true, claimPhone: true } } },
  });
  if (!user) return null;
  const p = user.poolProfile;
  // A waiting sign-up whose code has run out is no longer a way in.
  const live = p && !(p.status === "pending-verify" && (!p.confirmCode || (p.confirmCodeExpiresAt && p.confirmCodeExpiresAt <= now))) ? p : null;
  const path = memberOptInPath({ hasPhone: !!user.phoneNumber, profile: live ? { status: live.status as PoolProfileStatus, claimPhone: live.claimPhone } : null });
  return {
    path,
    prefill: memberPrefill({ name: user.name, clubs: await memberClubs(userId) }),
    pendingCode: path.kind === "waiting-whatsapp" ? (live?.confirmCode ?? null) : null,
    earlyList: opts.earlyList,
  };
}

export type MemberJoinResult =
  | { ok: true }
  | { ok: false; reason: "no-user" | "needs-whatsapp" | "already-in-pool" | "busy" | "area-not-found" | "venues-unknown" };

/**
 * The sign-up cap's key for a signed-in member (rules.ts POOL_SIGNUP
 * perIpPerHour): him, not his address. On the WhatsApp step it is also
 * what `createPoolSignup` keeps in `signupIp` until the code is used.
 */
export function memberAttemptKey(userId: string): string {
  return `member:${userId}`;
}

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === "P2002";

/** A member with a number joins, active at once. */
export async function joinPoolAsMember(userId: string, fields: PoolFields, opts: { earlyList: boolean; now?: Date }): Promise<MemberJoinResult> {
  const now = opts.now ?? new Date();
  const user = await db.user.findUnique({ where: { id: userId }, select: { phoneNumber: true, poolProfile: { select: { id: true, status: true } } } });
  if (!user) return { ok: false, reason: "no-user" };
  if (!user.phoneNumber) return { ok: false, reason: "needs-whatsapp" };
  if (user.poolProfile && user.poolProfile.status !== "pending-verify") return { ok: false, reason: "already-in-pool" };
  // The /play cap on placing an area (it may cost a paid lookup), keyed by
  // him rather than by an address.
  const key = memberAttemptKey(userId);
  const tries = await db.poolAttempt.count({ where: { kind: "signup", key, createdAt: { gte: new Date(now.getTime() - 3600_000) } } });
  if (tries >= POOL_SIGNUP.perIpPerHour) return { ok: false, reason: "busy" };
  const area = await resolveArea(fields);
  await db.poolAttempt.create({ data: { kind: "signup", key, result: area.ok ? "created" : area.reason } });
  if (!area.ok) return { ok: false, reason: area.reason };
  const consent = memberJoinConsent(userId, now);
  try {
    await db.$transaction(async (tx) => {
      // A WhatsApp step he started before his account had a number.
      await tx.poolProfile.deleteMany({ where: { userId, status: "pending-verify" } });
      await tx.poolProfile.create({
        data: {
          userId,
          status: "active",
          ...consent,
          language: fields.language,
          displayName: fields.displayName,
          areaDistrict: area.areaDistrict,
          areaLat: area.areaLat,
          areaLng: area.areaLng,
          venueIds: area.venueIds,
          maxMiles: fields.maxMiles,
          earlyList: opts.earlyList,
          source: "profile",
          lastActiveAt: now,
          sports: { create: sportRows(fields) },
          availability: { create: availabilityRows(fields) },
        },
        select: { id: true },
      });
      await recordPoolConsent(tx, {
        userId,
        action: "consent",
        channel: "web",
        evidence: consent.consentEvidence,
        version: consent.consentVersion,
        phone: user.phoneNumber!.replace(/^\+/, ""),
        at: now,
      });
    });
  } catch (err) {
    // Two taps at once: the other one made his profile.
    if (isUniqueViolation(err)) return { ok: false, reason: "already-in-pool" };
    throw err;
  }
  console.log(`[pool-member] joined from profile early=${opts.earlyList}`);
  return { ok: true };
}

export type MemberWhatsAppResult =
  | { ok: true; code: string; earlyList: boolean }
  | { ok: false; reason: "no-user" | "has-phone" | "already-in-pool" | "busy" | "area-not-found" | "venues-unknown" };

/** A member with no number: the /play sign-up, started by him. */
export async function startMemberWhatsAppStep(userId: string, fields: PoolFields, opts: { earlyList: boolean; now?: Date }): Promise<MemberWhatsAppResult> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { phoneNumber: true, poolProfile: { select: { status: true } } } });
  if (!user) return { ok: false, reason: "no-user" };
  if (user.phoneNumber) return { ok: false, reason: "has-phone" };
  if (user.poolProfile && user.poolProfile.status !== "pending-verify") return { ok: false, reason: "already-in-pool" };
  // Starting again replaces the code he has not sent.
  await db.poolProfile.deleteMany({ where: { userId, status: "pending-verify" } });
  return createPoolSignup({ fields, ip: memberAttemptKey(userId), source: { campaignCode: null, referralCode: null }, earlyList: opts.earlyList, startedByUserId: userId, now: opts.now });
}
