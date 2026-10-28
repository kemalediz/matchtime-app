/**
 * A CLUB'S ONE SHARE POST, the thin I/O half of `club-share-rules.ts`
 * (growth slice G3, 2026-10-24):
 *
 *   loadClubShare   the "Tell your players about the player pool" card on
 *                   club settings: the exact post with the club's link, and
 *                   whether it can be sent, or when it was
 *   sendClubShare   the organiser's tap: claimed once per club, ever, and
 *                   queued as an ordinary players' group post
 *
 * The post goes through the players' group channel every group post uses:
 * a `BotJob` of kind "group", which the scheduler hands the Pi as a
 * "group-message". Inside the club's quiet hours it is held until they end
 * (`messageHoursSendAfter`), as the club's other held messages are.
 *
 * The claim and the post are written in ONE transaction: a second tap, a
 * double tap or another organiser at the same moment loses on the
 * `SentNotification` key and writes nothing. No players' group (or the bot
 * off for it) claims nothing, so the club can send it once it has one.
 *
 * Callers check the person is an owner or admin of the club first
 * (`app/actions/pool-club-share.ts`).
 */
import { db } from "../db";
import { historyDateLabel, longDayTimeLabel } from "../i18n/dates";
import { normaliseLang, type Lang } from "../i18n/lang";
import { QUIET_HOURS_SELECT, messageHoursSendAfter, quietHoursOf } from "../message-hours";
import { ensureClubPoolCampaign } from "./campaigns";
import { CLUB_SHARE_KIND, clubShareKey, clubSharePostText, clubShareShown, clubShareView } from "./club-share-rules";

const ORG_SELECT = {
  id: true,
  name: true,
  slug: true,
  language: true,
  featurePlayerPool: true,
  whatsappGroupId: true,
  whatsappBotEnabled: true,
  ...QUIET_HOURS_SELECT,
} as const;

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === "P2002";
const hasGroup = (org: { whatsappGroupId: string | null; whatsappBotEnabled: boolean }) => !!org.whatsappGroupId && org.whatsappBotEnabled;

export interface ClubShareCard {
  kind: "ready" | "no-group" | "sent";
  /** The exact post, in the club's language. */
  text: string;
  url: string;
  language: Lang;
  /** The day it was sent, in the club's language; null until then. */
  sentOn: string | null;
}

/** Null: no card for this club (the pool is off for it). */
export async function loadClubShare(orgId: string, env: Record<string, string | undefined>): Promise<ClubShareCard | null> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: ORG_SELECT });
  if (!org || !clubShareShown(org, env)) return null;
  const claim = await db.sentNotification.findUnique({ where: { key: clubShareKey(orgId) }, select: { createdAt: true } });
  const view = clubShareView({ shown: true, hasGroup: hasGroup(org), sentAt: claim?.createdAt ?? null });
  if (view.kind === "hidden") return null;
  const url = await ensureClubPoolCampaign(org);
  if (!url) return null;
  const language = normaliseLang(org.language);
  return {
    kind: view.kind,
    text: clubSharePostText(language, url),
    url,
    language,
    sentOn: view.kind === "sent" ? historyDateLabel(language, view.sentAt) : null,
  };
}

export type SendClubShareResult =
  | { ok: true; sendAfter: Date | null }
  | { ok: false; reason: "not-shown" | "no-group" | "already-sent" | "no-code" };

export async function sendClubShare(orgId: string, now: Date, env: Record<string, string | undefined>): Promise<SendClubShareResult> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: ORG_SELECT });
  if (!org || !clubShareShown(org, env)) return { ok: false, reason: "not-shown" };
  if (!hasGroup(org)) return { ok: false, reason: "no-group" };
  const key = clubShareKey(orgId);
  if (await db.sentNotification.findUnique({ where: { key }, select: { createdAt: true } })) return { ok: false, reason: "already-sent" };

  const url = await ensureClubPoolCampaign(org);
  if (!url) return { ok: false, reason: "no-code" };
  const text = clubSharePostText(org.language, url);
  const sendAfter = messageHoursSendAfter(now, quietHoursOf(org));
  try {
    await db.$transaction(async (tx) => {
      await tx.sentNotification.create({ data: { key, kind: CLUB_SHARE_KIND } });
      await tx.botJob.create({ data: { orgId, kind: "group", text, sendAfter } });
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "already-sent" };
    throw err;
  }
  console.log(`[pool-club-share] queued org=${orgId} sendAfter=${sendAfter?.toISOString() ?? "now"}`);
  return { ok: true, sendAfter };
}

/** The held time for the organiser's toast, in the club's language. */
export function clubShareHeldLabel(lang: Lang | string | null | undefined, sendAfter: Date): string {
  return longDayTimeLabel(lang, sendAfter);
}
