/**
 * HIS TIMES AND FORMATS, ASKED ON WHATSAPP (Kemal, 2026-11-04): the thin
 * I/O half of `details-rules.ts`. No model in here: his answer is read by
 * the pool's DM reader (`reply-reader.ts`) in `reply.ts`, which calls
 * `saveDetailsFromWords`.
 *
 *   detailsQuestionDays    the days the welcome's question names, or null
 *                          when his profile has hours already.
 *   sweepPoolDetailsAsks   the daily job (06:00, close-ratings): the ONE later
 *                          question to whoever never answered, held to
 *                          POOL_DETAILS.secondAskAt London. Opted-in only: an
 *                          ACTIVE profile with consent, his own number, once
 *                          per profile ever (its refId), at most `perRun` a
 *                          day. Stopping, pausing or deleting on his page or
 *                          by DM before it goes takes it back (`manage.ts`,
 *                          a cancellable purpose).
 *   loadDetailsAsk         MatchTime's newest question to him (the welcome
 *                          while his hours are pending, or the later one),
 *                          as the reader is shown it.
 *   saveDetailsFromWords   his answer onto his profile through the manage
 *                          page's own writer and validator, then marked
 *                          answered so he is never asked again.
 */
import { db } from "../db";
import { normaliseLang } from "../i18n/lang";
import { londonWallClockToUtc } from "../london-time";
import { sameWhatsAppMessage } from "../quoted-message";
import { poolDetailsAskText } from "./copy";
import {
  DETAILS_ASK_PURPOSE,
  POOL_DETAILS,
  applyDetails,
  detailsAskRefId,
  detailsSummary,
  hoursPending,
  secondAskDue,
  type DetailsFields,
  type DetailsReading,
  type DetailsSummary,
} from "./details-rules";
import { buildPoolManageLink } from "./links";
import { savePoolFields, savedPoolSportKeys } from "./manage";
import { validatePoolFields } from "./profile-fields";
import { queueOnce } from "./queue-once";
import { formatMinutes } from "./rules";
import type { PoolSportChoiceKey, SportLevel } from "./sports";

const answeredKey = (profileId: string) => `pool-details:${profileId}:answered`;
const reaskKey = (profileId: string) => `pool-details:${profileId}:reask`;
const welcomeRefId = (profileId: string) => `pool-welcome:${profileId}`;

const DAY = 24 * 3600_000;

/** The days the welcome's question names; null when he gave hours already. */
export async function detailsQuestionDays(profileId: string): Promise<number[] | null> {
  const ranges = await db.poolAvailability.findMany({ where: { profileId }, select: { day: true, fromMin: true, toMin: true } });
  return hoursPending(ranges) ? [...new Set(ranges.map((r) => r.day))] : null;
}

/** The daily job's one later question. Returns how many were queued. */
export async function sweepPoolDetailsAsks(now: Date = new Date()): Promise<number> {
  const rows = await db.poolProfile.findMany({
    where: {
      status: "active",
      userId: { not: null },
      consentAt: { gte: new Date(now.getTime() - POOL_DETAILS.secondAskWithinDays * DAY), lte: new Date(now.getTime() - POOL_DETAILS.secondAskAfterDays * DAY) },
    },
    select: {
      id: true,
      userId: true,
      status: true,
      consentAt: true,
      displayName: true,
      language: true,
      user: { select: { phoneNumber: true } },
      availability: { select: { day: true, fromMin: true, toMin: true } },
    },
    orderBy: { consentAt: "asc" },
    take: 500,
  });
  const pending = rows.filter((r) => hoursPending(r.availability) && r.user?.phoneNumber);
  if (pending.length === 0) return 0;
  const [answered, asked] = await Promise.all([
    db.sentNotification.findMany({ where: { key: { in: pending.map((r) => answeredKey(r.id)) } }, select: { key: true } }),
    db.platformJob.findMany({ where: { purpose: DETAILS_ASK_PURPOSE, refId: { in: pending.map((r) => detailsAskRefId(r.id)) } }, select: { refId: true } }),
  ]);
  const answeredSet = new Set(answered.map((a) => a.key));
  const askedSet = new Set(asked.map((a) => a.refId));
  const sendAt = londonWallClockToUtc(now, POOL_DETAILS.secondAskAt);
  let queued = 0;
  for (const r of pending) {
    if (queued >= POOL_DETAILS.perRun) break;
    const due = secondAskDue({
      status: r.status,
      consentAt: r.consentAt,
      hoursPending: true,
      answered: answeredSet.has(answeredKey(r.id)),
      alreadyAsked: askedSet.has(detailsAskRefId(r.id)),
      now,
    });
    if (!due) continue;
    const text = poolDetailsAskText(normaliseLang(r.language), {
      displayName: r.displayName,
      days: [...new Set(r.availability.map((a) => a.day))],
      manageLink: await buildPoolManageLink(r.userId!),
    });
    const phone = r.user!.phoneNumber!.replace(/^\+/, "");
    if (await queueOnce(phone, text, DETAILS_ASK_PURPOSE, detailsAskRefId(r.id), sendAt > now ? sendAt : null)) queued++;
  }
  if (queued) console.log(`[pool-details] later questions queued=${queued}`);
  return queued;
}

