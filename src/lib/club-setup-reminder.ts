/**
 * THE ONE REMINDER (go-live slice S6, 2026-10-12; go-live plan 2.4 and 2.5
 * "Reminder", owner decision 9). The words and the constants are in the
 * pure half, `club-setup-followup-rules.ts`.
 *
 * An organiser who was sent the setup DM and has not gone live gets ONE
 * reminder, and then nothing more, ever. There is no automatic go-live.
 *
 *   WHEN   24 hours after the setup DM was DUE (`setupAskedAt`, the stamp
 *          `markSetupAsked` writes: the DM's due time, not the moment it
 *          was queued). Run by the 15-minute learn-setup cron.
 *   HOURS  09:00 to 23:00 London (`messageHoursSendAfter`). A run that
 *          finds it due at night queues it for the next 09:00;
 *          `cancelSetupDm` takes a waiting one back when the club goes
 *          live, is suspended or MatchTime is removed first.
 *   LINK   a fresh signed-in link to the settings page, minted now, good
 *          for 7 days like the setup DM's.
 *
 * NOT SENT when the club is no longer "setting up, in its group": it went
 * live, was suspended, or MatchTime was removed from its group
 * (`settingUpAskedBy`, club-setup.ts). A removed club is simply not due;
 * nothing is settled, so if it is added back it is reminded then.
 *
 * NOT SENT, EVER, when the setup DM itself never went: the platform
 * channel refused the number or the club has no organiser on record (no
 * job exists), or the job was cancelled or failed. There is nothing to
 * remind about. That is settled with the once-key so no sweep looks again.
 * A setup DM that is still queued or on its way (a Pi that has been down)
 * is waited for: no reminder before the message it reminds of.
 *
 * AFTER A REMOVAL AND A RE-ADD. The once-key carries the due time of the
 * setup DM it reminds of (`setupReminderKey`). A club that is added back
 * and sent a NEW setup DM has a new due time, so its reminder runs 24
 * hours from the new one, whatever happened to the first.
 *
 * EXACTLY ONCE PER SETUP DM (so once per club, unless it is sent a new
 * one), whoever races whom. One transaction:
 *   1. it locks the club's row and reads it again. A go-live or a
 *      suspension is a write to that row, so it has either committed (the
 *      club is no longer due and nothing is queued) or it waits for this
 *      transaction, and its `cancelSetupDm`, which runs after its own
 *      commit, then finds the reminder and cancels it;
 *   2. it claims the once-key (`setupReminderKey`, a unique
 *      `SentNotification` row). Of two cron runs only one inserts it; the
 *      other gets a count of 0 and queues nothing;
 *   3. it queues the PlatformJob. If anything fails, all three roll back
 *      and a later sweep sends it.
 *
 * LOGS carry the club's id and reason codes only: never its name, a phone
 * number, the message text or a link.
 */
import { db } from "./db";
import { appUrl, buildAdminLink } from "./admin-link";
import { SETUP_ASKED_ORDER, SETUP_ASKED_SELECT, setupAskedAtOf, settingUpAskedBy } from "./club-setup";
import { SETUP_ASK_DM_PURPOSE, setupAskRefId } from "./club-setup-dm-rules";
import {
  REMINDER_AFTER_MS,
  SETUP_REMINDER_DM_PURPOSE,
  SETUP_REMINDER_KIND,
  SETUP_REMINDER_SKIPPED_KIND,
  composeSetupReminderDm,
  reminderDecisionFromSetupDm,
  setupReminderKey,
  setupReminderRefId,
} from "./club-setup-followup-rules";
import { messageHoursSendAfter } from "./message-hours";
import { PlatformDmRefused, queuePlatformDm, type PlatformDmClient, type PlatformDmRefusalCode } from "./platform-jobs";

/** The link stays clickable for a week, as the setup DM's do. */
const LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Clubs handled per sweep. */
export const MAX_SETUP_REMINDERS_PER_SWEEP = 20;

export type SetupReminderOutcome =
  /** Queued. `sendAfter` null: goes at once. */
  | { kind: "sent"; sendAfter: Date | null }
  /** Not setting up, removed from its group, never asked, or not 24 hours yet. */
  | { kind: "not-due" }
  /** Sent or settled before (or another run claimed it a moment ago). */
  | { kind: "already" }
  /** The setup DM is still queued or on its way: looked at again later. */
  | { kind: "waiting-for-setup-dm" }
  /** There will be no reminder for this club. Settled. */
  | { kind: "never"; reason: "setup-dm-not-sent" | "no-organiser" | PlatformDmRefusalCode };

type RawClient = { $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number> };

const cutoff = (now: Date) => new Date(now.getTime() - REMINDER_AFTER_MS);

/** Settle a setup DM that will never be reminded of, so no sweep reads it again. */
async function settleNever(orgId: string, key: string, reason: string): Promise<void> {
  await db.sentNotification.createMany({
    data: [{ key, kind: SETUP_REMINDER_SKIPPED_KIND }],
    skipDuplicates: true,
  });
  console.log(`[club-setup-reminder] ${orgId}: no reminder, settled (${reason})`);
}

