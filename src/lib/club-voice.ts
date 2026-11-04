/**
 * MAY MATCHTIME SEND THIS CLUB ANYTHING NOW, AND WHAT: the one rule (club
 * summary, slice B6, 2026-11-04; plan D10, D15, section 3.17). PURE: no
 * database import, so every door, the summary's consumers and the tests
 * share it.
 *
 * Before B6, "is this club served" was spelled six ways (the mute switch
 * alone, the mute switch plus the billing pause, `servingClubWhere`,
 * `isClubOperational`, that plus `isClubSettingUp`, and two different DM
 * club picks), and none of the doors a reply or a queued message leaves by
 * read dormancy. Now there is one answer, read from the summary's
 * lifecycle facts (`ClubSummary.lifecycle`, `ClubRowFacts.lifecycle`):
 *
 *   silent   not approved, setting up, dormant or paused for the club fee.
 *            MatchTime sends the club NOTHING: no post, no reply, no DM to
 *            its members, no notice to its organisers, on any door. What
 *            is already queued waits, and is dropped when the club comes
 *            back (`dropQueuedMessages`, club-voice-db.ts): no catch-up.
 *            MatchTime's OWN messages about the club (the owner's approval
 *            DMs, a setting-up club's setup DMs, billing DMs) are not the
 *            club's voice: they go on the platform channel.
 *   muted    the mute switch (`whatsappBotEnabled` off) on a club that is
 *            otherwise served. The players' group hears nothing; the one
 *            exemption that exists is HQ answering its own open organiser
 *            pick round (admin-group.ts). What is queued (an admin notice,
 *            a DM reply) WAITS for the unmute and then goes: an hour of
 *            maintenance must not cost the club its messages. Writes are
 *            not messages: fixtures, seeding and the rolling squad carry on
 *            (org-lifecycle.ts says why).
 *   on       everything, at the hours below.
 *
 * QUIET HOURS ARE NOT A SILENCE. They hold a message until they end; they
 * never drop it. Their one definition is message-hours.ts, read with the
 * club's own `quietHours` (`ClubSummary.routine.quietHours`) by every gate
 * it lists there, the admin group's posts included (D15: the score ask
 * used the default window).
 *
 * The order of the reasons is the order a person fixes them in: an
 * unapproved club is told nothing whatever its other columns say.
 */
import { APPROVED_CLUB_WHERE, isClubApproved, servingClubWhere } from "./club-approval-state";
import { isBillingPaused } from "./club-billing-rules";
import { LIVE_STAGE_WHERE, SETUP_STAGE_SELECT, isClubSettingUp, type SetupStageColumns } from "./club-setup-rules";
import { LIVE_ORG_WHERE, isOrgDormant } from "./org-lifecycle";
import type { LifecycleFacts } from "./club-summary/types";

export type ClubSilence = "not-approved" | "setting-up" | "dormant" | "billing-paused";

export type ClubVoice = { state: "on" } | { state: "muted" } | { state: "silent"; because: ClubSilence };

/** The lifecycle facts the rule reads: the summary's, or a row's derived the same way. */
export type ClubVoiceFacts = Pick<LifecycleFacts, "botOn" | "approved" | "settingUp" | "dormant" | "billingPaused">;

const ON: ClubVoice = Object.freeze({ state: "on" }) as ClubVoice;
const MUTED: ClubVoice = Object.freeze({ state: "muted" }) as ClubVoice;

export function clubVoice(l: ClubVoiceFacts): ClubVoice {
  if (!l.approved) return { state: "silent", because: "not-approved" };
  if (l.settingUp) return { state: "silent", because: "setting-up" };
  if (l.dormant) return { state: "silent", because: "dormant" };
  if (l.billingPaused) return { state: "silent", because: "billing-paused" };
  return l.botOn ? ON : MUTED;
}

/**
 * The same facts from a club's row, for a door whose summary facts could
 * not be built (the fail-soft path) or that reads the row alone (the admin
 * channel). Each predicate is the summary's own (`lifecycleFacts`,
 * club-summary/derive.ts). A row read without a column is never silenced by
 * it: going quiet needs a positive reason, as `isBillingPaused` says. So a
 * row without the approval column counts as approved; without the mute
 * switch, as muted (what it holds is held, never dropped).
 */
export function voiceFactsOfRow(row: VoiceRow): ClubVoiceFacts {
  const approved = row.approvalStatus === undefined || isClubApproved(row as SetupStageColumns);
  return {
    approved,
    settingUp: approved && isClubSettingUp({ ...row, ...APPROVED_CLUB_WHERE }),
    dormant: isOrgDormant({ dormantAt: row.dormantAt ?? null }),
    billingPaused: isBillingPaused(row),
    botOn: row.whatsappBotEnabled === true,
  };
}

/** The columns `voiceFactsOfRow` reads (`VOICE_SELECT`), each optional. */
export interface VoiceRow extends Partial<SetupStageColumns> {
  dormantAt?: Date | null;
  billingStatus?: string | null;
  whatsappBotEnabled?: boolean | null;
}

/** Spread into an Organisation `select` for `voiceFactsOfRow`. */
export const VOICE_SELECT = {
  ...SETUP_STAGE_SELECT,
  dormantAt: true,
  billingStatus: true,
  whatsappBotEnabled: true,
} as const;

/** The club speaks: every door, at its hours. */
export function clubSpeaks(l: ClubVoiceFacts): boolean {
  return clubVoice(l).state === "on";
}

/**
 * The Prisma `where` fragment for the clubs MatchTime SERVES (on or muted):
 * approved, live stage, not dormant, not paused for the club fee. Spread it
 * into an Organisation query, or under `org:` for a membership or a match.
 * With BILLING_ENABLED off the pause is not read, as everywhere else.
 */
export function servedClubWhere(env: Record<string, string | undefined> = process.env) {
  return { ...servingClubWhere(env), ...LIVE_STAGE_WHERE, ...LIVE_ORG_WHERE };
}

/** The clubs MatchTime SPEAKS for (on): served, with the bot on. */
export function speakingClubWhere(env: Record<string, string | undefined> = process.env) {
  return { ...servedClubWhere(env), whatsappBotEnabled: true as const };
}

/**
 * The same, for a MEMBERSHIP query: the DM door's one club pick. Every DM
 * handler that picks a club from a person's memberships spreads it (it was
 * `IN_LIVE_STAGE_CLUB_WHERE`, which kept out only a setting-up club), so a
 * member of a club that speaks and one that does not is handled for the
 * one that speaks.
 */
export function inSpeakingClubWhere(env: Record<string, string | undefined> = process.env) {
  return { org: speakingClubWhere(env) };
}
