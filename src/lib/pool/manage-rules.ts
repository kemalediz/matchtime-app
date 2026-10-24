/**
 * THE MANAGE PAGE'S SWITCHES (slice L2, 2026-10-24). PURE.
 *
 * Each switch is a state change on the profile, and the patch it returns
 * is exactly what the database row becomes, so it always satisfies the
 * CHECKs (a paused profile says why and since when; a stopped one since
 * when; a confirmed one carries its consent). `manage.ts` writes it.
 *
 *   pause     active -> paused ("self")
 *   resume    paused -> active, for his own pause or the 3-ignored pause
 *             ("until they say they want more") at once, and for the
 *             no-show pause 30 days after it began (slice L7,
 *             `reliability-rules.ts` `selfResumeFrom`); a pause after
 *             reports or by the owner is not his to lift (he can ask a
 *             person to look at it)
 *   stop      active or paused -> stopped: consent withdrawn. A pause
 *             MatchTime decided (no-shows, reports, the owner) STAYS on the
 *             row (slice L7; the CHECK allows it on a stopped profile), so
 *             stopping and starting again cannot lift it
 *   restart   stopped -> active, or back to that pause, with the consent
 *             ticked again on the page: a fresh consent, recorded as given
 *             on the web
 */
import { POOL_CONSENT_VERSION } from "./rules";
import { MATCHTIME_PAUSE_REASONS, selfResumeFrom } from "./reliability-rules";
import type { PoolPauseReason, PoolProfileStatus } from "./vocab";

export type ManageAction = "pause" | "resume" | "stop" | "restart";

export interface ManageProfileState {
  status: PoolProfileStatus;
  pausedReason: PoolPauseReason | null;
  /** When the pause began; needed to lift a no-show pause. */
  pausedAt?: Date | null;
}

export type ManageRefusal = "not-active" | "not-paused" | "paused-by-matchtime" | "not-yet" | "not-stopped" | "consent-required";

export type ManagePatch = Partial<{
  status: PoolProfileStatus;
  pausedReason: PoolPauseReason | null;
  pausedAt: Date | null;
  stoppedAt: Date | null;
  consentAt: Date;
  consentVersion: number;
  consentChannel: "web";
  consentEvidence: string;
  reviewRequestedAt: Date | null;
  lastActiveAt: Date;
}>;

const keepsPause = (p: ManageProfileState) => !!p.pausedReason && MATCHTIME_PAUSE_REASONS.includes(p.pausedReason);

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
      const from = profile.pausedReason ? selfResumeFrom({ reason: profile.pausedReason, pausedAt: profile.pausedAt ?? null }) : null;
      if (!from) return { ok: false, reason: "paused-by-matchtime" };
      if (now.getTime() < from.getTime()) return { ok: false, reason: "not-yet" };
      return {
        ok: true,
        patch: keepsPause(profile)
          ? { status: "active", pausedReason: null, pausedAt: null, reviewRequestedAt: null, lastActiveAt: now }
          : { status: "active", pausedReason: null, pausedAt: null, lastActiveAt: now },
      };
    case "stop":
      if (profile.status !== "active" && profile.status !== "paused") return { ok: false, reason: "not-active" };
      if (keepsPause(profile)) return { ok: true, patch: { status: "stopped", stoppedAt: now, lastActiveAt: now } };
      return { ok: true, patch: { status: "stopped", stoppedAt: now, pausedReason: null, pausedAt: null, lastActiveAt: now } };
    case "restart":
      if (profile.status !== "stopped") return { ok: false, reason: "not-stopped" };
      if (args.consent !== true || !args.evidence) return { ok: false, reason: "consent-required" };
      return {
        ok: true,
        patch: {
          status: keepsPause(profile) ? "paused" : "active",
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
