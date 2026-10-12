/**
 * THE ADMIN GROUP LINK COMMAND, AS THE ROUTE RUNS IT (go-live slice S7,
 * 2026-10-12; owner decision 10). `linkAdminGroup` (admin-group-link.ts)
 * decides; this adds the one thing it cannot say in a group.
 *
 * The setup DM of a club that is setting up offers an optional step: add
 * MatchTime to the organisers' own WhatsApp group and send "Match Time
 * admin group <CODE>" there. Two places it can land:
 *
 *   A SEPARATE GROUP   the link is made exactly as for any club, and the
 *       confirmation is posted in THAT group. That is fine: it is the
 *       organisers' own group, not the players'.
 *   THE CLUB'S OWN PLAYERS' GROUP (by mistake)   MatchTime says nothing
 *       there while the club is setting up: `linkAdminGroup` answers
 *       "ignored" with no reply text. So the organiser is told by DM, on
 *       the platform channel (purpose "setup-reply": the club's own
 *       channel is off until GO):
 *         "That is your players' group, so it can't be the admin group.
 *          Add me to a separate group for the admins and send the message
 *          there."
 *
 * That DM is ONE per WhatsApp message (the Pi may forward a message
 * twice: a claim key per message id) and counts against the same cap as
 * every other reply to the organiser of a setting-up club
 * (`setupReplyCapReached`, setup-go-dm.ts): the Pi sends one DM a minute
 * for the whole platform. Over the cap: silence. It goes at once, at any
 * hour: it answers something the organiser has just done.
 *
 * Telling them never fails the command: an error is logged and the route
 * still answers the Pi with "ignored" and no reply text.
 *
 * NO MODEL anywhere on this path (`admin-group-no-model.source.test.ts`
 * follows every import of the route). LOGS carry ids and reason codes
 * only.
 */
import { db } from "./db";
import { linkAdminGroup, type AdminGroupLinkInput, type AdminGroupLinkResult } from "./admin-group-link";
import { t } from "./i18n/t";
import { normalisePhone } from "./phone";
import { PlatformDmRefused, queuePlatformDm } from "./platform-jobs";
import { SETUP_REPLY_PURPOSE, setupReplyCapReached } from "./setup-go-dm";

const CLAIM_KIND = "setup-admin-link";
const claimKey = (messageId: string) => `setup-admin-link-msg:${messageId}`;

export type PlayersGroupNoticeOutcome = "queued" | "duplicate" | "capped" | "no-number" | "refused" | "failed";

/** Tell the organiser, by DM, that the command went to the players' group. */
async function tellPlayersGroup(args: {
  orgId: string;
  userId: string;
  language: string;
  messageId: string | null;
  now: Date;
}): Promise<PlayersGroupNoticeOutcome> {
  const key = args.messageId ? claimKey(args.messageId) : null;
  try {
    if (key) {
      const claimed = await db.sentNotification.createMany({ data: [{ key, kind: CLAIM_KIND }], skipDuplicates: true });
      if (claimed.count !== 1) return "duplicate";
    }
    const account = await db.user.findUnique({ where: { id: args.userId }, select: { phoneNumber: true } });
    const phone = account?.phoneNumber ? normalisePhone(account.phoneNumber) : null;
    if (!phone) return "no-number";
    if (await setupReplyCapReached(phone, args.now)) return "capped";
    await queuePlatformDm({
      phone,
      text: t(args.language).sj_admin_group_players_group,
      purpose: SETUP_REPLY_PURPOSE,
      refId: `${args.orgId}:admin-link-players-group${args.messageId ? `:${args.messageId}` : ""}`,
    });
    return "queued";
  } catch (err) {
    if (err instanceof PlatformDmRefused) return "refused";
    // Not told: give the claim back, so the Pi's retry of this message is
    // a real retry.
    if (key) await db.sentNotification.deleteMany({ where: { key } }).catch(() => {});
    console.error(`[admin-group-link] ${args.orgId}: players' group notice not queued: ${(err as Error)?.name ?? "error"}`);
    return "failed";
  }
}

/**
 * Run the link command the Pi forwarded. The answer is `linkAdminGroup`'s,
 * minus the field only this module needs.
 */
export async function handleAdminGroupLinkCommand(
  input: AdminGroupLinkInput & { messageId?: string | null },
): Promise<AdminGroupLinkResult> {
  const result = await linkAdminGroup(input);
  if (result.outcome !== "ignored" || !result.settingUpPlayersGroup) return result;
  const told = await tellPlayersGroup({
    ...result.settingUpPlayersGroup,
    messageId: typeof input.messageId === "string" && input.messageId.trim() ? input.messageId.trim() : null,
    now: input.now ?? new Date(),
  });
  console.log(`[admin-group-link] ${result.settingUpPlayersGroup.orgId}: command in the players' group of a club setting up; organiser DM ${told}`);
  return { outcome: "ignored", replyText: null, reason: result.reason };
}
