/**
 * THE MANAGE PAGE'S SWITCHES (slice L2, 2026-10-24). PURE.
 *
 * Each switch is a state change on the profile, and the patch it returns
 * is exactly what the database row becomes, so it always satisfies the
 * CHECKs (a paused profile says why and since when; a stopped one since
 * when; a confirmed one carries its consent). `manage.ts` writes it.
 *
 *   pause     active -> paused ("self")
 *   resume    paused -> active, only for his own pause or the 3-ignored
 *             pause ("until they say they want more"); a pause MatchTime
 *             decided (no-shows, reports, the owner) is not his to lift
 *   stop      active or paused -> stopped: consent withdrawn
 *   restart   stopped -> active, with the consent ticked again on the
 *             page: a fresh consent, recorded as given on the web
 *
 * KNOWN GAP for L7: `stop` clears the pause reason (the CHECK allows a
 * reason only while paused), so a profile paused for no-shows that is
 * stopped and restarted comes back active. Nothing pauses for no-shows,
 * reports or the owner until L7, which must keep that reason across a stop.
 */
import { POOL_CONSENT_VERSION } from "./rules";
import type { PoolPauseReason, PoolProfileStatus } from "./vocab";

export type ManageAction = "pause" | "resume" | "stop" | "restart";

export interface ManageProfileState {
  status: PoolProfileStatus;
  pausedReason: PoolPauseReason | null;
}

export type ManageRefusal = "not-active" | "not-paused" | "paused-by-matchtime" | "not-stopped" | "consent-required";

export type ManagePatch = Partial<{
  status: PoolProfileStatus;
  pausedReason: PoolPauseReason | null;
  pausedAt: Date | null;
  stoppedAt: Date | null;
  consentAt: Date;
  consentVersion: number;
  consentChannel: "web";
  consentEvidence: string;
  lastActiveAt: Date;
}>;

const SELF_RESUMABLE: readonly PoolPauseReason[] = ["self", "ignored"];

export function manageTransition(args: {
  action: ManageAction;
  profile: ManageProfileState;
  now: Date;
  consent?: boolean;
  /** For `restart`: what proves the consent (the signed-in request). */
  evidence?: string;
}): { ok: true; patch: ManagePatch } | { ok: false; reason: ManageRefusal } {
  const { profile, now } = args;
  switch (args.action) {
    case "pause":
      if (profile.status !== "active") return { ok: false, reason: "not-active" };
      return { ok: true, patch: { status: "paused", pausedReason: "self", pausedAt: now, lastActiveAt: now } };
    case "resume":
      if (profile.status !== "paused") return { ok: false, reason: "not-paused" };
      if (!profile.pausedReason || !SELF_RESUMABLE.includes(profile.pausedReason)) return { ok: false, reason: "paused-by-matchtime" };
      return { ok: true, patch: { status: "active", pausedReason: null, pausedAt: null, lastActiveAt: now } };
    case "stop":
      if (profile.status !== "active" && profile.status !== "paused") return { ok: false, reason: "not-active" };
      return { ok: true, patch: { status: "stopped", stoppedAt: now, pausedReason: null, pausedAt: null, lastActiveAt: now } };
    case "restart":
      if (profile.status !== "stopped") return { ok: false, reason: "not-stopped" };
      if (args.consent !== true || !args.evidence) return { ok: false, reason: "consent-required" };
      return {
        ok: true,
        patch: {
          status: "active",
          stoppedAt: null,
          consentAt: now,
          consentVersion: POOL_CONSENT_VERSION,
          consentChannel: "web",
          consentEvidence: args.evidence,
          lastActiveAt: now,
        },
      };
  }
}

/**
 * Deleting a pool profile erases his User row too only when nothing else
 * is his: no membership of any club (current or left), no attendance
 * anywhere, no guest game. Then he was only ever a pool sign-up (plan 3.3).
 * Otherwise the club history stays with the clubs, as for any past guest.
 */
export function canEraseUser(c: { memberships: number; attendances: number; guestPlaces: number; isSuperadmin: boolean }): boolean {
  return !c.isSuperadmin && c.memberships === 0 && c.attendances === 0 && c.guestPlaces === 0;
}
