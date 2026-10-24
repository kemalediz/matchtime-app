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
 * for the 12-month rule, plan 3.3).
 */
import { db } from "../db";
import { normaliseLang, type Lang } from "../i18n/lang";
import { canEraseUser, manageTransition, type ManageAction, type ManageRefusal } from "./manage-rules";
import type { PoolFields } from "./profile-fields";
import { availabilityRows, loadPoolVenues, resolveArea, sportRows, type PoolVenueOption } from "./profile-store";
import { formatMinutes } from "./rules";
import type { SportLevel, PoolSportChoiceKey } from "./sports";
import type { PoolPauseReason, PoolProfileStatus } from "./vocab";

/** The profile as the manage page shows and edits it. */
export interface PoolManageView {
  status: PoolProfileStatus;
  pausedReason: PoolPauseReason | null;
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

export async function loadPoolManageView(userId: string): Promise<PoolManageView | null> {
  const p = await db.poolProfile.findUnique({
    where: { userId },
    select: {
      status: true,
      pausedReason: true,
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
  return {
    status: p.status as PoolProfileStatus,
    pausedReason: p.pausedReason as PoolPauseReason | null,
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

/** Pause, resume, stop offers, or start again (with the consent ticked). */
export async function applyManageAction(
  userId: string,
  action: ManageAction,
  opts: { consent?: boolean; now?: Date } = {},
): Promise<PoolManageResult> {
  const now = opts.now ?? new Date();
  const p = await db.poolProfile.findUnique({ where: { userId }, select: { id: true, status: true, pausedReason: true } });
  if (!p || p.status === "pending-verify") return { ok: false, reason: "no-profile" };
  const t = manageTransition({
    action,
    profile: { status: p.status as PoolProfileStatus, pausedReason: p.pausedReason as PoolPauseReason | null },
    now,
    consent: opts.consent,
    // A consent given on the page: the signed-in person, and when.
    evidence: `web:${userId}:${now.getTime()}`,
  });
  if (!t.ok) return t;
  // Compare-and-set on the state the rule read, so two taps cannot cross.
  const { count } = await db.poolProfile.updateMany({ where: { id: p.id, status: p.status }, data: t.patch });
  return count === 1 ? { ok: true } : { ok: false, reason: "no-profile" };
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
 * too only when he has no club and no history (`canEraseUser`). The offer,
 * block and consent records the policy keeps after a deletion carry no
 * foreign key and stay (decision log #14, L0.3).
 */
export async function deletePoolProfile(userId: string): Promise<{ ok: true; userErased: boolean } | { ok: false; reason: "no-profile" }> {
  return db.$transaction(async (tx) => {
    const { count } = await tx.poolProfile.deleteMany({ where: { userId } });
    if (count === 0) return { ok: false as const, reason: "no-profile" as const };
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
