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
 * to on, its admin team is told once, ever (`club-switch-rules.ts`),
 * through the club's own admin channel (`sendAdminNotice`).
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
import { sendAdminNotice, type AdminNoticeClient } from "../admin-channel";
import { poolClubSwitchCopy } from "../i18n/pool-club-switch";
import { closePoolAsk } from "./round";
import { POOL_ON_NOTICE_KIND, poolOnNoticeKey } from "./club-switch-rules";

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

/** Rolls the claim back when the club's channel queued nothing. */
class NobodyToTell extends Error {}

/**
 * The once-ever message to the club's admin team that the pool is on,
 * through the club's admin channel (`sendAdminNotice`: its admin group, the
 * one person it chose, or each admin, as the club set it), never the
 * players' group. The claim and the jobs are ONE transaction; nobody to
 * tell rolls the claim back so a later switch-on can still tell them.
 * Held through the club's quiet hours (the admin channel's own rule). An
 * admin-group post that falls back to a DM at dispatch uses the DM wording.
 * True when it was queued now.
 */
export async function tellAdminTeamPoolOn(orgId: string, now: Date): Promise<boolean> {
  const key = poolOnNoticeKey(orgId);
  if (await db.sentNotification.findUnique({ where: { key }, select: { id: true } })) return false;
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { name: true, language: true } });
  if (!org) return false;
  const copy = poolClubSwitchCopy(org.language);
  try {
    const queued = await db.$transaction(async (tx) => {
      const { count } = await tx.sentNotification.createMany({ data: [{ key, kind: POOL_ON_NOTICE_KIND }], skipDuplicates: true });
      if (count !== 1) return false;
      const r = await sendAdminNotice({
        orgId,
        now,
        text: (_link, audience) => copy.notice(org.name, audience === "group" ? "group" : "dm"),
        dmWording: true,
        client: tx as unknown as AdminNoticeClient,
      });
      if (r.queued === 0) throw new NobodyToTell();
      console.log(`[pool] club ${orgId}: told its admin team the pool is on (${r.channel}, ${r.queued} job(s))`);
      return true;
    });
    return queued;
  } catch (err) {
    if (err instanceof NobodyToTell) {
      console.warn(`[pool] club ${orgId}: no admin to tell that the pool is on`);
      return false;
    }
    throw err;
  }
}
