/**
 * THE ONE NOTE TO THE OWNER ABOUT A CLUB STUCK IN SETTING UP (go-live
 * slice S6, 2026-10-12; owner decision 7). The words and the constants are
 * in the pure half, `club-setup-followup-rules.ts`.
 *
 * There is no automatic go-live, so a club whose organiser never says GO
 * would stay silent for ever with nobody looking. 72 hours after its
 * approval, a club that is still setting up produces, ONCE:
 *
 *   - one DM to the MatchTime owner (`queueOwnerDm`, purpose
 *     "owner-setup-stuck"). This is an action item, not an alert: he can
 *     press "Go live now" on the clubs page, and the DM carries that
 *     page's address. His quiet hours apply (held until 08:00 London). He
 *     is never emailed;
 *   - one ops event on /admin/health (`SETUP_ALERT_KIND`).
 *
 * NOT SENT for a club that went live or was suspended (it is no longer
 * "setting up": `settingUpApprovedBy`). And for a club MATCHTIME WAS
 * REMOVED FROM while it was setting up there is NO DM (it cannot be taken
 * live, so there is nothing for him to do): one ops event says so instead,
 * under its own once-key, so a club that is added back and is still
 * setting up does get the note.
 *
 * ONCE PER CLUB, whoever races whom: a unique `SentNotification` row
 * (`setupStuckKey`) is claimed BEFORE anything is recorded or queued. Of
 * two cron runs only one inserts it. If queueing then fails, the claim is
 * released so a later sweep tries again; the ops event's own dedupe key
 * and the owner DM's one-per-(purpose, refId, phone) rule keep that retry
 * from doubling either.
 *
 * WHO MAY IMPORT owner-dm is an allowlist
 * (`__tests__/platform-jobs-source-guard.test.ts`). This file is on it on
 * purpose; the cron route imports THIS file and never owner-dm itself.
 *
 * LOGS carry the club's id only: never its name or the owner's number.
 */
import { db } from "./db";
import { appUrl } from "./admin-link";
import { SETUP_REMOVED_SELECT, settingUpApprovedBy, wasRemovedDuringSetup } from "./club-setup";
import {
  CLUBS_PAGE_PATH,
  OWNER_SETUP_STUCK_PURPOSE,
  SETUP_STUCK_KIND,
  STUCK_AFTER_MS,
  STUCK_EVENT_DETAIL,
  STUCK_EVENT_TITLE,
  STUCK_REMOVED_EVENT_DETAIL,
  ownerStuckText,
  setupStuckKey,
  setupStuckRefId,
  setupStuckRemovedKey,
} from "./club-setup-followup-rules";
import { SETUP_ALERT_KIND, recordOpsEvent } from "./ops-alerts";
import { queueOwnerDm } from "./owner-dm";

/** Clubs handled per sweep. */
export const MAX_STUCK_NOTES_PER_SWEEP = 20;

export type StuckNoteOutcome =
  /** The ops event is recorded; `queued` owner DMs were queued (0 when no
   *  approver phone is configured). */
  | { kind: "noted"; queued: number }
  /** MatchTime was removed from the group: the ops event only, no DM. */
  | { kind: "removed" }
  /** Noted before (or another run claimed it a moment ago). */
  | { kind: "already" }
  /** Not setting up, or not 72 hours since the approval yet. */
  | { kind: "not-due" };

const cutoff = (now: Date) => new Date(now.getTime() - STUCK_AFTER_MS);

/** First writer wins. */
async function claim(key: string): Promise<boolean> {
  const { count } = await db.sentNotification.createMany({ data: [{ key, kind: SETUP_STUCK_KIND }], skipDuplicates: true });
  return count === 1;
}

/** Note this club if it is stuck. Never twice (see the header). */
export async function noteStuckClub(orgId: string, now: Date = new Date()): Promise<StuckNoteOutcome> {
  const org = await db.organisation.findFirst({
    where: { id: orgId, ...settingUpApprovedBy(cutoff(now)) },
    select: { id: true, name: true, ...SETUP_REMOVED_SELECT },
  });
  if (!org) return { kind: "not-due" };

  if (wasRemovedDuringSetup(org)) {
    if (await claim(setupStuckRemovedKey(orgId))) {
      await recordOpsEvent({
        orgId,
        kind: SETUP_ALERT_KIND,
        severity: "warning",
        title: STUCK_EVENT_TITLE,
        detail: STUCK_REMOVED_EVENT_DETAIL,
        dedupeKey: "setup-stuck-72h-removed",
        now,
      });
      console.log(`[club-setup-stuck] ${orgId}: still setting up after 72 hours, removed from its group; recorded, owner not messaged`);
    }
    return { kind: "removed" };
  }

  const key = setupStuckKey(orgId);
  if (!(await claim(key))) return { kind: "already" };
  try {
    await recordOpsEvent({
      orgId,
      kind: SETUP_ALERT_KIND,
      severity: "warning",
      title: STUCK_EVENT_TITLE,
      detail: STUCK_EVENT_DETAIL,
      dedupeKey: "setup-stuck-72h",
      now,
    });
    const dm = await queueOwnerDm(
      ownerStuckText({ club: org.name, clubsUrl: appUrl(CLUBS_PAGE_PATH) }),
      OWNER_SETUP_STUCK_PURPOSE,
      setupStuckRefId(orgId),
      now,
    );
    console.log(`[club-setup-stuck] ${orgId}: still setting up after 72 hours; recorded, ${dm.queued} owner DM(s) queued`);
    return { kind: "noted", queued: dm.queued };
  } catch (err) {
    // Not queued: give the claim back so the next sweep is a real retry.
    await db.sentNotification.deleteMany({ where: { key } }).catch(() => {});
    throw err;
  }
}

/**
 * The cron's half: every club still setting up 72 hours after its
 * approval that has not been noted. With no club setting up it is one
 * query that finds nothing.
 */
export async function runSetupStuckSweep(now: Date = new Date()): Promise<{ considered: number; noted: number }> {
  // Ids only, and no limit here: a club already noted stays in this list
  // for as long as it is setting up, and must not crowd out a new one.
  const stuck = await db.organisation.findMany({
    where: settingUpApprovedBy(cutoff(now)),
    orderBy: { approvedAt: "asc" },
    select: { id: true },
  });
  if (stuck.length === 0) return { considered: 0, noted: 0 };
  const done = new Set(
    (await db.sentNotification.findMany({ where: { key: { in: stuck.map((o) => setupStuckKey(o.id)) } }, select: { key: true } })).map(
      (r) => r.key,
    ),
  );
  const open = stuck.filter((o) => !done.has(setupStuckKey(o.id))).slice(0, MAX_STUCK_NOTES_PER_SWEEP);
  let noted = 0;
  for (const o of open) {
    try {
      if ((await noteStuckClub(o.id, now)).kind === "noted") noted++;
    } catch (err) {
      console.error(`[club-setup-stuck] ${o.id}: note failed; the next sweep retries: ${(err as Error)?.name ?? "error"}`);
    }
  }
  return { considered: open.length, noted };
}
