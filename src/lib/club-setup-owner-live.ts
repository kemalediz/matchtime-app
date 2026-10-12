/**
 * TELLING THE ORGANISER THAT THE MATCHTIME TEAM TOOK THEIR CLUB LIVE
 * (setup-hold switch-on fixes, 2026-10-13).
 *
 * The MatchTime owner's "Go live now" on /admin/clubs takes a club that is
 * stuck in setting up live. Until now the organiser was told nothing: the
 * hello appeared in their group, their free period started, a setup DM
 * still waiting for 09:00 was cancelled (`goLiveClub`), and somebody who
 * had just been answered "I'm still reading..." heard nothing more.
 *
 * `tellOrganiserOwnerWentLive` queues ONE DM for that, after the go-live
 * has committed:
 *
 *   WHO    the organiser who connected the club: the phone on its closed
 *          connect request, the same recipient as the setup DM and the
 *          reminder (club-setup-dm.ts).
 *   WHAT   that the MatchTime team started MatchTime in the group and it
 *          is introducing itself there; then, when a free period started
 *          with this go-live, the free period sentence and the club fee
 *          tip, WORD FOR WORD the note the writer returned
 *          (`GoLiveResult.freePeriodNote`: it is not rebuilt here); then
 *          the settings link, signed in for that organiser.
 *   HOURS  09:00 to 23:00 London (`messageHoursSendAfter`): nobody asked
 *          for this message, so it is not sent at night.
 *   ONCE   per club. A club goes live once, and the caller calls this only
 *          for the call that took it live; a job with this purpose and the
 *          club's refId already there is the second lock.
 *
 * Never throws: the club is live whatever happens here. What could not be
 * sent is logged with the club's id and a code only: never a name, a
 * number, the text or a link.
 */
import { db } from "./db";
import { appUrl, buildAdminLink } from "./admin-link";
import type { GoLiveResult } from "./club-setup";
import { t } from "./i18n/t";
import { messageHoursSendAfter } from "./message-hours";
import { PlatformDmRefused, queuePlatformDm } from "./platform-jobs";

/** The platform purpose of this DM. */
export const SETUP_OWNER_LIVE_DM_PURPOSE = "setup-owner-live" as const;
/** One refId per club: the once-per-club check. */
export const setupOwnerLiveRefId = (orgId: string): string => `${orgId}:setup-owner-live`;

/** The signed-in settings link works for a week, like the setup DM's. */
const LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

export type OwnerLiveDmOutcome = "queued" | "already" | "no-organiser" | "refused" | "failed";

/** The DM's words. Pure. `freePeriodNote` is the writer's own note, or null. */
export function composeOwnerLiveDm(p: {
  lang: string;
  group: string;
  freePeriodNote: string | null;
  settingsUrl: string;
}): string {
  const s = t(p.lang);
  const blocks = [s.sj_go_owner_started({ group: p.group })];
  if (p.freePeriodNote) blocks.push(p.freePeriodNote);
  blocks.push(s.sj_dm_ready_settings({ url: p.settingsUrl }));
  return blocks.join("\n\n");
}

/** See the file comment. `live` is the go-live result that took the club live. */
export async function tellOrganiserOwnerWentLive(
  live: Extract<GoLiveResult, { outcome: "went-live" }>,
  now: Date = new Date(),
): Promise<OwnerLiveDmOutcome> {
  const orgId = live.orgId;
  try {
    const refId = setupOwnerLiveRefId(orgId);
    const already = await db.platformJob.findFirst({
      where: { purpose: SETUP_OWNER_LIVE_DM_PURPOSE, refId },
      select: { id: true },
    });
    if (already) return "already";

    const connect = await db.clubConnect.findFirst({
      where: { orgId, status: "closed", linkedAt: { not: null } },
      orderBy: { linkedAt: "desc" },
      select: { userId: true, phone: true },
    });
    if (!connect) {
      console.error(`[club-setup-owner-live] ${orgId}: taken live by the MatchTime team, but there is no organiser on record to tell`);
      return "no-organiser";
    }

    let settingsUrl = appUrl("/admin/settings");
    try {
      settingsUrl = await buildAdminLink({ userId: connect.userId, orgId, nextPath: "/admin/settings", ttlSeconds: LINK_TTL_SECONDS });
    } catch {
      console.error(`[club-setup-owner-live] ${orgId}: a signed-in link could not be made; sending the plain address`);
    }

    await queuePlatformDm({
      phone: connect.phone,
      text: composeOwnerLiveDm({ lang: live.language, group: live.group, freePeriodNote: live.freePeriodNote, settingsUrl }),
      purpose: SETUP_OWNER_LIVE_DM_PURPOSE,
      refId,
      sendAfter: messageHoursSendAfter(now),
    });
    console.log(`[club-setup-owner-live] ${orgId}: the organiser's "the MatchTime team started it" DM is queued`);
    return "queued";
  } catch (err) {
    if (err instanceof PlatformDmRefused) {
      console.error(`[club-setup-owner-live] ${orgId}: the organiser was NOT told (${err.code})`);
      return "refused";
    }
    console.error(`[club-setup-owner-live] ${orgId}: the organiser was NOT told: ${(err as Error)?.name ?? "error"}`);
    return "failed";
  }
}
