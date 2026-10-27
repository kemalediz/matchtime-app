/**
 * THE PLATFORM OWNER'S PER-CLUB PLAYER POOL SWITCH (2026-10-27). The one
 * writer of `Organisation.featurePlayerPool`, used by the "Player pool"
 * switch on /admin/clubs (`app/actions/pool-club-switch.ts`). It is not a
 * club admin's feature (`app/actions/org.ts` FEATURE_COLUMN leaves it out).
 *
 * ON: the club's admins see Style of play and "Ask the player pool
 * automatically" in settings, and the pool tick on the match page;
 * organisers can ask the pool from HQ while POOL_OFFERS_ENABLED is on too
 * (`flags.ts` `poolOffersOpenForClub`). Nothing is sent by switching on.
 *
 * OFF: the flag is written first, so no new ask can open, then every open
 * pool ask of the club is closed at once through the pool's own close path
 * (`round.ts` `closePoolAsk`, reason "switched-off", the sweep's own): its
 * open offers end and the unsent ones' queued DMs are cancelled. The sweep
 * (`sweepPool`) and dispatch (`dispatch-rules.ts`, clubOpen) would do the
 * same on their next pass; closing here leaves nothing half open between.
 * Nobody is messaged.
 *
 * `poolAutoAsk` is never touched: while the flag is off it is ignored
 * (`auto-ask-rules.ts` `poolAutoAskApplies` needs poolOpen), and the
 * club's own choice is still there if the pool is switched on again.
 */
import { db } from "../db";
import { closePoolAsk } from "./round";

export type ClubPoolSwitchResult = { ok: true; on: boolean; closedAsks: number; autoAsk: boolean } | { ok: false; reason: "not-found" };

export async function setClubPlayerPool(orgId: string, on: boolean, now: Date = new Date()): Promise<ClubPoolSwitchResult> {
  const org = await db.organisation.findUnique({ where: { id: orgId }, select: { id: true, poolAutoAsk: true } });
  if (!org) return { ok: false, reason: "not-found" };
  await db.organisation.update({ where: { id: orgId }, data: { featurePlayerPool: on } });
  const autoAsk = org.poolAutoAsk === true;
  if (on) return { ok: true, on, closedAsks: 0, autoAsk };

  const open = await db.poolAsk.findMany({ where: { orgId, status: "open" }, select: { id: true } });
  let closedAsks = 0;
  for (const a of open) if (await closePoolAsk(a.id, "switched-off", now)) closedAsks++;
  if (open.length > 0) console.log(`[pool] club ${orgId} switched off by the owner: ${closedAsks} open ask(s) closed`);
  return { ok: true, on, closedAsks, autoAsk };
}
