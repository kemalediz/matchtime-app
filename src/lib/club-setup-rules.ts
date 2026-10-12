/**
 * APPROVED BUT SETTING UP: the pure half (2026-10-12, go-live plan 2.1,
 * slice S1). No database import, so pure modules (ai-budget's rule, the
 * silent-group computation) can share the one definition.
 *
 * A club is "setting up" from the moment the platform owner approves it
 * until its organiser says GO. It is APPROVED (`approvalStatus` stays
 * "approved", so everything built on `APPROVED_CLUB_WHERE` keeps working)
 * and it is SILENT: `Organisation.setupStage` is "setting-up", and a CHECK
 * constraint (prisma/sql/org-setup-check.sql) forbids `whatsappBotEnabled`
 * on such a club, which every route that acts for a group already
 * requires.
 *
 * The column DEFAULT is "live", so every club that existed before it
 * (Sutton FC, and the self-join clubs already approved) is live with no
 * backfill, and none of the rails below ever matches it.
 *
 * ONE WRITER. Nothing outside this file and `club-setup.ts` may use
 * `setupStage` as an object key, except `setupStage: true` in a select or
 * a type annotation (`__tests__/club-setup-source-guard.test.ts`). Other
 * modules spread the fragments below and call `isClubSettingUp`.
 *
 * THE RAILS ARE KEYED ON THE STATE, NOT ON THE FLAG. `SETUP_HOLD_ENABLED`
 * decides only whether an approval PUTS a club into setting-up (slice S3).
 * A club that is already setting up stays silent whatever the flag says:
 * switching the flag off must never un-silence a club that is waiting for
 * its organiser's GO. With no club in the stage (the flag has never been
 * on), every rail reads the column default and behaves exactly as before.
 */
import { APPROVED_CLUB_WHERE, isClubApproved } from "./club-approval-state";

export const SETUP_STAGES = ["live", "setting-up"] as const;
export type SetupStage = (typeof SETUP_STAGES)[number];

// ── The flag ────────────────────────────────────────────────────────────

/**
 * `SETUP_HOLD_ENABLED`: OFF unless explicitly "1"/"true"/"on"/"yes". On,
 * an approval leaves the club setting up instead of switching the bot on
 * (slice S3 reads it; nothing in slice S1 does). Use
 * `setup-hold-flag.ts` in a route or a server action: it adds the
 * per-request test seam.
 */
export function isSetupHoldEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env.SETUP_HOLD_ENABLED ?? "").trim());
}

// ── Prisma fragments ────────────────────────────────────────────────────

/** The one Prisma `where` fragment for "approved, and still setting up". */
export const SETTING_UP_CLUB_WHERE = { ...APPROVED_CLUB_WHERE, setupStage: "setting-up" } as const;

/**
 * "Not held": the club's stage is live. Spread it beside
 * `APPROVED_CLUB_WHERE` or `servingClubWhere()`; on its own it says
 * nothing about approval.
 */
export const LIVE_STAGE_WHERE = { setupStage: "live" } as const;

/**
 * "MatchTime may read this club's chat": the bot is on, or the club is
 * approved and setting up (its bot is off by the CHECK constraint). Never
 * "any club whose bot is off": a muted live club is not matched. For the
 * setup-learning sweep; put it under `AND: [...]` when the query already
 * has an `OR` of its own.
 */
export const BOT_ON_OR_SETTING_UP_WHERE: {
  OR: Array<{ whatsappBotEnabled: true } | typeof SETTING_UP_CLUB_WHERE>;
} = {
  OR: [{ whatsappBotEnabled: true }, SETTING_UP_CLUB_WHERE],
};

/** The two columns `isClubSettingUp` needs. Spread into a `select`. */
export const SETUP_STAGE_SELECT = { approvalStatus: true, setupStage: true } as const;

/**
 * The fields an approval that HOLDS the club writes beside the approved
 * status (slice S3, inside `decideClub`'s one compare-and-set). The bot
 * must be left off in the same write: the CHECK constraint refuses
 * anything else.
 */
export function settingUpClubFields(): { setupStage: "setting-up" } {
  return { setupStage: "setting-up" };
}

// ── Predicates ──────────────────────────────────────────────────────────

/**
 * Is this club approved and still setting up? A club that is not approved
 * (suspended while setting up, say) is NOT "setting up": it is unapproved,
 * and the approval rails already keep it silent. A row read without the
 * stage (an older select) is not setting up either, so a caller that
 * forgot the column gets today's behaviour, never a new exception.
 */
export function isClubSettingUp(org: {
  approvalStatus: string | null | undefined;
  setupStage?: string | null | undefined;
}): boolean {
  return isClubApproved(org) && org.setupStage === "setting-up";
}

/**
 * The dm-reply rail's decision, over the clubs MatchTime SERVES for a DM
 * sender (approved, not billing-paused): is every one of them still
 * setting up? False for a sender with no served club (that is the approval
 * and billing rails' business) and for anyone with a live club beside it.
 */
export function settingUpOnly(
  servedClubs: Array<{ approvalStatus: string | null | undefined; setupStage?: string | null | undefined }>,
): boolean {
  return servedClubs.length > 0 && servedClubs.every(isClubSettingUp);
}
