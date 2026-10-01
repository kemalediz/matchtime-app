/**
 * TELL A CLUB'S ADMINS, ONCE A DAY, THAT IT HAS REACHED ITS AI ALLOWANCE
 * (Kemal, 2026-10-01).
 *
 * Until today a cap hit was recorded and nobody was told, so an organiser
 * whose group suddenly stopped getting answers had no way to know why.
 * Now the club's admins get ONE message per club per London day, through
 * the club's own admin channel (`sendAdminNotice`: one person, the admin
 * group, or each admin). Never the platform owner: his record stays the
 * info event on /admin/health (`ai-budget.ts`, `noteFirstCapToday`).
 *
 * WHERE IT IS ASKED FOR. Both places the cap trips, in `ai-budget.ts`:
 * a refused reservation (`recordRefusal`, any guarded call site: analyze,
 * dm-reply, the scheduler's chase composer, team generation) and group
 * messages left unhandled at the cap (`recordCapSkips`, the analyze
 * route's up-front decision). Neither asks for a club allowed $0.
 *
 * ONCE, UNDER CONCURRENCY. The claim is a `SentNotification` row keyed
 * `<orgId>:ai-cap:<YYYY-MM-DD>` (London day). Its unique index is the
 * lock: of any number of refusals racing in one flush, or two flushes
 * racing each other, exactly one `create` succeeds and only that caller
 * queues the notice. A cheap `findUnique` first keeps the common "already
 * sent today" case free of a failed insert. If queueing fails the claim is
 * released, so a later trip the same day can try again. No schema change.
 *
 * WHO IS NEVER TOLD. A club that is not approved, is dormant, is muted
 * (`whatsappBotEnabled` false) or has no linked group. Those spend $0
 * anyway, and a BotJob queued for a muted club would go out the moment it
 * is unmuted, about a day that is long over.
 *
 * NOT FROM 22:00 LONDON. `sendAdminNotice` holds a notice queued between
 * 22:00 and 07:59 until 08:00. Before midnight that 08:00 is TOMORROW, by
 * when the allowance has reset and the message would be false. So from
 * 22:00 nothing is queued or claimed; the cap is under two hours from its
 * reset. Between 00:00 and 07:59 the notice is held to 08:00 the same day,
 * which is still true.
 *
 * NO MODEL. The text is a fixed string from the i18n table.
 */
import { db } from "./db";
import { formatLondon } from "./london-time";
import { sendAdminNotice } from "./admin-channel";
import { isClubOperational } from "./club-approval-state";
import { t } from "./i18n/t";

/** The SentNotification kind for the claim row. */
export const AI_CAP_NOTICE_KIND = "ai-cap-notice";

/** From this London hour on, no notice: it would only arrive tomorrow. */
const NOTICE_LAST_HOUR_EXCLUSIVE = 22;

/** The once-a-day claim key, on London's calendar day. */
export function aiCapNoticeKey(orgId: string, now: Date): string {
  return `${orgId}:ai-cap:${formatLondon(now, "yyyy-MM-dd")}`;
}

/** True from 22:00 to 23:59 London. */
export function aiCapNoticeTooLate(now: Date): boolean {
  return Number(formatLondon(now, "H")) >= NOTICE_LAST_HOUR_EXCLUSIVE;
}

/**
 * The notice text. `buyMoreUrl` is for the planned AI top-ups (see
 * MDs/club-fee-billing-plan-2026-10-01.md, "AI top-ups (planned)"): when
 * it exists, the Buy more line replaces the contact line, nothing else
 * changes.
 */
export function buildAiCapAdminNotice(args: {
  clubName: string;
  lang: string | null | undefined;
  buyMoreUrl?: string | null;
}): string {
  const s = t(args.lang);
  const more = args.buyMoreUrl ? s.ai_cap_more_buy({ url: args.buyMoreUrl }) : s.ai_cap_more_contact;
  return s.ai_cap_admin_notice({ club: args.clubName, more });
}

export type AiCapNoticeResult = "sent" | "already" | "skipped" | "failed";

/**
 * Queue today's notice for this club, if it is due and nobody has yet.
 * Never throws.
 */
export async function notifyAdminsOfAiCap(orgId: string, now: Date = new Date()): Promise<AiCapNoticeResult> {
  const key = aiCapNoticeKey(orgId, now);
  try {
    if (aiCapNoticeTooLate(now)) return "skipped";
    if (await db.sentNotification.findUnique({ where: { key }, select: { id: true } })) return "already";

    const org = await db.organisation.findUnique({
      where: { id: orgId },
      select: {
        name: true,
        language: true,
        approvalStatus: true,
        dormantAt: true,
        billingStatus: true,
        whatsappBotEnabled: true,
        whatsappGroupId: true,
      },
    });
    if (!org || !isClubOperational(org) || !org.whatsappBotEnabled || !org.whatsappGroupId) return "skipped";

    try {
      await db.sentNotification.create({ data: { key, kind: AI_CAP_NOTICE_KIND } });
    } catch {
      return "already"; // another refusal in this flush, or another flush, won the claim
    }

    try {
      await sendAdminNotice({ orgId, now, text: buildAiCapAdminNotice({ clubName: org.name, lang: org.language }) });
      console.log(`[ai-cap-notice] org ${orgId}: today's AI cap notice queued for the club's admins`);
      return "sent";
    } catch (err) {
      console.error(`[ai-cap-notice] org ${orgId}: notice not queued, claim released:`, err);
      await db.sentNotification.deleteMany({ where: { key } }).catch(() => {});
      return "failed";
    }
  } catch (err) {
    console.error(`[ai-cap-notice] org ${orgId}: could not check or claim today's notice:`, err);
    return "failed";
  }
}
