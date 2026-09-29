/**
 * THE ONLY WAY MATCHTIME DMs THE OWNER (self-join slice 3, 2026-09-29).
 * Plan: MDs/self-join-and-approval-plan-2026-09-28.md, sections 6.1 and 6.4.
 *
 * This is the doorbell, not the drawer. Kemal's rule: DMs to him only for
 * things he must act on, which today means one thing, a new club waiting
 * for his APPROVE or REJECT (and the one-line ack after he answers).
 * Routine alerts (health, operator notes, AI cap hits) are recorded by
 * `src/lib/ops-alerts.ts` and shown on /admin/health; they never come
 * here.
 *
 * What makes it hard to misuse:
 *   - two purposes only, checked at runtime, not just by the type;
 *   - a refId is required, and there is ONE DM per (purpose, refId,
 *     approver phone), ever, so a retry or a re-add cannot DM twice about
 *     the same club;
 *   - only to the numbers in SELF_JOIN_APPROVER_PHONES (none set, none
 *     sent, and the result says so);
 *   - an approval request that would land between 22:00 and 08:00 London
 *     is held until 08:00 (`sendAfter`); an ack answers something he just
 *     did, so it goes at once;
 *   - `__tests__/platform-jobs-source-guard.test.ts` allowlists the files
 *     that may import this module, and forbids ops-alerts, bot-health and
 *     every cron.
 *
 * English only: owner-facing copy, not player-facing (plan 6.1).
 */
import { db } from "./db";
import { formatLondon, londonDateTimeToUtc } from "./london-time";
import { OWNER_DM_PURPOSES, platformPhoneDigits, type OwnerDmPurpose } from "./platform-jobs";

export type { OwnerDmPurpose } from "./platform-jobs";

/** Owner quiet hours, London wall clock: [22:00, 08:00). */
const QUIET_FROM_HOUR = 22;
const QUIET_UNTIL = "08:00";

/** SELF_JOIN_APPROVER_PHONES: a comma, semicolon or space separated list. */
export function parseApproverPhones(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(/[,;]/)) {
    // Spaces inside one number ("+44 7700 900001") are part of it; a space
    // between two full numbers is not, so try the whole part first.
    const whole = platformPhoneDigits(part.trim());
    const candidates = whole ? [whole] : part.split(/\s+/).map((p) => platformPhoneDigits(p));
    for (const d of candidates) if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/** When a DM queued `now` may go out, if `now` is inside quiet hours; else null. */
export function ownerQuietHoursSendAfter(now: Date): Date | null {
  const hour = Number(formatLondon(now, "H"));
  if (hour >= QUIET_FROM_HOUR) {
    // 22:00 or later: 08:00 tomorrow. Twelve hours on is always tomorrow's date.
    const tomorrow = formatLondon(new Date(now.getTime() + 12 * 60 * 60 * 1000), "yyyy-MM-dd");
    return londonDateTimeToUtc(tomorrow, QUIET_UNTIL);
  }
  if (hour < 8) return londonDateTimeToUtc(formatLondon(now, "yyyy-MM-dd"), QUIET_UNTIL);
  return null;
}

export interface OwnerDmResult {
  queued: number;
  /** Approver phones already DMed about this (purpose, refId). */
  skipped: number;
  reason?: "no-approver-phones";
}

/**
 * Queue one DM to each approver phone. See the header for the rules.
 */
export async function queueOwnerDm(
  text: string,
  purpose: OwnerDmPurpose,
  refId: string,
  now: Date = new Date(),
): Promise<OwnerDmResult> {
  if (!(OWNER_DM_PURPOSES as readonly string[]).includes(purpose as string)) {
    throw new Error(
      `[owner-dm] "${String(purpose)}" is not an approval or an ack. Kemal is DMed only for things ` +
        "he must act on; record routine alerts with src/lib/ops-alerts.ts instead.",
    );
  }
  if (typeof refId !== "string" || !refId.trim()) {
    throw new Error("[owner-dm] a refId is required: an owner DM is always about one thing");
  }
  if (typeof text !== "string" || !text.trim()) throw new Error("[owner-dm] empty text");

  const phones = parseApproverPhones(process.env.SELF_JOIN_APPROVER_PHONES);
  if (phones.length === 0) {
    console.error(
      `[owner-dm] SELF_JOIN_APPROVER_PHONES is not set: the ${purpose} DM for ${refId} was NOT queued. ` +
        "Use /admin/clubs.",
    );
    return { queued: 0, skipped: 0, reason: "no-approver-phones" };
  }

  const sendAfter = purpose === "owner-approval" ? ownerQuietHoursSendAfter(now) : null;
  let queued = 0;
  let skipped = 0;
  for (const phone of phones) {
    const already = await db.platformJob.findFirst({
      where: { kind: "dm", purpose, refId, phone },
      select: { id: true },
    });
    if (already) {
      skipped++;
      continue;
    }
    await db.platformJob.create({
      data: { kind: "dm", phone, text, purpose, refId, status: "queued", sendAfter },
    });
    queued++;
  }
  return { queued, skipped };
}
