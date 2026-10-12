/**
 * WHAT FOLLOWS THE SETUP DM: the pure half (go-live slices S6 and S7,
 * 2026-10-12; go-live plan 2.4 and 2.5, owner decisions 6, 7, 9 and 10).
 * No database, no clock of its own, no model.
 *
 * A club approved while SETUP_HOLD_ENABLED is on is silent in its group
 * until its organiser says GO. Three things can follow its setup DM, each
 * AT MOST ONCE PER CLUB:
 *
 *   THE ADMIN GROUP COMMAND   a second, short platform DM straight after
 *       the setup DM: exactly "Match Time admin group <CODE>", so the
 *       organiser can forward it whole into the organisers' own group.
 *       Purpose `SETUP_ADMIN_CODE_DM_PURPOSE`. Queued with the setup DM in
 *       one transaction (club-setup-dm.ts), so "once" is the setup DM's own
 *       claim.
 *   THE REMINDER              24 hours after the setup DM was DUE
 *       (`REMINDER_AFTER_MS`), to an organiser who has not gone live. One,
 *       then nothing more, ever: there is no automatic go-live. Purpose
 *       `SETUP_REMINDER_DM_PURPOSE`; "once" is `setupReminderKey`
 *       (club-setup-reminder.ts).
 *   THE NOTE TO THE OWNER     72 hours after the approval
 *       (`STUCK_AFTER_MS`), to the MatchTime owner: an action item (he can
 *       press "Go live now" on the clubs page). "Once" is
 *       `setupStuckKey` (club-setup-stuck.ts). Owner copy is English only.
 *
 * In its own file, with no import of the reading, of club-approval or of
 * club-setup, so the cancel (club-setup-dm-cancel.ts) can name the
 * purposes without an import cycle.
 */
import { t } from "./i18n/t";

const HOUR_MS = 60 * 60 * 1000;

// ── The admin group command (the setup DM's second message) ─────────────

/** The platform purpose of the second message. */
export const SETUP_ADMIN_CODE_DM_PURPOSE = "setup-admin-code" as const;
/** Its refId: one per club. */
export const setupAdminCodeRefId = (orgId: string): string => `${orgId}:setup-admin-code`;

/** The setup DM's optional admin group block, in the club's language. */
export function setupAdminGroupBlock(lang: string): string {
  return t(lang).sj_dm_ready_admin_group;
}

/** The second message: the link command and nothing else. */
export function composeSetupAdminCommandDm(p: { lang: string; code: string }): string {
  return t(p.lang).sj_dm_ready_admin_command({ code: p.code });
}

// ── The reminder ────────────────────────────────────────────────────────

/** The platform purpose of the reminder. */
export const SETUP_REMINDER_DM_PURPOSE = "setup-reminder" as const;
/** Its refId: one per club. */
export const setupReminderRefId = (orgId: string): string => `${orgId}:setup-reminder`;

/** How long after the setup DM was due the reminder goes. */
export const REMINDER_AFTER_MS = 24 * HOUR_MS;

/**
 * The once-key of a reminder (a `SentNotification` row). Claimed when the
 * reminder is queued, and also when it is settled as "never to be sent"
 * (the setup DM itself never went).
 *
 * ONE PER SETUP DM: it carries the due time of the setup DM it reminds of
 * (`setupAskedAt`). A club has one setup DM, so this is once per club;
 * but a club that MatchTime is removed from, is added back to and is sent
 * a NEW setup DM has a new due time, so its reminder clock restarts from
 * the new one, and what happened to the first (reminded, cancelled or
 * settled as never) does not use it up.
 */
export const setupReminderKey = (orgId: string, setupAskedAt: Date): string =>
  `org-${orgId}:setup-reminder:${setupAskedAt.toISOString()}`;
/** `SentNotification.kind` of a reminder that was queued ... */
export const SETUP_REMINDER_KIND = "setup-reminder";
/** ... and of one that will never be sent. */
export const SETUP_REMINDER_SKIPPED_KIND = "setup-reminder-skipped";

/** The clock the reminder runs on: the setup DM's due time plus 24 hours. */
export function reminderDueAt(setupAskedAt: Date): Date {
  return new Date(setupAskedAt.getTime() + REMINDER_AFTER_MS);
}

/**
 * What the setup DM's own job says about the reminder:
 *   "send"     the setup DM went ("sent", or "unconfirmed": an older Pi's
 *              ack without a message id);
 *   "wait"     it is still queued or on its way (a Pi that has been down):
 *              no reminder BEFORE the message it reminds of. Looked at
 *              again on the next sweep;
 *   "never"    it was refused, cancelled or failed, or there is no job at
 *              all (the platform channel refused the number, or the club
 *              has no organiser on record): there is nothing to remind
 *              about, now or later.
 */
export function reminderDecisionFromSetupDm(status: string | null | undefined): "send" | "wait" | "never" {
  if (status === "sent" || status === "unconfirmed") return "send";
  if (status === "queued" || status === "claimed") return "wait";
  return "never";
}

export function composeSetupReminderDm(p: { lang: string; club: string; group: string | null; settingsUrl: string }): string {
  return t(p.lang).sj_dm_reminder({ club: p.club, group: p.group, url: p.settingsUrl });
}

// ── The note to the owner ───────────────────────────────────────────────

/** How long after its approval a club that is still setting up is "stuck". */
export const STUCK_AFTER_MS = 72 * HOUR_MS;

/** The owner DM's purpose (`OWNER_DM_PURPOSES`, platform-jobs.ts). */
export const OWNER_SETUP_STUCK_PURPOSE = "owner-setup-stuck" as const;
/** Its refId: one per club. */
export const setupStuckRefId = (orgId: string): string => `${orgId}:setup-stuck`;

/** The once-key of the owner's note (a `SentNotification` row). */
export const setupStuckKey = (orgId: string): string => `org-${orgId}:setup-stuck-72h`;
/** The once-key of the ops event recorded INSTEAD of the note, for a club
 *  MatchTime was removed from. Separate, so a club that is added back and
 *  is still setting up does get the note. */
export const setupStuckRemovedKey = (orgId: string): string => `org-${orgId}:setup-stuck-72h-removed`;
export const SETUP_STUCK_KIND = "setup-stuck";

/** Where the owner takes a club live. */
export const CLUBS_PAGE_PATH = "/admin/clubs";

/** The owner's DM. English only: owner copy. */
export function ownerStuckText(p: { club: string; clubsUrl: string }): string {
  return (
    `${p.club} has been approved for 3 days and its organiser has not gone live. ` +
    `MatchTime is still silent in its group. You can take it live from the clubs page: ${p.clubsUrl}`
  );
}

/** The ops event's title, for both shapes. */
export const STUCK_EVENT_TITLE = "Still setting up after 3 days";
/** The ops event beside the owner's DM. */
export const STUCK_EVENT_DETAIL =
  "This club was approved 3 days ago and its organiser has not gone live. MatchTime is still silent in its group. " +
  "You can take it live from the clubs page.";
/** The ops event for a club MatchTime was removed from: no DM is sent. */
export const STUCK_REMOVED_EVENT_DETAIL =
  "This club was approved 3 days ago and has not gone live. MatchTime was removed from its group while it was setting up, " +
  "so it cannot be taken live and you were not messaged about it.";