/** Send this club's reminder if it is due. Never twice (see the header). */
export async function sendSetupReminder(orgId: string, now: Date = new Date()): Promise<SetupReminderOutcome> {
  const due = { id: orgId, ...settingUpAskedBy(cutoff(now)) };
  const org = await db.organisation.findFirst({ where: due, select: { id: true, name: true, language: true, ...SETUP_ASKED_SELECT } });
  const askedAt = org ? setupAskedAtOf(org) : null;
  if (!org || !askedAt) return { kind: "not-due" };

  const key = setupReminderKey(orgId, askedAt);
  if (await db.sentNotification.findUnique({ where: { key }, select: { id: true } })) return { kind: "already" };

  // Did the setup DM itself go?
  const setupDm = await db.platformJob.findFirst({
    where: { kind: "dm", purpose: SETUP_ASK_DM_PURPOSE, refId: setupAskRefId(orgId) },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  });
  const decision = reminderDecisionFromSetupDm(setupDm?.status);
  if (decision === "wait") return { kind: "waiting-for-setup-dm" };
  if (decision === "never") {
    await settleNever(orgId, key, "setup-dm-not-sent");
    return { kind: "never", reason: "setup-dm-not-sent" };
  }

  // The organiser: the same connect request the setup DM went to.
  const connect = await db.clubConnect.findFirst({
    where: { orgId, status: "closed", linkedAt: { not: null } },
    orderBy: { linkedAt: "desc" },
    select: { userId: true, phone: true, groupSubject: true },
  });
  if (!connect) {
    await settleNever(orgId, key, "no-organiser");
    return { kind: "never", reason: "no-organiser" };
  }

  let settingsUrl: string;
  try {
    settingsUrl = await buildAdminLink({ userId: connect.userId, orgId, nextPath: "/admin/settings", ttlSeconds: LINK_TTL_SECONDS });
  } catch {
    console.error(`[club-setup-reminder] ${orgId}: a signed-in link could not be made; sending the plain address`);
    settingsUrl = appUrl("/admin/settings");
  }
  const text = composeSetupReminderDm({ lang: org.language, club: org.name, group: connect.groupSubject, settingsUrl });
  const sendAfter = messageHoursSendAfter(now);

  const outcome = await db.$transaction(async (tx): Promise<SetupReminderOutcome> => {
    // 1. The club's row, locked, then read again: see the header.
    await (tx as unknown as RawClient).$executeRaw`SELECT 1 FROM "Organisation" WHERE "id" = ${orgId} FOR UPDATE`;
    const still = await tx.organisation.findFirst({ where: due, select: { id: true, ...SETUP_ASKED_SELECT } });
    // Still due, and still for the SAME setup DM (not a new one sent after
    // a removal and a re-add in between).
    if (!still || setupAskedAtOf(still)?.getTime() !== askedAt.getTime()) return { kind: "not-due" };
    // 2. The claim. Only the run that wins it goes on.
    const claim = await tx.sentNotification.createMany({ data: [{ key, kind: SETUP_REMINDER_KIND }], skipDuplicates: true });
    if (claim.count !== 1) return { kind: "already" };
    // 3. The job.
    try {
      await queuePlatformDm({
        phone: connect.phone,
        text,
        purpose: SETUP_REMINDER_DM_PURPOSE,
        refId: setupReminderRefId(orgId),
        sendAfter,
        client: tx as unknown as PlatformDmClient,
      });
    } catch (err) {
      // The recipient rule said no. The claim STAYS: this is a fact about
      // the number, not a failure to retry. Only the code is kept; the
      // refusal's own message can hold the raw number.
      if (!(err instanceof PlatformDmRefused)) throw err;
      return { kind: "never", reason: err.code };
    }
    return { kind: "sent", sendAfter };
  });

  if (outcome.kind === "sent") {
    console.log(`[club-setup-reminder] ${orgId}: reminder queued${sendAfter ? ` (held until ${sendAfter.toISOString()})` : ""}`);
  } else if (outcome.kind === "never") {
    console.error(`[club-setup-reminder] ${orgId}: reminder NOT sent (${outcome.reason}); settled, not retried`);
  }
  return outcome;
}

/**
 * The cron's half: every club whose reminder is due and not settled. With
 * no club setting up it is one query that finds nothing.
 */
export async function runSetupReminderSweep(now: Date = new Date()): Promise<{ considered: number; sent: number }> {
  // Ids only, and no limit here: clubs already reminded stay in this list
  // for as long as they are setting up, and must not crowd out a new one.
  const due = await db.organisation.findMany({
    where: settingUpAskedBy(cutoff(now)),
    orderBy: SETUP_ASKED_ORDER,
    select: { id: true, ...SETUP_ASKED_SELECT },
  });
  if (due.length === 0) return { considered: 0, sent: 0 };
  const keyOf = (o: (typeof due)[number]): string | null => {
    const askedAt = setupAskedAtOf(o);
    return askedAt ? setupReminderKey(o.id, askedAt) : null;
  };
  const keys = due.map(keyOf).filter((k): k is string => !!k);
  const settled = new Set((await db.sentNotification.findMany({ where: { key: { in: keys } }, select: { key: true } })).map((r) => r.key));
  const open = due.filter((o) => !settled.has(keyOf(o) ?? "")).slice(0, MAX_SETUP_REMINDERS_PER_SWEEP);
  let sent = 0;
  for (const o of open) {
    try {
      if ((await sendSetupReminder(o.id, now)).kind === "sent") sent++;
    } catch (err) {
      console.error(`[club-setup-reminder] ${o.id}: reminder failed; the next sweep retries: ${(err as Error)?.name ?? "error"}`);
    }
  }
  return { considered: open.length, sent };
}
