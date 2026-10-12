/**
 * MATCHTIME REMOVED FROM (AND ADDED BACK TO) THE GROUP OF A CLUB THAT IS
 * STILL SETTING UP (go-live removal slice, 2026-10-12).
 *
 * A club that is approved but setting up is silent in its group until its
 * organiser says GO. If the group removes MatchTime in that time, going
 * live would queue a hello nobody receives and START A FREE PERIOD for a
 * group MatchTime is not in (then card reminders, a grace week and a
 * pause, never having served it). So:
 *
 * REMOVED (`handleSetupRemoval`, from POST /api/whatsapp/bot-removed, on
 * billing's "setting-up" answer). The club STAYS approved and setting up
 * (it does not go back to draft: it was approved, and nothing about that
 * changed). In order:
 *   1. the removal is STAMPED (`markSetupRemoved`, club-setup.ts: a
 *      compare-and-set, so a repeated report does nothing more). From here
 *      `goLiveClub` refuses every door, and the setup DM is not due;
 *   2. the organiser's setup DM is taken back if it has not gone
 *      (`cancelSetupDm`: "I'm in your group, reply GO" is no longer true).
 *      See THE SETUP DM below;
 *   3. the chat and description captured at the add are deleted
 *      (captured-chat.ts), as they are when a club waiting for approval is
 *      removed: the group took MatchTime out, so MatchTime keeps none of
 *      what the group shared. A reading that had not finished then finds
 *      nothing to read; one that had already applied settings stands;
 *   4. one event for the platform owner (`SETUP_ALERT_KIND`, on
 *      /admin/health). Never a DM to him;
 *   5. ONE DM to the organiser, on the platform channel, in the club's
 *      language, in the daytime (`messageHoursSendAfter`): MatchTime was
 *      removed before the club went live; add it back, then GO.
 * Nothing is said in the group or to any player. Steps 2 to 5 each fail
 * on their own: the stamp, which is what protects the club, is never
 * undone by a DM that could not be queued.
 *
 * ADDED BACK (`handleSetupReAdd`, from POST /api/whatsapp/bot-added). Only
 * for a real add, to THE SAME group, by a CURRENT MEMBER of the club
 * (phone, or a LID the server stored: `resolveSenderUserIds`): the stamp
 * is cleared (`clearSetupRemoved`), so GO works again, and a removal DM
 * still waiting for the morning is taken back. An add by somebody
 * MatchTime does not know as a member, to another group, or found by the
 * reconnect sweep (which names no adder) clears nothing. Nothing is
 * posted, and no roster is recorded: an approved club's group records
 * none on an add today either.
 *
 * THE SETUP DM, in each state it can be in at the removal:
 *   never sent   (not yet asked): the stamp keeps it from being due; once
 *                MatchTime is back the 15-minute sweep sends it;
 *   queued       (asked, held for 09:00 London): cancelled, and the club
 *                is made "never asked" again (`unaskCancelledSetupDm`), so
 *                after the re-add the sweep sends a fresh one. One DM, not
 *                two: the first never went;
 *   already sent (or claimed by the Pi and maybe on its way): left alone
 *                and its stamp kept, so it is never sent a second time.
 *                The organiser has it, and the removal DM tells them what
 *                to do before its GO works.
 *
 * LOGS carry the club's id and codes only: never a name, a number or text.
 */
import { db } from "./db";
import { resolveSenderUserIds } from "./admin-group-link";
import { appUrl } from "./admin-link";
import { clearCapturedChatForClub } from "./captured-chat";
import { clearSetupRemoved, findSettingUpClubByGroup, markSetupRemoved, unaskCancelledSetupDm } from "./club-setup";
import { cancelSetupDm } from "./club-setup-dm-cancel";
import { t } from "./i18n/t";
import { messageHoursSendAfter } from "./message-hours";
import { SETUP_ALERT_KIND, recordOpsEvent } from "./ops-alerts";
import { PlatformDmRefused, cancelQueuedPlatformDms, queuePlatformDm } from "./platform-jobs";

/** The platform purpose of the organiser's removal DM. */
export const SETUP_REMOVED_DM_PURPOSE = "setup-removed" as const;
/** One refId per club: a re-add takes back whichever one is still waiting. */
export const setupRemovedRefId = (orgId: string): string => `${orgId}:setup-removed`;

/** What became of the setup DM at the removal (see the header). */
export type SetupDmAtRemoval = "none-waiting" | "cancelled-will-resend" | "left-with-the-pi" | "unknown";
export type OrganiserRemovalDm = "queued" | "no-organiser" | "refused" | "failed";

export type SetupRemovalResult =
  /** No club that is setting up owns the group. Nothing done. */
  | { kind: "not-setting-up" }
  /** Already stamped (a repeated report). Nothing more done or said. */
  | { kind: "already-removed"; orgId: string }
  | { kind: "removed"; orgId: string; setupDm: SetupDmAtRemoval; organiserDm: OrganiserRemovalDm };

const errName = (err: unknown) => (err as Error)?.name ?? "error";

