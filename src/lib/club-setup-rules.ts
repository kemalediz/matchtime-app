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
 * ONE HOME. Outside this file and `club-setup.ts` the column's name does
 * not appear at all in `src/` or `scripts/`: not as a key, not in a read,
 * not in SQL, not in a comment (`__tests__/club-setup-source-guard.test.ts`).
 * Other modules spread the fragments below, select `SETUP_STAGE_SELECT`,
 * type a row with `SetupStageColumns`, and call the predicates.
 *
 * THE RAILS ARE KEYED ON THE STATE, NOT ON THE FLAG. `SETUP_HOLD_ENABLED`
 * decides only whether an approval PUTS a club into setting-up (slice S3).
 * A club that is already setting up stays silent whatever the flag says:
 * switching the flag off must never un-silence a club that is waiting for
 * its organiser's GO. With no club in the stage (the flag has never been
 * on), every rail reads the column default and behaves exactly as before.
 */
import { APPROVED_CLUB_WHERE, isClubApproved } from "./club-approval-state";

// The column holds "live" or "setting-up" and nothing else: a CHECK
// constraint (prisma/sql/org-setup-check.sql) refuses any other value.

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
 * The same, for a MEMBERSHIP query: "the member's club is not held". THE
 * DM PATH'S ONE RULE (review of PR #232, fix 2): a setting-up club does
 * not exist for club selection. Every handler in dm-reply that picks a
 * club from a person's memberships spreads this, so someone who is in a
 * live club and a setting-up one is handled for the live club only. Every
 * existing club's stage is live, so with no club setting up the fragment
 * removes nobody.
 */
export const IN_LIVE_STAGE_CLUB_WHERE = { org: LIVE_STAGE_WHERE } as const;

/**
 * "Never held": the club has no go-live stamp. `liveAt` is written only
 * when a club leaves setting-up, so it is NULL for every club that never
 * passed through the hold (every club that exists today).
 */
export const NEVER_HELD_WHERE = { liveAt: null } as const;

/**
 * "The setup-learning sweep may read this club's chat": the bot is on AND
 * the club was never held, OR the club is approved and setting up (its bot
 * is off by the CHECK constraint).
 *
 * The first half is today's rule for every club that exists. A club that
 * HAS been through the hold is read only while it is still setting up:
 * once its organiser has said GO, the hello has told the group how the
 * club runs, and no reading, however late, may change that (review of PR
 * #232, fix 1). Never "any club whose bot is off": a muted live club is
 * not matched. Put it under `AND: [...]` when the query has an `OR` of its
 * own.
 */
export const SETUP_READABLE_CLUB_WHERE: {
  OR: Array<{ whatsappBotEnabled: true; liveAt: null } | typeof SETTING_UP_CLUB_WHERE>;
} = {
  OR: [{ whatsappBotEnabled: true, ...NEVER_HELD_WHERE }, SETTING_UP_CLUB_WHERE],
};

/** The two columns `isClubSettingUp` needs. Spread into a `select`. */
export const SETUP_STAGE_SELECT = { approvalStatus: true, setupStage: true } as const;

/**
 * A row read with `SETUP_STAGE_SELECT`. The stage is OPTIONAL on purpose:
 * a row read without it is "not setting up", which is today's behaviour
 * and, for the AI budget, the $0 side.
 */
export interface SetupStageColumns {
  approvalStatus: string | null | undefined;
  setupStage?: string | null | undefined;
}

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
export function isClubSettingUp(org: SetupStageColumns): boolean {
  return isClubApproved(org) && org.setupStage === "setting-up";
}

/**
 * Has this club been through the hold and come out? True once `liveAt` is
 * set. False for every club that exists today, and for a row read without
 * the column.
 */
export function hasGoneLive(org: { liveAt?: Date | null | undefined }): boolean {
  return org.liveAt !== null && org.liveAt !== undefined;
}

/**
 * Club selection when the caller could not filter in its query (the DM
 * help, which must still answer someone whose ONLY club is setting up):
 * the rows whose club is not setting up, or every row when that would
 * leave none. With no club setting up it returns the rows as they were.
 */
export function preferLiveClubs<T>(rows: T[], clubOf: (row: T) => SetupStageColumns): T[] {
  const live = rows.filter((r) => !isClubSettingUp(clubOf(r)));
  return live.length > 0 ? live : rows;
}

/**
 * The dm-reply rail's decision, over the clubs MatchTime SERVES for a DM
 * sender (approved, not billing-paused): is every one of them still
 * setting up? False for a sender with no served club (that is the approval
 * and billing rails' business) and for anyone with a live club beside it.
 */
export function settingUpOnly(servedClubs: SetupStageColumns[]): boolean {
  return servedClubs.length > 0 && servedClubs.every(isClubSettingUp);
}
