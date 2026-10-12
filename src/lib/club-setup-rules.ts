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

// ── Going live (slice S4) ───────────────────────────────────────────────

/**
 * HOW LONG A HELD CLUB WAITS FOR ITS SETUP READING, from its approval: two
 * hours. THE ONE CONSTANT for both halves of that rule, so they can never
 * disagree:
 *   - GO is refused with "still reading" while the reading has not
 *     finished, for this long (owner decision 4, `readingBlocksGoLive`
 *     below). After that the organiser is never kept waiting on a
 *     reading: going live closes it (`closeUnfinishedSetupLearning`);
 *   - the organiser's setup DM waits for the reading for this long, then
 *     the reading is closed for good and the DM goes anyway (the cap,
 *     `sendSetupDm` in club-setup-dm.ts).
 * So whenever GO is answered "still reading ... I'll message you", the
 * setup DM is still to come, and comes by the end of this window (plus
 * one run of the 15-minute cron).
 */
export const STILL_READING_WINDOW_MS = 2 * 60 * 60 * 1000;

const GO_WORDS: ReadonlySet<string> = new Set(["go", "go live", "basla"]);

/**
 * THE TEXT GATE OF THE GO HANDLER. True only when the WHOLE message is the
 * command: GO, GO LIVE, BAŞLA or BASLA, in any letter case. Pure and
 * cheap, so every other DM costs no query.
 *
 * People answer with what they see and how they talk (PR #234 review, fix
 * 6): our own messages print *GO* in bold, and a reply is as likely to be
 * "GO!!" or "Go 👍". So before matching, the text is trimmed, every kind
 * of space is collapsed, WhatsApp's formatting marks (* _ ~ `) round it
 * are dropped, and so are trailing full stops, exclamation marks and
 * emoji. What is LEFT must still be exactly one of the command words:
 * "go on then", "let's go" and "*go* on then" are not GO. A question mark
 * is not dropped: "go?" is a question, not a command.
 */
export function isGoCommand(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const word = text
    // Every Unicode space, zero-width ones and line breaks included.
    .replace(/[\s​-‍⁠﻿]+/gu, " ")
    .trim()
    // Leading formatting marks, then anything trailing that is a mark, a
    // space, closing punctuation or an emoji (with its modifiers).
    .replace(/^[*_~` ]+/u, "")
    .replace(/[*_~` .!…\p{Extended_Pictographic}\p{Emoji_Modifier}️‍]+$/u, "")
    // Turkish letters: "BAŞLA", and "GO LİVE" typed on a Turkish
    // keyboard, must read the same as their plain forms.
    .replace(/[İIı]/g, "i")
    .replace(/[Şş]/g, "s")
    .toLowerCase();
  return GO_WORDS.has(word);
}

/** `liveBy` for an owner or admin who pressed Go live on the website. */
export function liveByUser(userId: string): string {
  return userId;
}

/** `liveBy` for the MatchTime owner's "Go live now" on the clubs page. */
export function liveByOwner(ownerUserId: string): string {
  return `owner:${ownerUserId}`;
}

/** The reading statuses after which nothing more will come of the chat.
 *  THE ONE LIST: `isSetupLearningFinal` below, and the setup DM sweep's
 *  query (club-setup-dm.ts). */
export const SETUP_LEARNING_FINAL_STATUSES = ["applied", "nothing", "skipped", "failed"] as const;
const FINAL_LEARNING_STATUSES: ReadonlySet<string> = new Set(SETUP_LEARNING_FINAL_STATUSES);

/** Has the setup reading finished? "running" and "deferred" have not. THE
 *  ONE PREDICATE: go-live's "still reading" and the setup DM both use it. */
export function isSetupLearningFinal(status: string | null | undefined): boolean {
  return typeof status === "string" && FINAL_LEARNING_STATUSES.has(status);
}

/**
 * Must GO wait for the setup reading (owner decision 4)? Only while ALL of
 * these hold: the reading is switched on, the club was approved less than
 * two hours ago, and its reading is unfinished, or has not started and
 * one is expected (`readingExpected`: the club has a connect request, so
 * the sweep will read it). Never blocks otherwise.
 */
export function readingBlocksGoLive(args: {
  learningEnabled: boolean;
  /** The club's reading row status, or null when it has no row. */
  learningStatus: string | null | undefined;
  readingExpected: boolean;
  approvedAt: Date | null | undefined;
  now: Date;
}): boolean {
  if (!args.learningEnabled || !args.approvedAt) return false;
  if (args.now.getTime() - args.approvedAt.getTime() >= STILL_READING_WINDOW_MS) return false;
  if (args.learningStatus === null || args.learningStatus === undefined) return args.readingExpected;
  return !isSetupLearningFinal(args.learningStatus);
}

/**
 * "Approved, live, and has been through the hold" (`liveAt` is stamped):
 * the clubs whose owner or admin is answered "already live" when they say
 * GO, however long ago the club went live. A club that was never held
 * (every club that existed before the hold) has no stamp and never
 * matches, so GO from its admin is not ours and falls through untouched.
 */
export const WENT_LIVE_CLUB_WHERE = { ...APPROVED_CLUB_WHERE, ...LIVE_STAGE_WHERE, liveAt: { not: null } } as const;
