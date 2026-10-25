/**
 * THE MANAGE PAGE, server side (slice L2, 2026-10-24): the thin I/O half of
 * `manage-rules.ts` (the switches) and `profile-fields.ts` (the edit). Every
 * call is for the signed-in person's OWN profile: the caller passes the
 * session's user id, never one from the request.
 *
 *   loadPoolManageView   what the page shows
 *   savePoolFields       edit everything the sign-up asked
 *   applyManageAction    pause, resume, stop offers, start again
 *   setShowRecognition   the badge and "Brought by" privacy switch
 *   deletePoolProfile    erase the profile; the User too when he is only a
 *                        pool sign-up (`canEraseUser`, plan 3.3)
 *
 * Every write stamps `lastActiveAt` (a visit to the manage page is activity
 * for the 12-month rule, plan 3.3). Stop, start again and delete each add a
 * row to the append-only consent record (`consent-record.ts`), in the same
 * transaction as the change.
 */
import { db } from "../db";
import { withdrawInvitationsForConsent } from "./club-invitation";
import { normaliseLang, type Lang } from "../i18n/lang";
import { recordPoolConsent } from "./consent-record";
import { canEraseUser, manageTransition, type ManageAction, type ManageRefusal } from "./manage-rules";
import type { PoolFields } from "./profile-fields";
import { availabilityRows, loadPoolVenues, resolveArea, sportRows, type PoolVenueOption } from "./profile-store";
import { formatMinutes } from "./rules";
import { loadOwnTurnUp, loadPlayerClubs, ownResumeFrom, stampSafetyRecordsGone } from "./safety";
import type { TurnUpRecord } from "./turn-up";
import { sportChoiceKey, type SportLevel, type PoolSportChoiceKey } from "./sports";
import type { PoolPauseReason, PoolProfileStatus } from "./vocab";

/** The profile as the manage page shows and edits it. */
export interface PoolManageView {
  status: PoolProfileStatus;
  pausedReason: PoolPauseReason | null;
  /** Slice L7: when he may lift his pause himself (ISO), or null for never. */
  resumeFrom: string | null;
  /** He may lift his pause himself now (the server's clock). */
  canResume: boolean;
  /** He asked a person to look at a pause MatchTime decided. */
  reviewRequested: boolean;
  /** His turn-up record across every club, counts only. */
  record: TurnUpRecord;
  /** Clubs that offered him a game or had him as a guest, and his blocks. */
  clubs: { orgId: string; name: string; blocked: boolean }[];
  earlyList: boolean;
  showRecognition: boolean;
  consentAt: string | null;
  consentVersion: number | null;
  fields: {
    name: string;
    area: { kind: "district"; district: string } | { kind: "venues"; venueIds: string[] };
    venues: PoolVenueOption[];
    maxMiles: number;
    availability: Array<{ day: number; from: string; to: string }>;
    sports: Array<{ sport: PoolSportChoiceKey; otherName: string; formats: number[]; level: SportLevel | null; levelText: string | null }>;
    language: Lang;
  };
}