/**
 * MatchTime's newest question to him about his times and formats, on his
 * number: the later question, or the welcome while his hours are still the
 * short form's whole days (the welcome carried the question then). Null
 * when there is none.
 */
export async function loadDetailsAsk(
  profileId: string,
  his: string,
  quotedId: string | null,
  pending: boolean,
): Promise<{ sentAt: Date; text: string; quoted: boolean } | null> {
  const jobs = await db.platformJob.findMany({
    where: {
      phone: his,
      OR: [{ purpose: DETAILS_ASK_PURPOSE, refId: detailsAskRefId(profileId) }, ...(pending ? [{ purpose: "pool-welcome", refId: welcomeRefId(profileId) }] : [])],
      status: { in: ["sent", "unconfirmed"] },
    },
    orderBy: { createdAt: "desc" },
    select: { text: true, sentAt: true, createdAt: true, waMessageId: true },
  });
  const quoted = quotedId ? jobs.find((j) => sameWhatsAppMessage(quotedId, j.waMessageId)) : undefined;
  const job = quoted ?? jobs[0];
  if (!job) return null;
  return { sentAt: job.sentAt ?? job.createdAt, text: job.text ?? "", quoted: !!quoted };
}

/** His profile's days and sports, as `applyDetails` reads them. */
export function detailsFieldsOf(p: {
  availability: Array<{ day: number; fromMin: number; toMin: number }>;
  sports: Array<{ sport: string; otherName: string; formats: number[]; level: string | null; levelText: string | null }>;
}): DetailsFields {
  return {
    availability: p.availability.map((a) => ({ day: a.day, from: formatMinutes(a.fromMin), to: formatMinutes(a.toMin) })),
    sports: p.sports.map((s) => ({ sport: s.sport as PoolSportChoiceKey, otherName: s.otherName, formats: s.formats, level: s.level as SportLevel | null, levelText: s.levelText })),
  };
}

/**
 * Save what he told MatchTime. The change goes through the manage page's
 * validator and writer (`validatePoolFields`, `savePoolFields`), so a reading
 * can never store what the page would refuse. Marked answered whether or not
 * it changed anything ("any time, any format" keeps the defaults). Null when
 * nothing could be saved (no profile, a change the validator refused).
 */
export async function saveDetailsFromWords(userId: string, reading: DetailsReading, now: Date = new Date()): Promise<DetailsSummary | null> {
  const p = await db.poolProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      status: true,
      displayName: true,
      areaDistrict: true,
      maxMiles: true,
      language: true,
      availability: { select: { day: true, fromMin: true, toMin: true } },
      sports: { select: { sport: true, otherName: true, formats: true, level: true, levelText: true }, orderBy: { id: "asc" } },
    },
  });
  if (!p || (p.status !== "active" && p.status !== "paused")) return null;
  const current = detailsFieldsOf(p);
  const next = applyDetails(current, reading);
  if (next) {
    const valid = validatePoolFields(
      { name: p.displayName, area: { kind: "district", district: p.areaDistrict }, maxMiles: p.maxMiles, availability: next.availability, sports: next.sports, language: p.language },
      { keep: await savedPoolSportKeys(userId) },
    );
    if (!valid.ok) {
      console.error(`[pool-details] ${userId}: his answer was refused by the validator: ${Object.keys(valid.errors).join(",")}`);
      return null;
    }
    const saved = await savePoolFields(userId, valid.value, now);
    if (!saved.ok) return null;
  }
  await markOnce(answeredKey(p.id));
  return detailsSummary(next ?? current);
}

/** Claim the once-per-profile re-ask; false when it was used already. */
export async function claimDetailsReask(profileId: string): Promise<boolean> {
  return markOnce(reaskKey(profileId));
}

async function markOnce(key: string): Promise<boolean> {
  try {
    await db.sentNotification.create({ data: { key, kind: "pool-details" } });
    return true;
  } catch {
    return false;
  }
}