/** MatchTime itself was removed from `groupId`. See the file comment. */
export async function handleSetupRemoval(groupId: string, opts: { now?: Date } = {}): Promise<SetupRemovalResult> {
  const now = opts.now ?? new Date();
  const club = await findSettingUpClubByGroup(groupId);
  if (!club) return { kind: "not-setting-up" };
  if (!(await markSetupRemoved(club.id, now))) return { kind: "already-removed", orgId: club.id };
  const orgId = club.id;

  // 2. The setup DM.
  let setupDm: SetupDmAtRemoval = "unknown";
  try {
    const r = await cancelSetupDm(orgId, "removed", now);
    if (r.alreadyClaimed > 0) setupDm = "left-with-the-pi";
    else if (r.cancelled > 0) {
      await unaskCancelledSetupDm(orgId);
      setupDm = "cancelled-will-resend";
    } else setupDm = "none-waiting";
  } catch (err) {
    console.error(`[club-setup-removal] ${orgId}: the waiting setup DM was NOT taken back: ${errName(err)}`);
  }

  // 3. What the group shared at the add.
  try {
    await clearCapturedChatForClub(db, orgId);
  } catch (err) {
    console.error(`[club-setup-removal] ${orgId}: the captured chat was NOT deleted (the 7 day expiry still takes it): ${errName(err)}`);
  }

  // 5 before 4, so the owner's event can say whether the organiser was told.
  let organiserDm: OrganiserRemovalDm = "failed";
  try {
    const connect = await db.clubConnect.findFirst({
      where: { orgId, status: "closed", linkedAt: { not: null } },
      orderBy: { linkedAt: "desc" },
      select: { phone: true, groupSubject: true },
    });
    if (!connect) organiserDm = "no-organiser";
    else {
      await queuePlatformDm({
        phone: connect.phone,
        text: t(club.language).sj_setup_removed({
          club: club.name,
          group: connect.groupSubject?.trim() || club.name,
          url: appUrl("/admin/settings"),
        }),
        purpose: SETUP_REMOVED_DM_PURPOSE,
        refId: setupRemovedRefId(orgId),
        sendAfter: messageHoursSendAfter(now),
      });
      organiserDm = "queued";
    }
  } catch (err) {
    organiserDm = err instanceof PlatformDmRefused ? "refused" : "failed";
    console.error(`[club-setup-removal] ${orgId}: the organiser's removal DM was not queued (${err instanceof PlatformDmRefused ? err.code : errName(err)})`);
  }

  // 4. The platform owner sees it on /admin/health. Never throws.
  await recordOpsEvent({
    orgId,
    kind: SETUP_ALERT_KIND,
    severity: "warning",
    title: "MatchTime removed from a club that is setting up",
    detail:
      `MatchTime was removed from this club's group before the club went live. The club stays approved and setting up. ` +
      `It cannot go live, and no free period starts, until one of its members adds MatchTime back to the same group. ` +
      `Organiser told: ${organiserDm}. Setup message: ${setupDm}.`,
    // One per removal.
    dedupeKey: `setup-removed:${now.toISOString()}`,
    now,
  });

  console.log(`[club-setup-removal] ${orgId}: removed while setting up; setup DM ${setupDm}, organiser DM ${organiserDm}`);
  return { kind: "removed", orgId, setupDm, organiserDm };
}

export type SetupReAddResult =
  /** No setting-up club that was removed owns the group. Nothing done. */
  | { kind: "not-removed" }
  /** Added back by somebody who is not a current member of the club. */
  | { kind: "not-a-member"; orgId: string }
  /** The removal is cleared: the club can go live again. */
  | { kind: "cleared"; orgId: string };

/** MatchTime was added (back) to `groupId` by this adder. See the file comment. */
export async function handleSetupReAdd(input: {
  groupId: string;
  addedByPhone?: unknown;
  addedByLid?: unknown;
  now?: Date;
}): Promise<SetupReAddResult> {
  const now = input.now ?? new Date();
  const club = await findSettingUpClubByGroup(input.groupId);
  if (!club || !club.removedAt) return { kind: "not-removed" };
  const orgId = club.id;

  const phone = typeof input.addedByPhone === "string" && input.addedByPhone.trim() ? input.addedByPhone : null;
  const lid = typeof input.addedByLid === "string" && input.addedByLid.trim() ? input.addedByLid : null;
  const userIds = phone || lid ? await resolveSenderUserIds({ phones: [phone], lid }) : [];
  const member =
    userIds.length > 0
      ? await db.membership.findFirst({ where: { orgId, userId: { in: userIds }, leftAt: null }, select: { id: true } })
      : null;
  if (!member) {
    console.log(`[club-setup-removal] ${orgId}: added back by somebody who is not a member of the club; still removed`);
    return { kind: "not-a-member", orgId };
  }

  if (!(await clearSetupRemoved(orgId, input.groupId))) return { kind: "not-removed" };
  // "I was removed, add me back" must not arrive after the re-add.
  try {
    await cancelQueuedPlatformDms({ purpose: SETUP_REMOVED_DM_PURPOSE, refId: setupRemovedRefId(orgId), reason: "re-added", now });
  } catch (err) {
    console.error(`[club-setup-removal] ${orgId}: back in the group, but a waiting removal DM was NOT taken back: ${errName(err)}`);
  }
  console.log(`[club-setup-removal] ${orgId}: added back by a member; the club can go live again`);
  return { kind: "cleared", orgId };
}