export async function loadPoolManageView(userId: string, now: Date = new Date()): Promise<PoolManageView | null> {
  const p = await db.poolProfile.findUnique({
    where: { userId },
    select: {
      status: true,
      pausedReason: true,
      pausedAt: true,
      reviewRequestedAt: true,
      earlyList: true,
      showRecognition: true,
      consentAt: true,
      consentVersion: true,
      displayName: true,
      areaDistrict: true,
      venueIds: true,
      maxMiles: true,
      language: true,
      sports: { select: { sport: true, otherName: true, formats: true, level: true, levelText: true }, orderBy: { id: "asc" } },
      availability: { select: { day: true, fromMin: true, toMin: true }, orderBy: [{ day: "asc" }, { fromMin: "asc" }] },
    },
  });
  if (!p || p.status === "pending-verify") return null;
  const [record, clubs] = await Promise.all([loadOwnTurnUp(userId), loadPlayerClubs(userId)]);
  const pausedReason = p.pausedReason as PoolPauseReason | null;
  const resumeFrom = p.status === "paused" ? ownResumeFrom({ pausedReason, pausedAt: p.pausedAt }) : null;
  return {
    status: p.status as PoolProfileStatus,
    pausedReason,
    resumeFrom: resumeFrom?.toISOString() ?? null,
    canResume: !!resumeFrom && resumeFrom.getTime() <= now.getTime(),
    reviewRequested: p.reviewRequestedAt !== null,
    record,
    clubs,
    earlyList: p.earlyList,
    showRecognition: p.showRecognition,
    consentAt: p.consentAt?.toISOString() ?? null,
    consentVersion: p.consentVersion,
    fields: {
      name: p.displayName,
      area: p.areaDistrict ? { kind: "district", district: p.areaDistrict } : { kind: "venues", venueIds: p.venueIds },
      venues: await loadPoolVenues(p.venueIds),
      maxMiles: p.maxMiles,
      availability: p.availability.map((a) => ({ day: a.day, from: formatMinutes(a.fromMin), to: formatMinutes(a.toMin) })),
      sports: p.sports.map((s) => ({
        sport: s.sport as PoolSportChoiceKey,
        otherName: s.otherName,
        formats: s.formats,
        level: s.level as SportLevel | null,
        levelText: s.levelText,
      })),
      language: normaliseLang(p.language),
    },
  };
}

/** The `sportChoiceKey`s on his profile: a sport no longer live that he
 *  already has stays saveable (profile-fields.ts `keep`). */
export async function savedPoolSportKeys(userId: string): Promise<string[]> {
  const rows = await db.poolSport.findMany({ where: { profile: { userId } }, select: { sport: true, otherName: true } });
  return rows.map(sportChoiceKey);
}

export type PoolManageResult = { ok: true } | { ok: false; reason: ManageRefusal | "no-profile" | "area-not-found" | "venues-unknown" };

/** Replace everything the sign-up asked with the edited fields. */
export async function savePoolFields(userId: string, fields: PoolFields, now: Date = new Date()): Promise<PoolManageResult> {
  const current = await db.poolProfile.findUnique({
    where: { userId },
    select: { id: true, status: true, areaDistrict: true, areaLat: true, areaLng: true },
  });
  if (!current || current.status === "pending-verify") return { ok: false, reason: "no-profile" };
  const area = await resolveArea(fields, current);
  if (!area.ok) return { ok: false, reason: area.reason };
  await db.$transaction([
    db.poolSport.deleteMany({ where: { profileId: current.id } }),
    db.poolAvailability.deleteMany({ where: { profileId: current.id } }),
    db.poolProfile.update({
      where: { id: current.id },
      data: {
        displayName: fields.displayName,
        areaDistrict: area.areaDistrict,
        areaLat: area.areaLat,
        areaLng: area.areaLng,
        venueIds: area.venueIds,
        maxMiles: fields.maxMiles,
        language: fields.language,
        lastActiveAt: now,
        sports: { create: sportRows(fields) },
        availability: { create: availabilityRows(fields) },
      },
    }),
  ]);
  return { ok: true };
}

/**
 * Pause, resume, stop offers, or start again (with the consent ticked).
 * `via`: the manage page (the default: the signed-in person, and when), or
 * his own WhatsApp message saying stop (slice L6, `reply.ts`: the message
 * id is the evidence, as at the confirm).
 */
