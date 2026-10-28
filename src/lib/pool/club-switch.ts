/**
 * A CLUB'S OWN PLAYER POOL SWITCH (2026-10-27; the club's own since
 * 2026-10-28, decision log P.2). The one writer of
 * `Organisation.featurePlayerPool`, used by the "Player pool" card on the
 * club's /admin/settings (`app/actions/pool-club-switch.ts`, owners and
 * admins, only while the platform switch is on).
 *
 * ON: the club's admins see Style of play, "Ask the player pool
 * automatically" and "Tell your players about the player pool" in settings,
 * and the pool tick on the match page; organisers can ask the pool from HQ
 * (`flags.ts` `poolOpenForClub`: the platform switch AND this flag). Nothing
 * is offered by switching on. The FIRST time a club's pool goes from off
 * to on, its admin team is told once, ever (`club-switch-rules.ts`): one
 * message in HQ, or a DM to each owner and admin when it has none.
 *
 * OFF: the flag is written first, so no new ask can open, then every open
 * pool ask of the club is closed at once through the pool's own close path
 * (`round.ts` `closePoolAsk`, reason "switched-off", the sweep's own): its
 * open offers end and the unsent ones' queued DMs are cancelled. Nobody is
 * messaged.
 *
 * `poolAutoAsk` is never touched: while the flag is off it is ignored
 * (`auto-ask-rules.ts` `poolAutoAskApplies` needs poolOpen), and the
 * club's own choice is still there if the pool is switched on again.
 */
import { db } from "../db";
import { loadAdminChannel } from "../admin-channel";
import { adminNoticeSendAfter } from "../rolling-squad-rules";
import { poolClubSwitchCopy } from "../i18n/pool-club-switch";
import { closePoolAsk } from "./round";
import { POOL_ON_NOTICE_KIND, poolOnNoticeKey, poolOnNoticeTarget } from "./club-switch-rules";

export type ClubPoolSwitchResult = { ok: true; on: boolean; closedAsks: number; autoAsk: boolean; told: boolean } | { ok: false; reason: "not-found" };

export async function setClubPlayerPool(orgId: string, on: boolean, now: Date = new Date()): Promise<ClubPoolSwitchResult> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { id: true, poolAutoAsk: true } });
  if (!org) return { ok: false, reason: "not-found" };
  const autoAsk = org.poolAutoAsk === true;
  if (on) {
    // Compare-and-set: only the write that really turned it on tells anyone.
    const { count } = await db.organisation.updateMany({ where: { id: orgId, featurePlayerPool: false }, data: { featurePlayerPool: true } });
    let told = false;
    if (count === 1) {
      try {
        told = await tellAdminTeamPoolOn(orgId, now);
      } catch (err) {
        console.error(`[pool] club ${orgId}: the pool-on message could not be queued: ${(err as Error)?.message ?? "error"}`);
      }
    }
    return { ok: true, on, closedAsks: 0, autoAsk, told };
  }

  await db.organisation.update({ where: { id: orgId }, data: { featurePlayerPool: false } });
  const open = await db.poolAsk.findMany({ where: { orgId, status: "open" }, select: { id: true } });
  let closedAsks = 0;
  for (const a of open) if (await closePoolAsk(a.id, "switched-off", now)) closedAsks++;
  if (open.length > 0) console.log(`[pool] club ${orgId} switched the pool off: ${closedAsks} open ask(s) closed`);
  return { ok: true, on, closedAsks, autoAsk, told: false };
}

/**
 * The once-ever message to the club's admin team that the pool is on.
 * True when it was queued now. Inside the club's quiet hours it waits
 * until they end (the admin channel's own rule).
 */
export async function tellAdminTeamPoolOn(orgId: string, now: Date): Promise<boolean> {
  const key = poolOnNoticeKey(orgId);
  if (await db.sentNotification.findUnique({ where: { key }, select: { id: true } })) return false;
  const ch = await loadAdminChannel(orgId);
  if (!ch) return false;
  const target = poolOnNoticeTarget({ mode: ch.cfg.mode, adminGroupId: ch.cfg.adminGroupId, adminGroupPostable: ch.adminGroupPostable }, ch.admins);
  if (target.to === "none") {
    console.warn(`[pool] club ${orgId}: no admin to tell that the pool is on`);
    return false;
  }
  const copy = poolClubSwitchCopy(ch.language);
  const sendAfter = adminNoticeSendAfter(now, ch.quietHours);
  const queued = await db.$transaction(async (tx) => {
    const { count } = await tx.sentNotification.createMany({ data: [{ key, kind: POOL_ON_NOTICE_KIND }], skipDuplicates: true });
    if (count !== 1) return false;
    if (target.to === "group") {
      await tx.botJob.create({ data: { orgId, kind: "admin-group", text: copy.notice(ch.orgName, "group"), ...(sendAfter ? { sendAfter } : {}) } });
    } else {
      const text = copy.notice(ch.orgName, "dm");
      for (const u of target.users) await tx.botJob.create({ data: { orgId, kind: "dm", phone: u.phone, text, ...(sendAfter ? { sendAfter } : {}) } });
    }
    return true;
  });
  if (queued) console.log(`[pool] club ${orgId}: told its admin team the pool is on (${target.to}) sendAfter=${sendAfter?.toISOString() ?? "now"}`);
  return queued;
}