export async function applyManageAction(
  userId: string,
  action: ManageAction,
  opts: { consent?: boolean; now?: Date; via?: { channel: "whatsapp"; waMessageId: string } } = {},
): Promise<PoolManageResult> {
  const now = opts.now ?? new Date();
  const p = await db.poolProfile.findUnique({ where: { userId }, select: { id: true, status: true, pausedReason: true, pausedAt: true } });
  if (!p || p.status === "pending-verify") return { ok: false, reason: "no-profile" };
  const channel = opts.via?.channel ?? "web";
  const evidence = opts.via ? `whatsapp:${opts.via.waMessageId}` : `web:${userId}:${now.getTime()}`;
  const t = manageTransition({
    action,
    profile: { status: p.status as PoolProfileStatus, pausedReason: p.pausedReason as PoolPauseReason | null, pausedAt: p.pausedAt },
    now,
    consent: opts.consent,
    evidence,
  });
  if (!t.ok) return t;
  const done = await db.$transaction(async (tx) => {
    // Compare-and-set on the state the rule read, so two taps cannot cross.
    const { count } = await tx.poolProfile.updateMany({ where: { id: p.id, status: p.status, pausedReason: p.pausedReason }, data: t.patch });
    if (count !== 1) return { ok: false as const, reason: "no-profile" as const };
    if (action === "stop") await recordPoolConsent(tx, { userId, action: "withdraw", channel, evidence: `${evidence}:stop`, at: now });
    if (action === "restart") {
      await recordPoolConsent(tx, { userId, action: "consent", channel, evidence, version: t.patch.consentVersion ?? null, at: now });
    }
    return { ok: true as const };
  });
  // A stop withdraws consent: his club invitations close, silently (L8.14).
  if (done.ok && action === "stop") await withdrawInvitations(userId, now);
  return done;
}

async function withdrawInvitations(userId: string, now: Date): Promise<void> {
  try {
    await withdrawInvitationsForConsent(userId, now);
  } catch (err) {
    console.error("[pool-manage] withdrawing club invitations failed:", err instanceof Error ? err.message : "failed");
  }
}

export async function setShowRecognition(userId: string, show: boolean, now: Date = new Date()): Promise<PoolManageResult> {
  const { count } = await db.poolProfile.updateMany({
    where: { userId, status: { not: "pending-verify" } },
    data: { showRecognition: show, lastActiveAt: now },
  });
  return count === 1 ? { ok: true } : { ok: false, reason: "no-profile" };
}

/**
 * Erase his pool profile (its sports and hours cascade). His User row goes
 * too only when he has no club and no history (`canEraseUser`). A
 * withdrawal is added to the consent record first: the consent record
 * (`PoolConsentRecord`), like the offer and block records, carries no
 * foreign key and stays for as long as the privacy policy says (decision
 * log #14, L0.3), however the profile and the User go.
 */
export async function deletePoolProfile(userId: string, now: Date = new Date()): Promise<{ ok: true; userErased: boolean } | { ok: false; reason: "no-profile" }> {
  // Before the delete: an erased User takes his invitations with him, a
  // kept one must not keep them open (L8.14).
  const has = await db.poolProfile.findUnique({ where: { userId }, select: { id: true } });
  if (has) await withdrawInvitations(userId, now);
  return db.$transaction(async (tx) => {
    const { count } = await tx.poolProfile.deleteMany({ where: { userId } });
    if (count === 0) return { ok: false as const, reason: "no-profile" as const };
    await recordPoolConsent(tx, { userId, action: "withdraw", channel: "web", evidence: `web:${userId}:${now.getTime()}:delete`, at: now });
    // Slice L7: his block and report records start their 24 months now.
    await stampSafetyRecordsGone(tx, userId, now);
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { isSuperadmin: true, _count: { select: { memberships: true, attendances: true, guestPlaces: true } } },
    });
    const erase =
      !!user &&
      canEraseUser({
        memberships: user._count.memberships,
        attendances: user._count.attendances,
        guestPlaces: user._count.guestPlaces,
        isSuperadmin: user.isSuperadmin,
      });
    if (erase) await tx.user.delete({ where: { id: userId } });
    console.log(`[pool-manage] profile deleted userErased=${erase}`);
    return { ok: true as const, userErased: erase };
  });
}
